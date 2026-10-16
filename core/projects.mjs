import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { TypeScriptBackend } from './typescript.mjs';
import { LspBackend } from './lsp.mjs';
import { safePath, scanFiles, readText, fail, slash, pathKey, offsetAt, positionAt, hash, within, applyChanges } from './files.mjs';

const TS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const EXT = { python: ['.py', '.pyi'], go: ['.go'], rust: ['.rs'], cpp: ['.c', '.h', '.cc', '.cpp', '.hpp'] };
const LANG = Object.fromEntries(Object.entries(EXT).flatMap(([name, extensions]) => extensions.map(ext => [ext, name])));
const SOURCE = [...TS, ...Object.values(EXT).flat()];
const insideRange = (range, position) => (position.line > range.start.line || position.line === range.start.line && position.character >= range.start.character) && (position.line < range.end.line || position.line === range.end.line && position.character <= range.end.character);

export class Projects {
  constructor(config = {}) { this.config = config; this.projects = new Map(); this.activeSessions = new Map(); }
  activeFor(exec) { return this.activeSessions.get(exec?.agent?.session?.header?.id ?? 'default'); }
  async activate(path, exec) {
    if (!isAbsolute(path ?? '')) fail('INVALID_PROJECT', 'activate_project requires an absolute project directory.');
    const root = await fs.realpath(path);
    if (!(await fs.stat(root)).isDirectory()) fail('INVALID_PROJECT', 'Project path must be a directory.');
    if (!this.projects.has(root)) this.projects.set(root, new Project(root, this.config));
    this.active = root;
    this.activeSessions.set(exec?.agent?.session?.header?.id ?? 'default', root);
    const project = this.projects.get(root); await project.ensure();
    return project;
  }
  async pick(exec) {
    const active = this.activeFor(exec);
    if (exec.workspaceExplicit === true || !active && exec.workspaceExplicit === undefined && exec.agent?.session?.header?.cwd) {
      const root = await fs.realpath(exec.agent.session.header.cwd);
      if (!this.projects.has(root)) this.projects.set(root, new Project(root, this.config));
      return this.projects.get(root);
    }
    if (!active) fail('NO_ACTIVE_PROJECT', 'Call activate_project with an absolute directory, or pass workspace_root explicitly.');
    return this.projects.get(active);
  }
  async close() { for (const project of this.projects.values()) await project.close(); }
}

