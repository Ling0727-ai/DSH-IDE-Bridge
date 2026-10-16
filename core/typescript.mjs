import ts from 'typescript';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFiles, slash, within, fail, positionAt, offsetAt, hash } from './files.mjs';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const KIND = { class: 5, interface: 11, method: 6, function: 12, const: 14, let: 13, var: 13, property: 7, enum: 10, module: 2, constructor: 9, type: 26, alias: 13 };
export class TypeScriptBackend {
  constructor(root) { this.root = root; this.service = undefined; this.epoch = 0; }
  async refresh() {
    const scan = await scanFiles(this.root, { extensions: EXTENSIONS });
    this.truncated = scan.truncated;
    let options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true, checkJs: true, jsx: ts.JsxEmit.ReactJSX, strict: true, noEmit: true };
    const config = ts.findConfigFile(this.root, ts.sys.fileExists, 'tsconfig.json') ?? ts.findConfigFile(this.root, ts.sys.fileExists, 'jsconfig.json');
    let files = scan.files;
    if (config && within(this.root, config)) {
      const parsed = ts.readConfigFile(config, ts.sys.readFile);
      if (parsed.error) fail('INVALID_TSCONFIG', ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
      const result = ts.parseJsonConfigFileContent(parsed.config, ts.sys, dirname(config));
      options = { ...options, ...result.options, noEmit: true };
      const allowed = new Set(scan.files.map(slash));
      files = result.fileNames.filter(path => within(this.root, path) && allowed.has(slash(path)));
    }
    this.files = files; this.options = options; this.epoch++;
    if (!this.service) {
      const lib = ts.getDefaultLibFilePath(this.options);
      const host = {
        getScriptFileNames: () => this.files,
        getScriptVersion: path => { try { const st = statSync(path); return st.mtimeMs + ':' + st.size + ':' + this.epoch; } catch { return '-1'; } },
        getProjectVersion: () => String(this.epoch),
        getCompilationSettings: () => this.options,
        getScriptSnapshot: path => { try { return ts.ScriptSnapshot.fromString(readFileSync(path, 'utf8')); } catch { return undefined; } },
        getCurrentDirectory: () => this.root,
        getDefaultLibFileName: () => join(dirname(lib), ts.getDefaultLibFileName(this.options)),
        fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories, realpath: ts.sys.realpath,
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames, getNewLine: () => '\n',
      };
      this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    }
  }
  source(path) {
    const source = this.service.getProgram()?.getSourceFile(path);
    if (!source) fail('FILE_NOT_IN_PROJECT', 'The source file is excluded from tsconfig/jsconfig or not supported: ' + path);
    return source;
  }
  symbols(path) {
    const source = this.source(path), text = source.text, result = [];
    const add = (node, parent, name, kind) => {
      if (!name) return parent;
      const name_path = parent ? parent + '/' + name : name;
      const start = node.getStart(source), end = node.getEnd(), named = node.name;
      result.push({ name, name_path, kind, path, range: { start: positionAt(text, start), end: positionAt(text, end) }, selectionRange: { start: positionAt(text, named?.getStart?.(source) ?? start), end: positionAt(text, named?.getEnd?.() ?? start) } });
      return name_path;
    };
    const visit = (node, parent = '') => {
      let current = parent;
      const name = node.name?.getText(source);
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) current = add(node, parent, name, 5);
      else if (ts.isInterfaceDeclaration(node)) current = add(node, parent, name, 11);
      else if (ts.isFunctionDeclaration(node)) current = add(node, parent, name, 12);
      else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) current = add(node, parent, name, 6);
      else if (ts.isConstructorDeclaration(node)) current = add(node, parent, 'constructor', 9);
      else if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) current = add(node, parent, name, 7);
      else if (ts.isEnumDeclaration(node)) current = add(node, parent, name, 10);
      else if (ts.isTypeAliasDeclaration(node)) current = add(node, parent, name, 26);
      else if (ts.isModuleDeclaration(node)) current = add(node, parent, name, 2);
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        // Replace a complete single variable statement, not a dangling initializer.
        const list = node.parent, statement = list?.parent;
        const rangeNode = ts.isVariableStatement(statement) && list.declarations.length === 1 ? statement : node;
        current = add(rangeNode, parent, name, 13);
        result.at(-1).selectionRange = { start: positionAt(text, node.name.getStart(source)), end: positionAt(text, node.name.getEnd()) };
      }
      ts.forEachChild(node, child => visit(child, current));
    };
    visit(source); return result;
  }
  locations(path, position, operation) {
    const source = this.source(path), offset = offsetAt(source.text, position);
    let raw;
    if (operation === 'references') raw = this.service.findReferences(path, offset)?.flatMap(group => group.references) ?? [];
    else if (operation === 'implementations') raw = this.service.getImplementationAtPosition(path, offset) ?? [];
    else raw = this.service.getDefinitionAtPosition(path, offset) ?? [];
    return raw.filter(loc => within(this.root, loc.fileName)).map(loc => {
      const text = readFileSync(loc.fileName, 'utf8');
      return { path: loc.fileName, range: { start: positionAt(text, loc.textSpan.start), end: positionAt(text, loc.textSpan.start + loc.textSpan.length) }, is_definition: Boolean(loc.isDefinition) };
    });
  }
  rename(path, position, newName) {
    const offset = offsetAt(this.source(path).text, position);
    if (!ts.isIdentifierText(newName, ts.ScriptTarget.Latest)) fail('INVALID_NAME', 'Expected a valid JavaScript/TypeScript identifier.');
    const info = this.service.getRenameInfo(path, offset, { allowRenameOfImportPath: false });
    if (!info.canRename) fail('RENAME_UNSUPPORTED', info.localizedErrorMessage ?? 'Cannot rename this symbol.');
    const locations = this.service.findRenameLocations(path, offset, false, false, true) ?? [];
    const changes = new Map();
    for (const loc of locations) {
      if (!within(this.root, loc.fileName)) fail('OUTSIDE_WORKSPACE', 'Rename would change a file outside the project.');
      if (!changes.has(loc.fileName)) changes.set(loc.fileName, []);
      const text = readFileSync(loc.fileName, 'utf8');
      changes.get(loc.fileName).push({ start: loc.textSpan.start, end: loc.textSpan.start + loc.textSpan.length, newText: (loc.prefixText ?? '') + newName + (loc.suffixText ?? ''), expectedHash: hash(text) });
    }
    return changes;
  }
  diagnostics(path) {
    const source = this.source(path);
    return [...this.service.getSyntacticDiagnostics(path), ...this.service.getSemanticDiagnostics(path)].map(item => ({
      code: item.code, severity: item.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
      message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
      range: { start: positionAt(source.text, item.start ?? 0), end: positionAt(source.text, (item.start ?? 0) + (item.length ?? 0)) },
    }));
  }
  hover(path, position) { const info = this.service.getQuickInfoAtPosition(path, offsetAt(this.source(path).text, position)); return { text: info ? ts.displayPartsToString(info.displayParts) : '', documentation: info ? ts.displayPartsToString(info.documentation) : '' }; }
  async close() { this.service?.dispose(); this.service = undefined; }
}
