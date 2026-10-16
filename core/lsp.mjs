import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import { EventEmitter } from 'node:events';
import { hash, within, fail } from './files.mjs';

const LANGUAGE = { '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.java': 'java', '.rb': 'ruby', '.php': 'php' };
export class LspBackend {
  constructor(root, config, language) {
    this.root = root; this.config = config; this.language = language;
    this.pending = new Map(); this.opened = new Map(); this.diagnosticsCache = new Map();
    this.events = new EventEmitter(); this.id = 0; this.buffer = Buffer.alloc(0); this.stderr = '';
  }
  async start(signal) {
    this.child = spawn(this.config.command, this.config.args ?? [], { cwd: this.root, env: { ...process.env, ...this.config.env }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', data => { try { this.receive(data); } catch (error) { this.terminate(error); } });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-8192); });
    this.child.stdin.on('error', error => this.terminate(error));
    this.child.on('error', error => this.terminate(Object.assign(new Error('Cannot start ' + this.config.command + ': ' + error.message + '. Configure languageServers in the host plugin configuration.'), { code: 'LANGUAGE_SERVER_UNAVAILABLE' })));
    this.child.on('exit', () => this.terminate(Object.assign(new Error('Language server exited. ' + this.stderr.slice(-1000)), { code: 'LANGUAGE_SERVER_EXITED' })));
    const result = await this.request('initialize', {
      processId: process.pid, rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: this.root.split(/[\\/]/).at(-1) }],
      clientInfo: { name: 'codex-ide-bridge', version: '1.1.0' },
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true } },
        textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, publishDiagnostics: { versionSupport: true }, rename: { prepareSupport: false } },
      }, initializationOptions: this.config.initializationOptions ?? {},
    }, signal);
    this.capabilities = result.capabilities ?? {};
    if (this.capabilities.positionEncoding && this.capabilities.positionEncoding !== 'utf-16') fail('UNSUPPORTED_POSITION_ENCODING', 'Server selected a non-UTF-16 position encoding.');
    this.notify('initialized', {});
    this.notify('workspace/didChangeConfiguration', { settings: this.settings() });
  }
  settings() { return { python: { analysis: { diagnosticMode: 'workspace', autoSearchPaths: true, typeCheckingMode: 'basic' }, ...this.config.settings?.python }, ...this.config.settings }; }
  send(message) {
    if (this.dead) throw this.dead;
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params, signal, timeoutMs = this.config.timeoutMs ?? 30000) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Request cancelled.'), { code: 'ABORTED' }));
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const abort = () => { cleanup(); try { this.notify('$/cancelRequest', { id }); } catch {} reject(Object.assign(new Error('Language server request cancelled: ' + method), { code: 'ABORTED' })); };
      const timer = setTimeout(() => { cleanup(); try { this.notify('$/cancelRequest', { id }); } catch {} reject(Object.assign(new Error('Language server timed out: ' + method), { code: 'LSP_TIMEOUT' })); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) { cleanup(); reject(error); }
    });
  }
  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > 32 * 1024 * 1024) fail('LSP_PROTOCOL_ERROR', 'Language server response exceeded 32 MiB.');
    while (true) {
      const end = this.buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const size = Number(this.buffer.subarray(0, end).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024) fail('LSP_PROTOCOL_ERROR', 'Invalid language server Content-Length.');
      if (this.buffer.length < end + 4 + size) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + size).toString('utf8'));
      this.buffer = this.buffer.subarray(end + 4 + size); this.handle(message);
    }
  }
  handle(message) {
    if (!message.method) {
      const pending = this.pending.get(message.id); if (!pending) return;
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: 'LSP_ERROR', lspCode: message.error.code }));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      let result = null;
      if (message.method === 'workspace/configuration') result = (message.params?.items ?? []).map(item => {
        let value = this.settings(); for (const segment of (item.section ?? '').split('.').filter(Boolean)) value = value?.[segment]; return value ?? null;
      });
      else if (message.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.root).href, name: 'project' }];
      else if (message.method === 'workspace/applyEdit') result = { applied: false, failureReason: 'Edits require an explicit Codex tool call.' };
      this.send({ jsonrpc: '2.0', id: message.id, result });
    } else if (message.method === 'textDocument/publishDiagnostics') {
      this.diagnosticsCache.set(message.params.uri, { version: message.params.version, diagnostics: message.params.diagnostics ?? [] });
      this.events.emit('diagnostics', message.params.uri);
    }
  }
  terminate(error) {
    if (this.dead) return; this.dead = error;
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.events.emit('closed');
  }
  async sync(path) {
    const uri = pathToFileURL(path).href, text = await readFile(path, 'utf8'), digest = hash(text);
    const previous = this.opened.get(uri);
    if (previous?.hash === digest) return uri;
    const version = (previous?.version ?? 0) + 1;
    this.opened.set(uri, { hash: digest, version }); this.diagnosticsCache.delete(uri);
    if (!previous) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: LANGUAGE[extname(path)] ?? this.language, version, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    return uri;
  }
  async symbols(path, signal) {
    const uri = await this.sync(path), raw = await this.request('textDocument/documentSymbol', { textDocument: { uri } }, signal);
    const result = [];
    const visit = (items, parent = '') => {
      for (const item of items ?? []) {
        const name_path = parent ? parent + '/' + item.name : item.name;
        const range = item.range ?? item.location?.range;
        if (!range) continue;
        result.push({ name: item.name, name_path, kind: item.kind, path, range, selectionRange: item.selectionRange ?? range });
        visit(item.children, name_path);
      }
    };
    visit(raw); return result;
  }
  async locations(path, position, operation, signal) {
    const uri = await this.sync(path);
    const method = { references: 'textDocument/references', definition: 'textDocument/definition', implementations: 'textDocument/implementation' }[operation];
    if (operation === 'implementations' && !this.capabilities.implementationProvider) fail('UNSUPPORTED_OPERATION', 'This language server does not advertise implementation lookup.');
    const raw = await this.request(method, { textDocument: { uri }, position, ...(operation === 'references' ? { context: { includeDeclaration: true } } : {}) }, signal);
    return (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap(item => {
      const locationUri = item.uri ?? item.targetUri;
      if (!locationUri?.startsWith('file:')) return [];
      const target = fileURLToPath(locationUri);
      return within(this.root, target) ? [{ path: target, range: item.range ?? item.targetSelectionRange ?? item.targetRange }] : [];
    });
  }
  async rename(path, position, newName, signal) {
    const uri = await this.sync(path);
    if (!this.capabilities.renameProvider) fail('UNSUPPORTED_OPERATION', 'This language server does not advertise rename support.');
    const edit = await this.request('textDocument/rename', { textDocument: { uri }, position, newName }, signal);
    const changes = new Map();
    const add = (uri, edits, version) => {
      if (!uri.startsWith('file:')) fail('INVALID_EDIT', 'Only local file text edits are supported.');
      const path = fileURLToPath(uri);
      if (!within(this.root, path)) fail('OUTSIDE_WORKSPACE', 'Language server rename leaves the project.');
      if (version != null && this.opened.get(uri)?.version !== version) fail('STALE_DOCUMENT', 'Language server edit version is stale.');
      if (!changes.has(path)) changes.set(path, []);
      changes.get(path).push(...edits.map(item => ({ range: item.range, newText: item.newText })));
    };
    for (const [uri, edits] of Object.entries(edit?.changes ?? {})) add(uri, edits);
    for (const item of edit?.documentChanges ?? []) {
      if (item.kind || !item.textDocument) fail('UNSUPPORTED_EDIT', 'File creation/deletion/move in WorkspaceEdit is not supported; no changes applied.');
      add(item.textDocument.uri, item.edits, item.textDocument.version);
    }
    return changes;
  }
  async hover(path, position, signal) { const uri = await this.sync(path); return await this.request('textDocument/hover', { textDocument: { uri }, position }, signal); }
  async diagnostics(path, signal) {
    const uri = await this.sync(path), current = this.opened.get(uri);
    if (!this.diagnosticsCache.has(uri)) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.events.off('diagnostics', arrived); signal?.removeEventListener('abort', done); resolve(); };
      const arrived = target => { if (target === uri) done(); };
      const timer = setTimeout(done, 3000); this.events.on('diagnostics', arrived); signal?.addEventListener('abort', done, { once: true });
    });
    const published = this.diagnosticsCache.get(uri);
    if (!published || (published.version != null && published.version !== current.version)) return { pending: true, diagnostics: [] };
    return { pending: false, diagnostics: published.diagnostics.map(item => ({ code: item.code, range: item.range, message: item.message, severity: ({ 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' })[item.severity] ?? 'information' })) };
  }
  async close() {
    if (!this.child) return;
    try { if (!this.dead) { await this.request('shutdown', null, undefined, 1500); this.notify('exit'); } } catch {}
    if (this.child.exitCode == null && this.child.signalCode == null) {
      await Promise.race([new Promise(res => this.child.once('exit', res)), new Promise(res => setTimeout(res, 1000))]);
      if (this.child.exitCode == null && this.child.signalCode == null) this.child.kill();
    }
    this.terminate(Object.assign(new Error('Language server closed.'), { code: 'LSP_CLOSED' }));
  }
}