export class Project {
  constructor(root, config) { this.root = root; this.config = config; this.backends = new Map(); this.generation = 0; this.backendErrors = new Map(); }
  begin() { this.generation++; this.backendErrors.clear(); }
  sourceExtensions() { return [...new Set([...SOURCE, ...Object.values(this.config.languageServers ?? {}).flatMap(value => value?.extensions ?? [])])]; }
  languageFor(path) { const extension = extname(path).toLowerCase(); return Object.entries(this.config.languageServers ?? {}).find(([, value]) => value?.extensions?.includes(extension))?.[0] ?? (TS.has(extension) ? 'typescript' : LANG[extension]); }
  async ensure() {
    const directory = await safePath(this.root, '.codex-ide-bridge', true); await fs.mkdir(directory, { recursive: true });
    const path = await safePath(this.root, '.codex-ide-bridge/project.json', true);
    try { await fs.writeFile(path, JSON.stringify({ version: 1, name: basename(this.root), createdAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  serverConfig(language) {
    const supplied = this.config.languageServers?.[language];
    if (supplied === false) fail('LANGUAGE_DISABLED', 'The ' + language + ' server is disabled by operator configuration.');
    if (supplied) {
      if (typeof supplied.command !== 'string' || !Array.isArray(supplied.args ?? [])) fail('INVALID_CONFIG', 'languageServers entries require command and an args array.');
      return supplied;
    }
    if (language === 'python') {
      let entry;
      try { entry = createRequire(import.meta.url).resolve('pyright/dist/pyright-langserver.js'); }
      catch { entry = fileURLToPath(new URL('./pyright/dist/pyright-langserver.js', import.meta.url)); }
      return { command: process.execPath, args: [entry, '--stdio'] };
    }
    return ({ go: { command: 'gopls', args: ['serve'] }, rust: { command: 'rust-analyzer', args: [] }, cpp: { command: 'clangd', args: ['--background-index'] } })[language];
  }
  async backend(path, signal) {
    const extension = extname(path).toLowerCase(), language = this.languageFor(path);
    if (!language) fail('UNSUPPORTED_LANGUAGE', 'No semantic backend for ' + extension + '. Use IDE tools or configure a languageServers entry with matching extensions.');
    if (this.backendErrors.has(language)) throw this.backendErrors.get(language);
    if (!this.backends.has(language)) {
      if (language === 'typescript' && this.config.languageServers?.typescript === undefined) this.backends.set(language, new TypeScriptBackend(this.root));
      else {
        const config = this.serverConfig(language); if (!config) fail('LANGUAGE_SERVER_UNAVAILABLE', 'No language server is configured for ' + language);
        const backend = new LspBackend(this.root, config, language);
        try { await backend.start(signal); this.backends.set(language, backend); } catch (error) { await backend.close(); this.backendErrors.set(language, error); throw error; }
      }
    }
    const backend = this.backends.get(language);
    if (backend instanceof TypeScriptBackend && backend.generation !== this.generation) { await backend.refresh(); backend.generation = this.generation; }
    return backend;
  }
  async symbols(input, signal) {
    const path = await safePath(this.root, input);
    const backend = await this.backend(path, signal);
    return { backend, symbols: await backend.symbols(path, signal) };
  }
  async summarize(symbol, includeBody = false) {
    const value = { name: symbol.name, name_path: symbol.name_path, kind: symbol.kind,
      relative_path: slash(relative(this.root, symbol.path)), range: symbol.range, selection_range: symbol.selectionRange };
    if (includeBody) { const snapshot = await readText(this.root, symbol.path); value.body = snapshot.text.slice(offsetAt(snapshot.text, symbol.range.start), offsetAt(snapshot.text, symbol.range.end)); value.file_hash = snapshot.hash; }
    return value;
  }
  async find(args, signal) {
    let files, truncated = false;
    if (args.relative_path) {
      const path = await safePath(this.root, args.relative_path);
      if ((await fs.stat(path)).isDirectory()) { const scan = await scanFiles(this.root, { extensions: this.sourceExtensions() }); files = scan.files.filter(file => within(path, file)); truncated = scan.truncated; }
      else files = [path];
    } else { const scan = await scanFiles(this.root, { extensions: this.sourceExtensions() }); files = scan.files; truncated = scan.truncated; }
    const needle = args.name_path_pattern.replace(/^\//, ''), result = [], errors = [];
    for (const path of files) {
      if (signal?.aborted) fail('ABORTED', 'Symbol search cancelled.');
      try {
        const { symbols } = await this.symbols(path, signal);
        for (const symbol of symbols) {
          const matches = args.substring_matching ? symbol.name_path.includes(needle) : symbol.name_path === needle || symbol.name_path.endsWith('/' + needle);
          if (matches && (!args.include_kinds?.length || args.include_kinds.includes(symbol.kind)) && !args.exclude_kinds?.includes(symbol.kind)) {
            result.push(await this.summarize(symbol, args.include_body));
            if (result.length >= (args.limit ?? 100)) return { symbols: result, truncated: true, backend_errors: errors };
          }
        }
      } catch (error) {
        if (['ABORTED', 'OUTSIDE_WORKSPACE'].includes(error.code)) throw error;
        if (!errors.some(item => item.code === error.code && item.extension === extname(path))) errors.push({ extension: extname(path), code: error.code ?? 'BACKEND_ERROR', message: error.message });
      }
    }
    return { symbols: result, truncated, backend_errors: errors };
  }
  async select(relativePath, namePath, signal) {
    const { backend, symbols } = await this.symbols(relativePath, signal);
    const matches = symbols.filter(symbol => symbol.name_path === namePath.replace(/^\//, '') || symbol.name_path.endsWith('/' + namePath.replace(/^\//, '')));
    if (matches.length !== 1) fail('AMBIGUOUS_SYMBOL', matches.length ? 'Several matching symbols; use an exact name_path and file. Overloads are not edited implicitly.' : 'No matching symbol in this file.');
    return { backend, symbol: matches[0] };
  }
  async references(args, operation, signal) {
    const { backend, symbol } = await this.select(args.relative_path, args.name_path, signal);
    const locations = await backend.locations(symbol.path, symbol.selectionRange.start, operation, signal);
    const result = [];
    for (const location of locations.slice(0, args.limit ?? 100)) {
      await safePath(this.root, location.path);
      const source = await readText(this.root, location.path);
      let enclosing;
      try {
        const candidates = (await this.symbols(location.path, signal)).symbols.filter(item => insideRange(item.range, location.range.start));
        candidates.sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line)); enclosing = candidates[0]?.name_path;
      } catch {}
      result.push({ relative_path: slash(relative(this.root, location.path)), range: location.range, enclosing_symbol: enclosing,
        snippet: source.text.split('\n')[location.range.start.line]?.replace(/\r$/, ''), is_definition: location.is_definition });
    }
    return { locations: result, truncated: locations.length > (args.limit ?? 100) };
  }
  async rename(args, signal) {
    const { backend, symbol } = await this.select(args.relative_path, args.name_path, signal);
    const index = await scanFiles(this.root, { extensions: this.sourceExtensions() });
    const snapshots = new Map();
    for (const path of index.files) snapshots.set(pathKey(path), (await readText(this.root, path)).hash);
    const changes = await backend.rename(symbol.path, symbol.selectionRange.start, args.new_name, signal);
    for (const [path, edits] of changes) {
      const oldHash = snapshots.get(pathKey(path)); if (!oldHash) fail('UNINDEXED_EDIT', 'Rename proposed a file outside the indexed source set; no changes applied.');
      for (const edit of edits) edit.expectedHash = oldHash;
    }
    const result = await applyChanges(this.root, changes, { dryRun: args.dry_run ?? true });
    if (result.applied && backend instanceof LspBackend) for (const path of changes.keys()) await backend.sync(path);
    return result;
  }
  async editSymbol(args, operation, signal) {
    const { backend, symbol } = await this.select(args.relative_path, args.name_path, signal);
    const snapshot = await readText(this.root, symbol.path);
    if (args.expected_hash && snapshot.hash !== args.expected_hash) fail('STALE_DOCUMENT', 'Source changed since the symbol was inspected.');
    let start = offsetAt(snapshot.text, symbol.range.start), end = offsetAt(snapshot.text, symbol.range.end);
    if (operation === 'before') end = start;
    if (operation === 'after') start = end;
    const changes = new Map([[symbol.path, [{ start, end, newText: args.body, expectedHash: snapshot.hash }]]]);
    const result = await applyChanges(this.root, changes, { dryRun: args.dry_run ?? true });
    if (result.applied && backend instanceof LspBackend) await backend.sync(symbol.path);
    return result;
  }
  async status() {
    const scan = await scanFiles(this.root, { extensions: this.sourceExtensions() });
    const languages = [...new Set(scan.files.map(path => this.languageFor(path)))];
    return { project: basename(this.root), root: this.root, source_files: scan.files.length, index_truncated: scan.truncated,
      detected_languages: languages,
      backends: languages.map(language => ({ language, running: this.backends.has(language), distribution: ['typescript', 'python'].includes(language) ? 'bundled' : 'external executable required' })),
      memory_directory: join(this.root, '.codex-ide-bridge/memories'), independent_of_ide: true, serena_required: false };
  }
  async onboarding(summary) {
    if (summary !== undefined) {
      await this.ensure();
      if (summary.trim().length === 0) fail('INVALID_INPUT', 'Onboarding summary cannot be empty.');
      const path = await safePath(this.root, '.codex-ide-bridge/onboarding.md', true);
      await fs.writeFile(path, summary, 'utf8');
      return { completed: true, path };
    }
    const observations = { ...(await this.status()), commands: {}, manifests: [], instructions: [] };
    for (const file of ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'CMakeLists.txt', 'AGENTS.md', 'README.md']) {
      try {
        const snapshot = await readText(this.root, file); observations.manifests.push(file);
        if (file === 'package.json') observations.commands = JSON.parse(snapshot.text).scripts ?? {};
        if (['AGENTS.md', 'README.md'].includes(file)) observations.instructions.push({ file, excerpt: snapshot.text.slice(0, 8000), untrusted_project_text: true });
      } catch (error) { if (error.code !== 'ENOENT') observations.instructions.push({ file, error: error.message }); }
    }
    return { ...observations, completed: false, next_step: 'Inspect the project, then call onboarding with a concise summary of purpose, structure, conventions and verified build/test commands. Listed commands have not been executed.' };
  }
  memoryName(name) {
    if (typeof name !== 'string' || name.length > 200) fail('INVALID_MEMORY_NAME', 'Memory names must be 1-200 characters.');
    const normalized = name.replace(/\.md$/, '');
    if (normalized.split('/').some(part => !/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*$/u.test(part) || part === '.' || part === '..')) fail('INVALID_MEMORY_NAME', 'Use relative memory names without traversal, colons or backslashes.');
    return normalized + '.md';
  }
  async listMemories() {
    const result = [];
    for (const [base, source] of [['.codex-ide-bridge/memories', 'codex'], ['.serena/memories', 'serena']]) {
      let directory;
      try { directory = await safePath(this.root, base); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      async function visit(dir, prefix = '') {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await visit(join(dir, entry.name), prefix + entry.name + '/');
          else if (entry.isFile() && entry.name.endsWith('.md')) result.push({ name: prefix + entry.name.slice(0, -3), source, read_only: source === 'serena' });
        }
      }
      await visit(directory);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  }
  async readMemory(name, source = 'auto') {
    const filename = this.memoryName(name);
    for (const origin of source === 'auto' ? ['codex', 'serena'] : [source]) {
      try {
        const snapshot = await readText(this.root, join(origin === 'serena' ? '.serena/memories' : '.codex-ide-bridge/memories', filename));
        return { name, source: origin, content: snapshot.text, hash: snapshot.hash, untrusted_project_text: true };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fail('MEMORY_NOT_FOUND', 'Memory not found: ' + name);
  }
  async writeMemory(name, content, expectedHash) {
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024) fail('MEMORY_TOO_LARGE', 'A memory may be at most 256 KiB.');
    await this.ensure(); const path = await safePath(this.root, join('.codex-ide-bridge/memories', this.memoryName(name)), true);
    await fs.mkdir(await safePath(this.root, relative(this.root, join(path, '..')), true), { recursive: true });
    if (expectedHash !== undefined) {
      let actual; try { actual = hash(await fs.readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (actual !== expectedHash) fail('STALE_MEMORY', 'Memory changed since it was read.');
    }
    await fs.writeFile(path, content, 'utf8'); return { name, written: true, hash: hash(content), source: 'codex' };
  }
  async editMemory(name, oldText, newText, expectedHash) {
    const memory = await this.readMemory(name, 'codex');
    if (!oldText || memory.content.split(oldText).length !== 2) fail('AMBIGUOUS_EDIT', 'old_text must match exactly once in the memory.');
    return this.writeMemory(name, memory.content.replace(oldText, () => newText), expectedHash ?? memory.hash);
  }
  async deleteMemory(name) { const path = await safePath(this.root, join('.codex-ide-bridge/memories', this.memoryName(name))); await fs.unlink(path); return { deleted: true, name, source: 'codex' }; }
  async importMemories(overwrite = false) {
    const entries = (await this.listMemories()).filter(item => item.source === 'serena'), imported = [], skipped = [];
    for (const entry of entries) {
      if (!overwrite) { try { await this.readMemory(entry.name, 'codex'); skipped.push(entry.name); continue; } catch (error) { if (error.code !== 'MEMORY_NOT_FOUND') throw error; } }
      await this.writeMemory(entry.name, (await this.readMemory(entry.name, 'serena')).content); imported.push(entry.name);
    }
    return { imported, skipped, serena_files_modified: false };
  }
  async close() { for (const backend of this.backends.values()) await backend.close(); this.backends.clear(); }
}
