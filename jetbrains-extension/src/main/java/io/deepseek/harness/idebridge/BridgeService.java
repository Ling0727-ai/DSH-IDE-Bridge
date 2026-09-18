package io.deepseek.harness.idebridge;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.codeInsight.TargetElementUtil;
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl;
import com.intellij.codeInsight.daemon.impl.HighlightInfo;
import com.intellij.lang.annotation.HighlightSeverity;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.command.WriteCommandAction;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.intellij.openapi.roots.ProjectFileIndex;
import com.intellij.openapi.util.Computable;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.PsiDocumentManager;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.PsiNamedElement;
import com.intellij.psi.PsiReference;
import com.intellij.psi.PsiManager;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.psi.search.searches.DefinitionsScopedSearch;
import com.intellij.psi.search.searches.ReferencesSearch;
import com.intellij.psi.util.PsiTreeUtil;
import com.intellij.refactoring.rename.RenameProcessor;
import org.jetbrains.annotations.NotNull;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@Service(Service.Level.APP)
public final class BridgeService implements Disposable {
    private static final Logger LOG = Logger.getInstance(BridgeService.class);
    private static final Gson GSON = new Gson();
    private static final int MAX_REQUEST_CHARS = 1_048_576;
    private static final int HEARTBEAT_SECONDS = 5;

    private final AtomicBoolean started = new AtomicBoolean(false);
    private final ExecutorService serverThread = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "dsh-ide-bridge-server");
        thread.setDaemon(true);
        return thread;
    });
    private final ThreadPoolExecutor clients = new ThreadPoolExecutor(
            2, 8, 60, TimeUnit.SECONDS, new ArrayBlockingQueue<>(32), runnable -> {
        Thread thread = new Thread(runnable, "dsh-ide-bridge-client");
        thread.setDaemon(true);
        return thread;
    }, new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "dsh-ide-bridge-heartbeat");
        thread.setDaemon(true);
        return thread;
    });
    private final String token = randomToken();
    private final Instant startedAt = Instant.now();

    private volatile ServerSocket server;
    private volatile Path discoveryFile;

    public void ensureStarted() {
        if (!started.compareAndSet(false, true)) return;
        serverThread.submit(this::serve);
    }

    private void serve() {
        try {
            ServerSocket value = new ServerSocket();
            value.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), configuredPort()));
            server = value;
            writeDiscovery();
            heartbeat.scheduleAtFixedRate(this::writeDiscoverySafely, HEARTBEAT_SECONDS, HEARTBEAT_SECONDS, TimeUnit.SECONDS);
            while (!value.isClosed()) {
                Socket socket = value.accept();
                socket.setSoTimeout(15_000);
                try {
                    clients.execute(() -> handleSocket(socket));
                } catch (RejectedExecutionException rejected) {
                    socket.close();
                }
            }
        } catch (IOException error) {
            if (server == null || !server.isClosed()) LOG.error("DSH IDE Bridge failed", error);
        }
    }

    private void handleSocket(Socket socket) {
        try (socket;
             BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
             BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8))) {
            try {
                String raw = readLineLimited(reader);
                JsonObject request = GSON.fromJson(raw, JsonObject.class);
                Object result = dispatchAuthenticated(request);
                writeResponse(writer, request.has("id") ? request.get("id") : null, result);
            } catch (BridgeException error) {
                writeError(writer, error.requestId, error);
            } catch (Exception error) {
                LOG.warn("DSH IDE Bridge request failed", error);
                writeError(writer, null, new BridgeException("IDE_REQUEST_FAILED", error.getMessage(), null, error));
            }
        } catch (IOException error) {
            LOG.debug("DSH IDE Bridge client disconnected", error);
        }
    }

    private Object dispatchAuthenticated(JsonObject request) {
        JsonElement id = request.get("id");
        String candidate = string(request, "token", null);
        if (!tokenMatches(candidate)) throw new BridgeException("IDE_UNAUTHORIZED", "Invalid bridge token.", id);
        String method = string(request, "method", null);
        if (method == null) throw new BridgeException("IDE_INVALID_REQUEST", "A method is required.", id);
        JsonObject params = request.has("params") && request.get("params").isJsonObject()
                ? request.getAsJsonObject("params") : new JsonObject();
        try {
            return dispatch(method, params);
        } catch (BridgeException error) {
            error.requestId = id;
            throw error;
        }
    }

    private Object dispatch(String method, JsonObject params) {
        return switch (method) {
            case "status" -> status();
            case "context" -> context(params);
            case "open" -> open(params);
            case "diagnostics" -> diagnostics(params);
            case "symbols" -> symbols(params);
            case "edit" -> edit(params);
            case "rename" -> rename(params);
            case "command" -> command(params);
            default -> throw fail("IDE_METHOD_NOT_FOUND", "Unknown IDE method: " + method);
        };
    }

    private Object status() {
        return onEdt(() -> {
            Project project = activeProject(null);
            Map<String, Object> result = baseStatus();
            result.put("activeEditor", project == null ? null : editorSummary(FileEditorManager.getInstance(project).getSelectedTextEditor(), project));
            return result;
        });
    }

    private Object context(JsonObject params) {
        return onEdt(() -> {
            Project project = activeProject(null);
            if (project == null) return noActiveEditor();
            Editor editor = FileEditorManager.getInstance(project).getSelectedTextEditor();
            if (editor == null) return noActiveEditor();
            Map<String, Object> result = editorSummary(editor, project);
            result.put("selectedText", editor.getSelectionModel().getSelectedText());
            result.put("selection", range(editor.getDocument(), editor.getSelectionModel().getSelectionStart(), editor.getSelectionModel().getSelectionEnd()));
            if (bool(params, "includeText", false)) {
                int maxChars = boundedInt(params, "maxChars", 2000, 1, 50000);
                Document document = editor.getDocument();
                int center = editor.getCaretModel().getOffset();
                int start = Math.max(0, center - maxChars / 2);
                int end = Math.min(document.getTextLength(), start + maxChars);
                result.put("nearbyText", Map.of("range", range(document, start, end), "text", document.getText(new TextRange(start, end))));
            }
            return result;
        });
    }

    private Object open(JsonObject params) {
        ResolvedFile resolved = resolveFile(requiredString(params, "path"));
        int line = intValue(params, "line", 1);
        int column = intValue(params, "column", 1);
        return onEdt(() -> {
            OpenFileDescriptor descriptor = new OpenFileDescriptor(resolved.project, resolved.file, Math.max(0, line - 1), Math.max(0, column - 1));
            Editor editor = FileEditorManager.getInstance(resolved.project).openTextEditor(descriptor, !bool(params, "preserveFocus", false));
            if (editor == null) throw fail("IDE_OPEN_FAILED", "The IDE could not open the file.");
            return editorSummary(editor, resolved.project);
        });
    }

    private Object diagnostics(JsonObject params) {
        List<ResolvedFile> files = params.has("path")
                ? List.of(resolveFile(requiredString(params, "path")))
                : openFiles();
        int limit = boundedInt(params, "limit", 100, 1, 1000);
        int threshold = severityRank(string(params, "severity", "warning"));
        return ReadAction.compute(() -> {
            List<Map<String, Object>> items = new ArrayList<>();
            for (ResolvedFile resolved : files) {
                Document document = FileDocumentManager.getInstance().getDocument(resolved.file);
                if (document == null) continue;
                Collection<HighlightInfo> highlights = DaemonCodeAnalyzerImpl.getHighlights(
                        document, HighlightSeverity.INFORMATION, resolved.project);
                for (HighlightInfo info : highlights) {
                    if (severityRank(info.getSeverity()) > threshold) continue;
                    String message = info.getDescription();
                    if (message == null || message.isBlank()) continue;
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("path", displayPath(resolved.project, resolved.file));
                    item.put("severity", severityName(info.getSeverity()));
                    item.put("message", message);
                    item.put("range", range(document, info.getStartOffset(), info.getEndOffset()));
                    items.add(item);
                    if (items.size() >= limit) return Map.of("diagnostics", items, "truncated", true);
                }
            }
            return Map.of("diagnostics", items, "truncated", false);
        });
    }

    private List<ResolvedFile> openFiles() {
        return onEdt(() -> {
            List<ResolvedFile> result = new ArrayList<>();
            for (Project project : ProjectManager.getInstance().getOpenProjects()) {
                if (project.isDisposed()) continue;
                for (VirtualFile file : FileEditorManager.getInstance(project).getOpenFiles()) {
                    result.add(new ResolvedFile(project, file));
                }
            }
            return result;
        });
    }

    private Object symbols(JsonObject params) {
        String operation = requiredString(params, "operation");
        int limit = boundedInt(params, "limit", 50, 1, 1000);
        boolean includeLowValue = bool(params, "includeLowValue", false);
        if ("workspaceSymbols".equals(operation)) return workspaceSymbols(params, limit, includeLowValue);

        ResolvedFile resolved = resolveFile(requiredString(params, "path"));
        return switch (operation) {
            case "documentSymbols" -> documentSymbols(resolved, limit, includeLowValue);
            case "definition" -> targetLocations(resolved, params, "definition", limit);
            case "references" -> referenceLocations(resolved, params, limit);
            case "implementations" -> implementationLocations(resolved, params, limit);
            case "hover" -> throw fail("IDE_OPERATION_UNSUPPORTED", "JetBrains hover rendering is not exposed by this bridge; use definition or context instead.");
            default -> throw fail("IDE_INVALID_REQUEST", "Unsupported symbol operation: " + operation);
        };
    }

    private Object documentSymbols(ResolvedFile resolved, int limit, boolean includeLowValue) {
        return ReadAction.compute(() -> {
            PsiFile file = PsiManager.getInstance(resolved.project).findFile(resolved.file);
            Document document = FileDocumentManager.getInstance().getDocument(resolved.file);
            if (file == null || document == null) return Map.of("symbols", List.of(), "truncated", false);
            List<Map<String, Object>> result = new ArrayList<>();
            for (PsiNamedElement element : PsiTreeUtil.findChildrenOfType(file, PsiNamedElement.class)) {
                if (element.getName() == null || element.getTextRange() == null) continue;
                if (!includeLowValue && isLowValueSymbol(element)) continue;
                result.add(symbolMap(element, document, resolved.project, resolved.file));
                if (result.size() >= limit) return Map.of("symbols", result, "truncated", true);
            }
            return Map.of("symbols", result, "truncated", false);
        });
    }

    private Object workspaceSymbols(JsonObject params, int limit, boolean includeLowValue) {
        String query = requiredString(params, "query").toLowerCase(Locale.ROOT);
        Project project = activeProject(null);
        if (project == null) throw fail("IDE_WORKSPACE_REQUIRED", "No JetBrains project is open.");
        return ReadAction.compute(() -> {
            List<Map<String, Object>> matches = new ArrayList<>();
            ProjectFileIndex.getInstance(project).iterateContent(file -> {
                if (file.isDirectory() || file.getFileType().isBinary()) return true;
                PsiFile psiFile = PsiManager.getInstance(project).findFile(file);
                Document document = FileDocumentManager.getInstance().getDocument(file);
                if (psiFile == null || document == null) return true;
                for (PsiNamedElement element : PsiTreeUtil.findChildrenOfType(psiFile, PsiNamedElement.class)) {
                    if (element.getName() == null || element.getTextRange() == null) continue;
                    if (!includeLowValue && isLowValueSymbol(element)) continue;
                    if (!element.getName().toLowerCase(Locale.ROOT).contains(query)) continue;
                    matches.add(symbolMap(element, document, project, file));
                    if (matches.size() >= limit) return false;
                }
                return true;
            });
            return Map.of("symbols", matches, "truncated", matches.size() >= limit);
        });
    }

    private Object targetLocations(ResolvedFile resolved, JsonObject params, String kind, int limit) {
        PsiElement target = targetAt(resolved, params);
        return ReadAction.compute(() -> Map.of("locations", List.of(location(target, resolved.project)), "truncated", false, "kind", kind));
    }

    private Object referenceLocations(ResolvedFile resolved, JsonObject params, int limit) {
        PsiElement target = targetAt(resolved, params);
        return ReadAction.compute(() -> {
            Map<String, Map<String, Object>> unique = new LinkedHashMap<>();
            if (bool(params, "includeDeclaration", true)) {
                Map<String, Object> declaration = location(target, resolved.project);
                unique.put(GSON.toJson(declaration), declaration);
            }
            for (PsiReference reference : ReferencesSearch.search(
                    target, GlobalSearchScope.projectScope(resolved.project)).findAll()) {
                Map<String, Object> found = location(reference.getElement(), resolved.project);
                unique.putIfAbsent(GSON.toJson(found), found);
                if (unique.size() >= limit) break;
            }
            List<Map<String, Object>> locations = unique.values().stream().limit(limit).toList();
            return Map.of("locations", locations, "truncated", unique.size() >= limit);
        });
    }

    private Object implementationLocations(ResolvedFile resolved, JsonObject params, int limit) {
        PsiElement target = targetAt(resolved, params);
        return ReadAction.compute(() -> {
            Collection<PsiElement> implementations = DefinitionsScopedSearch.search(
                    target, GlobalSearchScope.projectScope(resolved.project), true).findAll();
            List<Map<String, Object>> locations = implementations.stream().limit(limit)
                    .map(element -> location(element, resolved.project)).toList();
            return Map.of("locations", locations, "truncated", implementations.size() > limit);
        });
    }

    private Object edit(JsonObject params) {
        ResolvedFile resolved = resolveFile(requiredString(params, "path"));
        String operation = requiredString(params, "operation");
        String newText = requiredText(params, "newText", true);
        return onEdt(() -> {
            Document document = FileDocumentManager.getInstance().getDocument(resolved.file);
            if (document == null) throw fail("IDE_EDIT_FAILED", "The file is not a text document.");
            final int[] count = {0};
            WriteCommandAction.runWriteCommandAction(resolved.project, "DSH IDE Edit", null, () -> {
                if ("exactReplace".equals(operation)) {
                    String oldText = requiredText(params, "oldText", false);
                    List<Integer> offsets = allOffsets(document.getText(), oldText);
                    if (offsets.isEmpty()) throw fail("IDE_EDIT_NO_MATCH", "old_text was not found; no edit was applied.");
                    boolean replaceAll = bool(params, "replaceAll", false);
                    if (!replaceAll && offsets.size() != 1) throw fail("IDE_EDIT_AMBIGUOUS", "old_text matched " + offsets.size() + " places; no edit was applied.");
                    List<Integer> selected = replaceAll ? offsets : List.of(offsets.getFirst());
                    selected.stream().sorted(Comparator.reverseOrder()).forEach(offset -> document.replaceString(offset, offset + oldText.length(), newText));
                    count[0] = selected.size();
                } else {
                    PsiNamedElement symbol = findSymbol(resolved, requiredString(params, "symbol"));
                    TextRange symbolRange = symbol.getTextRange();
                    switch (operation) {
                        case "replaceSymbol" -> document.replaceString(symbolRange.getStartOffset(), symbolRange.getEndOffset(), newText);
                        case "insertBeforeSymbol" -> document.insertString(symbolRange.getStartOffset(), newText);
                        case "insertAfterSymbol" -> document.insertString(symbolRange.getEndOffset(), newText);
                        default -> throw fail("IDE_INVALID_REQUEST", "Unsupported edit operation: " + operation);
                    }
                    count[0] = 1;
                }
                PsiDocumentManager.getInstance(resolved.project).commitDocument(document);
            });
            boolean saved = false;
            if (bool(params, "save", true)) {
                FileDocumentManager.getInstance().saveDocument(document);
                saved = true;
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("applied", true);
            result.put("operation", operation);
            result.put("path", displayPath(resolved.project, resolved.file));
            result.put("editCount", count[0]);
            result.put("saved", saved);
            return result;
        });
    }

    private Object rename(JsonObject params) {
        ResolvedFile resolved = resolveFile(requiredString(params, "path"));
        PsiElement target = targetAt(resolved, params);
        String newName = requiredString(params, "newName");
        return onEdt(() -> {
            new RenameProcessor(resolved.project, target, newName, false, false).run();
            if (bool(params, "save", true)) FileDocumentManager.getInstance().saveAllDocuments();
            return Map.of("applied", true, "newName", newName);
        });
    }

    private Object command(JsonObject params) {
        String command = requiredString(params, "command");
        return onEdt(() -> {
            Project project = activeProject(null);
            switch (command) {
                case "workbench.action.files.saveAll" -> FileDocumentManager.getInstance().saveAllDocuments();
                case "workbench.action.files.save" -> {
                    if (project == null) throw fail("IDE_WORKSPACE_REQUIRED", "No project is open.");
                    Editor editor = FileEditorManager.getInstance(project).getSelectedTextEditor();
                    if (editor == null) throw fail("IDE_EDITOR_REQUIRED", "No text editor is active.");
                    FileDocumentManager.getInstance().saveDocument(editor.getDocument());
                }
                default -> throw fail("IDE_COMMAND_NOT_ALLOWED", "IDE command is not allowed or unsupported on JetBrains: " + command);
            }
            return Map.of("executed", true, "command", command);
        });
    }

    private PsiElement targetAt(ResolvedFile resolved, JsonObject params) {
        int line = intValue(params, "line", -1);
        int column = intValue(params, "column", -1);
        if (line < 1 || column < 1) throw fail("IDE_INVALID_REQUEST", "line and column are required positive integers.");
        return onEdt(() -> {
            Document document = FileDocumentManager.getInstance().getDocument(resolved.file);
            if (document == null) throw fail("IDE_EDITOR_REQUIRED", "The file is not a text document.");
            int lineIndex = Math.min(line - 1, Math.max(0, document.getLineCount() - 1));
            int offset = Math.min(document.getLineEndOffset(lineIndex), document.getLineStartOffset(lineIndex) + column - 1);
            Editor editor = FileEditorManager.getInstance(resolved.project).openTextEditor(
                    new OpenFileDescriptor(resolved.project, resolved.file, offset), false);
            if (editor == null) throw fail("IDE_EDITOR_REQUIRED", "The IDE could not create an editor.");
            return ReadAction.compute(() -> {
                int flags = TargetElementUtil.ELEMENT_NAME_ACCEPTED | TargetElementUtil.REFERENCED_ELEMENT_ACCEPTED;
                PsiElement target = TargetElementUtil.getInstance().findTargetElement(editor, flags, offset);
                if (target == null) throw fail("IDE_SYMBOL_NOT_FOUND", "No symbol was found at that position.");
                return target;
            });
        });
    }

    private PsiNamedElement findSymbol(ResolvedFile resolved, String requested) {
        return ReadAction.compute(() -> {
            PsiFile file = PsiManager.getInstance(resolved.project).findFile(resolved.file);
            if (file == null) throw fail("IDE_SYMBOL_NOT_FOUND", "The IDE has no PSI file for this path.");
            String needle = normalizeSymbolPath(requested);
            List<PsiNamedElement> matches = PsiTreeUtil.findChildrenOfType(file, PsiNamedElement.class).stream()
                    .filter(element -> element.getName() != null && element.getTextRange() != null)
                    .filter(element -> {
                        String candidate = symbolPath(element);
                        return candidate.equals(needle) || candidate.endsWith("/" + needle);
                    }).toList();
            if (matches.isEmpty()) throw fail("IDE_SYMBOL_NOT_FOUND", "Symbol not found: " + requested);
            if (matches.size() > 1) throw fail("IDE_SYMBOL_AMBIGUOUS", "Symbol is ambiguous: " + requested);
            return matches.getFirst();
        });
    }

    private ResolvedFile resolveFile(String requested) {
        Path input = Path.of(requested);
        Project project = input.isAbsolute() ? activeProject(input) : projectForRelativePath(input);
        if (project == null || project.getBasePath() == null) throw fail("IDE_WORKSPACE_REQUIRED", "No matching JetBrains project is open.");
        try {
            Path root = Path.of(project.getBasePath()).toRealPath();
            Path candidate = (input.isAbsolute() ? input : root.resolve(input)).toAbsolutePath().normalize();
            Path real = candidate.toRealPath();
            if (!allowOutsideWorkspace() && !real.startsWith(root)) {
                throw fail("IDE_PATH_OUTSIDE_WORKSPACE", "Path is outside the open project: " + requested);
            }
            VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(real);
            if (file == null || file.isDirectory()) throw fail("IDE_FILE_NOT_FOUND", "File not found: " + requested);
            return new ResolvedFile(project, file);
        } catch (IOException error) {
            throw fail("IDE_FILE_NOT_FOUND", "File not found: " + requested);
        }
    }

    private Project projectForRelativePath(Path relative) {
        List<Project> matches = new ArrayList<>();
        List<Project> open = new ArrayList<>();
        for (Project project : ProjectManager.getInstance().getOpenProjects()) {
            if (project.isDisposed() || project.getBasePath() == null) continue;
            open.add(project);
            if (Files.exists(Path.of(project.getBasePath()).resolve(relative))) matches.add(project);
        }
        if (matches.size() == 1) return matches.getFirst();
        List<Project> candidates = matches.isEmpty() ? open : matches;
        Project focused = focusedProject(candidates);
        if (focused != null) return focused;
        if (candidates.size() == 1) return candidates.getFirst();
        if (matches.size() > 1) throw fail("IDE_WORKSPACE_AMBIGUOUS", "Relative path exists in more than one open project: " + relative);
        return null;
    }

    private Project focusedProject(List<Project> candidates) {
        return onEdt(() -> {
            for (Project project : candidates) {
                Editor editor = FileEditorManager.getInstance(project).getSelectedTextEditor();
                if (editor != null && editor.getContentComponent().isFocusOwner()) return project;
            }
            return null;
        });
    }

    private ResolvedFile selectedFile() {
        return onEdt(() -> {
            Project project = activeProject(null);
            if (project == null) throw fail("IDE_WORKSPACE_REQUIRED", "No JetBrains project is open.");
            VirtualFile[] selected = FileEditorManager.getInstance(project).getSelectedFiles();
            if (selected.length == 0) throw fail("IDE_EDITOR_REQUIRED", "No file is selected.");
            return new ResolvedFile(project, selected[0]);
        });
    }

    private Project activeProject(Path file) {
        Project[] projects = ProjectManager.getInstance().getOpenProjects();
        if (file != null) {
            for (Project project : projects) {
                if (project.getBasePath() != null && file.toAbsolutePath().normalize().startsWith(Path.of(project.getBasePath()).toAbsolutePath().normalize())) return project;
            }
        }
        Project focused = focusedProject(List.of(projects));
        if (focused != null) return focused;
        for (Project project : projects) if (!project.isDisposed()) return project;
        return null;
    }

    private Map<String, Object> noActiveEditor() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("activeEditor", null);
        return result;
    }

    private Map<String, Object> baseStatus() {
        List<String> roots = new ArrayList<>();
        for (Project project : ProjectManager.getInstance().getOpenProjects()) if (project.getBasePath() != null) roots.add(project.getBasePath());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("connected", true);
        result.put("ide", "JetBrains");
        result.put("ideVersion", com.intellij.openapi.application.ApplicationInfo.getInstance().getFullVersion());
        result.put("workspaceFolders", roots);
        return result;
    }

    private Map<String, Object> editorSummary(Editor editor, Project project) {
        if (editor == null) return null;
        VirtualFile file = FileDocumentManager.getInstance().getFile(editor.getDocument());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("path", file == null ? null : displayPath(project, file));
        result.put("languageId", file == null ? null : file.getFileType().getName());
        result.put("lineCount", editor.getDocument().getLineCount());
        result.put("dirty", FileDocumentManager.getInstance().isDocumentUnsaved(editor.getDocument()));
        result.put("caret", position(editor.getDocument(), editor.getCaretModel().getOffset()));
        return result;
    }

    private Map<String, Object> symbolMap(PsiNamedElement element, Document document, Project project, VirtualFile file) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", element.getName());
        result.put("namePath", symbolPath(element));
        result.put("kind", element.getClass().getSimpleName());
        result.put("path", displayPath(project, file));
        result.put("range", range(document, element.getTextRange().getStartOffset(), element.getTextRange().getEndOffset()));
        return result;
    }

    private Map<String, Object> location(PsiElement element, Project project) {
        PsiFile file = element.getContainingFile();
        if (file == null || file.getVirtualFile() == null || element.getTextRange() == null) throw fail("IDE_SYMBOL_NOT_FOUND", "Symbol has no source location.");
        Document document = FileDocumentManager.getInstance().getDocument(file.getVirtualFile());
        if (document == null) throw fail("IDE_SYMBOL_NOT_FOUND", "Symbol source is not a text document.");
        return Map.of("path", displayPath(project, file.getVirtualFile()), "range", range(document, element.getTextRange().getStartOffset(), element.getTextRange().getEndOffset()));
    }

    private boolean isLowValueSymbol(PsiNamedElement element) {
        String kind = element.getClass().getSimpleName();
        if (kind.contains("Import")
                || kind.contains("ImportedBinding")
                || kind.contains("Parameter")
                || kind.contains("Property")
                || kind.contains("Field")
                || kind.contains("Reference")
                || kind.contains("DefinitionExpression")
                || kind.contains("FunctionExpression")
                || kind.contains("Literal")) return true;

        if (!kind.contains("Variable")) return false;
        PsiElement ancestor = element.getParent();
        while (ancestor != null && !(ancestor instanceof PsiFile)) {
            String ancestorKind = ancestor.getClass().getSimpleName();
            if (ancestorKind.contains("Function")
                    || ancestorKind.contains("Method")
                    || ancestorKind.contains("Lambda")) return true;
            ancestor = ancestor.getParent();
        }
        return false;
    }

    private String symbolPath(PsiNamedElement element) {
        List<String> names = new ArrayList<>();
        PsiElement current = element;
        while (current instanceof PsiNamedElement named && !(current instanceof PsiFile)) {
            if (named.getName() != null && !named.getName().isBlank()) names.addFirst(named.getName());
            current = current.getParent();
        }
        return String.join("/", names);
    }

    private Map<String, Object> position(Document document, int offset) {
        int safe = Math.max(0, Math.min(offset, document.getTextLength()));
        int line = document.getLineNumber(safe);
        return Map.of("line", line + 1, "column", safe - document.getLineStartOffset(line) + 1);
    }

    private Map<String, Object> range(Document document, int start, int end) {
        return Map.of("start", position(document, start), "end", position(document, end));
    }

    private String displayPath(Project project, VirtualFile file) {
        if (project.getBasePath() == null) return file.getPath();
        Path root = Path.of(project.getBasePath()).toAbsolutePath().normalize();
        Path candidate = Path.of(file.getPath()).toAbsolutePath().normalize();
        return candidate.startsWith(root) ? root.relativize(candidate).toString().replace('\\', '/') : candidate.toString();
    }

    private void writeDiscoverySafely() {
        try {
            writeDiscovery();
        } catch (Exception error) {
            LOG.warn("Could not refresh DSH IDE Bridge discovery", error);
        }
    }

    private void writeDiscovery() throws IOException {
        ServerSocket value = server;
        if (value == null || value.isClosed()) return;
        Path directory = discoveryDirectory();
        Files.createDirectories(directory);
        if (Files.isSymbolicLink(directory)) throw new IOException("Discovery directory must not be a symbolic link: " + directory);
        setPosixPermissionsIfSupported(directory, PosixFilePermissions.fromString("rwx------"));
        Path file = directory.resolve(ProcessHandle.current().pid() + "-jetbrains.json");
        Path temporary = createSecureTemporaryFile(directory, file.getFileName().toString());
        Map<String, Object> record = baseStatus();
        record.put("protocolVersion", 1);
        record.put("pid", ProcessHandle.current().pid());
        record.put("host", "127.0.0.1");
        record.put("port", value.getLocalPort());
        record.put("token", token);
        record.put("startedAt", startedAt.toString());
        record.put("updatedAt", Instant.now().toString());
        Files.writeString(temporary, GSON.toJson(record) + System.lineSeparator(), StandardCharsets.UTF_8);
        try {
            Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException ignored) {
            Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
        }
        setPosixPermissionsIfSupported(file, PosixFilePermissions.fromString("rw-------"));
        discoveryFile = file;
    }

    private Path createSecureTemporaryFile(Path directory, String prefix) throws IOException {
        Path temporary;
        try {
            temporary = Files.createTempFile(directory, prefix + ".", ".tmp",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        } catch (UnsupportedOperationException error) {
            temporary = Files.createTempFile(directory, prefix + ".", ".tmp");
        }
        setPosixPermissionsIfSupported(temporary, PosixFilePermissions.fromString("rw-------"));
        return temporary;
    }

    private void setPosixPermissionsIfSupported(Path target, java.util.Set<PosixFilePermission> permissions) throws IOException {
        try {
            Files.setPosixFilePermissions(target, permissions);
        } catch (UnsupportedOperationException ignored) {
            // Windows uses the current user's inherited temporary-directory ACL.
        }
    }

    private void writeResponse(BufferedWriter writer, JsonElement id, Object result) throws IOException {
        JsonObject response = new JsonObject();
        response.add("id", id);
        response.addProperty("ok", true);
        response.add("result", GSON.toJsonTree(result));
        writer.write(GSON.toJson(response));
        writer.newLine();
        writer.flush();
    }

    private void writeError(BufferedWriter writer, JsonElement id, BridgeException error) throws IOException {
        JsonObject payload = new JsonObject();
        payload.add("id", id);
        payload.addProperty("ok", false);
        JsonObject body = new JsonObject();
        body.addProperty("code", error.code);
        body.addProperty("message", error.getMessage() == null ? error.code : error.getMessage());
        payload.add("error", body);
        writer.write(GSON.toJson(payload));
        writer.newLine();
        writer.flush();
    }

    private String readLineLimited(BufferedReader reader) throws IOException {
        StringBuilder value = new StringBuilder();
        int character;
        while ((character = reader.read()) >= 0 && character != '\n') {
            if (value.length() >= MAX_REQUEST_CHARS) throw fail("IDE_REQUEST_TOO_LARGE", "Request is too large.");
            value.append((char) character);
        }
        return value.toString();
    }

    private boolean tokenMatches(String candidate) {
        if (candidate == null) return false;
        return MessageDigest.isEqual(candidate.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8));
    }

    private static String randomToken() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private int configuredPort() {
        String raw = System.getenv().getOrDefault("DSH_IDE_PORT", "0");
        try {
            int port = Integer.parseInt(raw);
            if (port < 0 || port > 65535) throw new NumberFormatException();
            return port;
        } catch (NumberFormatException error) {
            LOG.warn("Ignoring invalid DSH_IDE_PORT: " + raw);
            return 0;
        }
    }

    private Path discoveryDirectory() {
        String configured = System.getenv("DSH_IDE_DISCOVERY_DIR");
        return configured == null || configured.isBlank()
                ? Path.of(System.getProperty("java.io.tmpdir"), "dsh-ide-bridge")
                : Path.of(configured);
    }

    private boolean allowOutsideWorkspace() {
        return Boolean.parseBoolean(System.getenv().getOrDefault("DSH_IDE_ALLOW_OUTSIDE_WORKSPACE", "false"));
    }

    private static <T> T onEdt(Computable<T> work) {
        if (ApplicationManager.getApplication().isDispatchThread()) return work.compute();
        final Object[] result = new Object[1];
        final RuntimeException[] failure = new RuntimeException[1];
        ApplicationManager.getApplication().invokeAndWait(() -> {
            try {
                result[0] = work.compute();
            } catch (RuntimeException error) {
                failure[0] = error;
            }
        });
        if (failure[0] != null) throw failure[0];
        @SuppressWarnings("unchecked") T typed = (T) result[0];
        return typed;
    }

    private static String requiredText(JsonObject object, String name, boolean allowEmpty) {
        if (!object.has(name) || object.get(name).isJsonNull() || !object.get(name).isJsonPrimitive()
                || !object.getAsJsonPrimitive(name).isString()) {
            throw fail("IDE_INVALID_REQUEST", name + " must be a string.");
        }
        String value = object.get(name).getAsString();
        if (!allowEmpty && value.isEmpty()) throw fail("IDE_INVALID_REQUEST", name + " must not be empty.");
        return value;
    }

    private static String requiredString(JsonObject object, String name) {
        String value = string(object, name, null);
        if (value == null || value.isBlank()) throw fail("IDE_INVALID_REQUEST", name + " is required.");
        return value;
    }

    private static String string(JsonObject object, String name, String fallback) {
        return object.has(name) && !object.get(name).isJsonNull() ? object.get(name).getAsString() : fallback;
    }

    private static int intValue(JsonObject object, String name, int fallback) {
        return object.has(name) ? object.get(name).getAsInt() : fallback;
    }

    private static boolean bool(JsonObject object, String name, boolean fallback) {
        return object.has(name) ? object.get(name).getAsBoolean() : fallback;
    }

    private static int boundedInt(JsonObject object, String name, int fallback, int minimum, int maximum) {
        int value = intValue(object, name, fallback);
        if (value < minimum || value > maximum) throw fail("IDE_INVALID_REQUEST", name + " must be from " + minimum + " to " + maximum + ".");
        return value;
    }

    private static List<Integer> allOffsets(String text, String needle) {
        if (needle.isEmpty()) throw fail("IDE_INVALID_REQUEST", "oldText must not be empty.");
        List<Integer> result = new ArrayList<>();
        int cursor = 0;
        while (cursor <= text.length()) {
            int offset = text.indexOf(needle, cursor);
            if (offset < 0) break;
            result.add(offset);
            cursor = offset + needle.length();
        }
        return result;
    }

    private static String normalizeSymbolPath(String value) {
        return String.join("/", List.of(value.split("/")).stream().filter(part -> !part.isBlank()).toList());
    }

    private static int severityRank(String value) {
        return switch (value.toLowerCase(Locale.ROOT)) {
            case "error" -> 0;
            case "warning" -> 1;
            case "information" -> 2;
            case "hint" -> 3;
            default -> throw fail("IDE_INVALID_REQUEST", "Unknown severity: " + value);
        };
    }

    private static int severityRank(HighlightSeverity value) {
        if (value.compareTo(HighlightSeverity.ERROR) >= 0) return 0;
        if (value.compareTo(HighlightSeverity.WARNING) >= 0) return 1;
        if (value.compareTo(HighlightSeverity.WEAK_WARNING) >= 0) return 2;
        return 3;
    }

    private static String severityName(HighlightSeverity value) {
        return switch (severityRank(value)) {
            case 0 -> "error";
            case 1 -> "warning";
            case 2 -> "information";
            default -> "hint";
        };
    }

    private static BridgeException fail(String code, String message) {
        return new BridgeException(code, message, null);
    }

    @Override
    public void dispose() {
        ServerSocket value = server;
        if (value != null) {
            try {
                value.close();
            } catch (IOException ignored) {
            }
        }
        heartbeat.shutdownNow();
        clients.shutdownNow();
        serverThread.shutdownNow();
        Path file = discoveryFile;
        if (file != null) {
            try {
                Files.deleteIfExists(file);
            } catch (IOException ignored) {
            }
        }
    }

    private record ResolvedFile(Project project, VirtualFile file) {}

    private static final class BridgeException extends RuntimeException {
        private final String code;
        private JsonElement requestId;

        private BridgeException(String code, String message, JsonElement requestId) {
            super(message);
            this.code = code;
            this.requestId = requestId;
        }

        private BridgeException(String code, String message, JsonElement requestId, Throwable cause) {
            super(message, cause);
            this.code = code;
            this.requestId = requestId;
        }
    }
}
