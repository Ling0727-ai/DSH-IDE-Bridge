const vscode = require('vscode')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')

const MAX_REQUEST_BYTES = 1024 * 1024
const HEARTBEAT_MS = 5_000

class RequestError extends Error {
  constructor(message, code = 'IDE_REQUEST_FAILED', details) {
    super(message)
    this.code = code
    this.details = details
  }
}

class IdeBridgeServer {
  constructor(context) {
    this.context = context
    this.server = undefined
    this.discoveryFile = undefined
    this.heartbeat = undefined
    this.token = crypto.randomBytes(32).toString('base64url')
  }

  async start() {
    if (this.server) return this.info()

    const config = vscode.workspace.getConfiguration('dshIdeBridge')
    const configuredPort = config.get('port', 0)
    this.server = net.createServer(socket => this.handleSocket(socket))
    this.server.on('error', error => {
      void vscode.window.showErrorMessage(`DSH IDE Bridge failed: ${error.message}`)
    })

    await new Promise((resolve, reject) => {
      const onError = error => reject(error)
      this.server.once('error', onError)
      this.server.listen({ host: '127.0.0.1', port: configuredPort }, () => {
        this.server.off('error', onError)
        resolve()
      })
    })

    await this.writeDiscovery()
    this.heartbeat = setInterval(() => {
      void this.writeDiscovery().catch(error => {
        void vscode.window.showErrorMessage(`DSH IDE Bridge discovery update failed: ${error.message}`)
      })
    }, HEARTBEAT_MS)
    return this.info()
  }

  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined

    const server = this.server
    this.server = undefined
    if (server) await new Promise(resolve => server.close(resolve))
    if (this.discoveryFile) await fs.unlink(this.discoveryFile).catch(() => {})
    this.discoveryFile = undefined
  }

  async restart() {
    await this.stop()
    this.token = crypto.randomBytes(32).toString('base64url')
    return await this.start()
  }

  info() {
    const address = this.server?.address()
    return {
      connected: Boolean(this.server),
      host: typeof address === 'object' && address ? address.address : undefined,
      port: typeof address === 'object' && address ? address.port : undefined,
      discoveryFile: this.discoveryFile,
      workspaceFolders: workspaceFolderPaths(),
    }
  }

  async writeDiscovery() {
    if (!this.server) return
    const config = vscode.workspace.getConfiguration('dshIdeBridge')
    const configuredDirectory = config.get('discoveryDirectory', '').trim()
    const directory = configuredDirectory || path.join(os.tmpdir(), 'dsh-ide-bridge')
    await fs.mkdir(directory, { recursive: true })

    const file = path.join(directory, `${process.pid}.json`)
    const temporary = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`
    const address = this.server.address()
    const record = {
      protocolVersion: 1,
      pid: process.pid,
      ide: vscode.env.appName,
      ideVersion: vscode.version,
      host: '127.0.0.1',
      port: typeof address === 'object' && address ? address.port : undefined,
      token: this.token,
      workspaceFolders: workspaceFolderPaths(),
      startedAt: this.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.startedAt = record.startedAt

    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, file)
    this.discoveryFile = file
  }

  handleSocket(socket) {
    socket.setEncoding('utf8')
    let buffer = ''
    let bytes = 0
    let handled = false

    socket.on('data', chunk => {
      if (handled) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_REQUEST_BYTES) {
        handled = true
        this.writeError(socket, undefined, new RequestError('Request is too large.', 'IDE_REQUEST_TOO_LARGE'))
        return
      }
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      void this.handleMessage(socket, buffer.slice(0, newline))
    })
    socket.on('error', () => {})
  }

  async handleMessage(socket, raw) {
    let request
    try {
      request = JSON.parse(raw)
      if (!safeTokenEqual(request.token, this.token)) throw new RequestError('Invalid bridge token.', 'IDE_UNAUTHORIZED')
      if (typeof request.method !== 'string') throw new RequestError('A method is required.', 'IDE_INVALID_REQUEST')
      const result = await dispatch(request.method, request.params ?? {})
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: jsonSafe(result) })}\n`)
    } catch (error) {
      this.writeError(socket, request?.id, error)
    }
  }

  writeError(socket, id, error) {
    socket.end(`${JSON.stringify({
      id,
      ok: false,
      error: {
        code: error?.code ?? 'IDE_REQUEST_FAILED',
        message: error?.message ?? String(error),
        ...(error?.details === undefined ? {} : { details: jsonSafe(error.details) }),
      },
    })}\n`)
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'status': return status()
    case 'context': return context(params)
    case 'open': return openFile(params)
    case 'diagnostics': return diagnostics(params)
    case 'symbols': return symbols(params)
    case 'edit': return edit(params)
    case 'rename': return renameSymbol(params)
    case 'command': return executeCommand(params)
    default: throw new RequestError(`Unknown IDE method: ${method}`, 'IDE_METHOD_NOT_FOUND')
  }
}

function status() {
  const editor = vscode.window.activeTextEditor
  return {
    connected: true,
    ide: vscode.env.appName,
    ideVersion: vscode.version,
    workspaceFolders: workspaceFolderPaths(),
    activeEditor: editor ? editorSummary(editor) : null,
  }
}

async function context(params) {
  const editor = vscode.window.activeTextEditor
  if (!editor) return { activeEditor: null }

  const result = editorSummary(editor)
  result.selections = editor.selections.map(selection => ({
    anchor: position(selection.anchor),
    active: position(selection.active),
    start: position(selection.start),
    end: position(selection.end),
    text: editor.document.getText(selection),
  }))
  result.visibleRanges = editor.visibleRanges.map(range)

  if (params.includeText) {
    const maxChars = boundedInteger(params.maxChars, 2_000, 1, 50_000)
    const selection = editor.selection
    const document = editor.document
    const center = document.offsetAt(selection.active)
    const start = Math.max(0, center - Math.floor(maxChars / 2))
    const end = Math.min(document.getText().length, start + maxChars)
    result.nearbyText = {
      range: range(new vscode.Range(document.positionAt(start), document.positionAt(end))),
      text: document.getText(new vscode.Range(document.positionAt(start), document.positionAt(end))),
    }
  }
  return result
}

async function openFile(params) {
  const uri = resolveFile(params.path)
  const document = await vscode.workspace.openTextDocument(uri)
  const line = Math.max(0, (params.line ?? 1) - 1)
  const column = Math.max(0, (params.column ?? 1) - 1)
  const target = new vscode.Position(Math.min(line, Math.max(0, document.lineCount - 1)), column)
  const editor = await vscode.window.showTextDocument(document, {
    preview: params.preview ?? false,
    preserveFocus: params.preserveFocus ?? false,
    selection: new vscode.Range(target, target),
  })
  editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  return editorSummary(editor)
}

async function diagnostics(params) {
  const threshold = severityThreshold(params.severity)
  const limit = boundedInteger(params.limit, 100, 1, 1_000)
  let groups
  if (params.path) {
    const uri = resolveFile(params.path)
    groups = [[uri, vscode.languages.getDiagnostics(uri)]]
  } else {
    groups = vscode.languages.getDiagnostics()
  }

  const items = []
  for (const [uri, entries] of groups) {
    for (const diagnostic of entries) {
      if (diagnostic.severity > threshold) continue
      items.push({
        path: displayPath(uri),
        severity: severityName(diagnostic.severity),
        message: diagnostic.message,
        range: range(diagnostic.range),
        source: diagnostic.source,
        code: typeof diagnostic.code === 'object' ? diagnostic.code?.value : diagnostic.code,
      })
      if (items.length >= limit) return { diagnostics: items, truncated: true }
    }
  }
  return { diagnostics: items, truncated: false }
}

async function symbols(params) {
  const operation = params.operation
  const limit = boundedInteger(params.limit, 50, 1, 1_000)

  if (operation === 'workspaceSymbols') {
    if (typeof params.query !== 'string') throw invalid('query is required for workspaceSymbols')
    const values = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', params.query) ?? []
    const symbols = values.map(symbolInformation)
    const filtered = params.includeLowValue ? symbols : symbols.filter(symbol => isHighValueSymbolKind(symbol.kind))
    return { symbols: filtered.slice(0, limit), truncated: filtered.length > limit }
  }

  if (typeof params.path !== 'string') throw invalid('path is required for this symbol operation')
  const uri = resolveFile(params.path)
  if (operation === 'documentSymbols') {
    const depth = boundedInteger(params.depth, 0, 0, 20)
    const values = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri) ?? []
    const allSymbols = flattenSymbols(values, depth, uri)
    const filtered = params.includeLowValue ? allSymbols : allSymbols.filter(symbol => isHighValueSymbolKind(symbol.kind))
    return { symbols: filtered.slice(0, limit), truncated: filtered.length > limit }
  }

  const cursor = cursorPosition(params)
  const command = {
    definition: 'vscode.executeDefinitionProvider',
    references: 'vscode.executeReferenceProvider',
    implementations: 'vscode.executeImplementationProvider',
    hover: 'vscode.executeHoverProvider',
  }[operation]
  if (!command) throw invalid(`unsupported symbol operation: ${operation}`)

  if (operation === 'hover') {
    const values = await vscode.commands.executeCommand(command, uri, cursor) ?? []
    return { hovers: values.slice(0, limit).map(hover) }
  }

  const commandArgs = operation === 'references'
    ? [uri, cursor, { includeDeclaration: params.includeDeclaration ?? true }]
    : [uri, cursor]
  const values = await vscode.commands.executeCommand(command, ...commandArgs) ?? []
  const locations = (Array.isArray(values) ? values : [values]).map(location).filter(Boolean)
  return { locations: locations.slice(0, limit), truncated: locations.length > limit }
}

async function edit(params) {
  const uri = resolveFile(params.path)
  const document = await vscode.workspace.openTextDocument(uri)
  const operation = params.operation
  const workspaceEdit = new vscode.WorkspaceEdit()
  let editCount = 0

  if (operation === 'exactReplace') {
    if (typeof params.oldText !== 'string' || params.oldText.length === 0) throw invalid('old_text must be a non-empty string')
    const offsets = allOffsets(document.getText(), params.oldText)
    if (offsets.length === 0) throw new RequestError('old_text was not found; no edit was applied.', 'IDE_EDIT_NO_MATCH')
    if (!(params.replaceAll ?? false) && offsets.length !== 1) {
      throw new RequestError(`old_text matched ${offsets.length} places; no edit was applied.`, 'IDE_EDIT_AMBIGUOUS')
    }
    const selected = params.replaceAll ? offsets : [offsets[0]]
    for (const offset of selected) {
      workspaceEdit.replace(uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + params.oldText.length)), params.newText)
    }
    editCount = selected.length
  } else if (['replaceSymbol', 'insertBeforeSymbol', 'insertAfterSymbol'].includes(operation)) {
    if (typeof params.symbol !== 'string' || !params.symbol.trim()) throw invalid('symbol is required for symbol edits')
    const target = await findDocumentSymbol(uri, params.symbol)
    if (operation === 'replaceSymbol') workspaceEdit.replace(uri, target.range, params.newText)
    if (operation === 'insertBeforeSymbol') workspaceEdit.insert(uri, target.range.start, params.newText)
    if (operation === 'insertAfterSymbol') workspaceEdit.insert(uri, target.range.end, params.newText)
    editCount = 1
  } else {
    throw invalid(`unsupported edit operation: ${operation}`)
  }

  if (!await vscode.workspace.applyEdit(workspaceEdit)) throw new RequestError('The IDE refused the workspace edit.', 'IDE_EDIT_REJECTED')
  const saved = params.save ?? true ? await document.save() : false
  return {
    applied: true,
    operation,
    path: displayPath(uri),
    editCount,
    saved,
    diagnostics: (await diagnostics({ path: uri.fsPath, severity: 'warning', limit: 50 })).diagnostics,
  }
}

async function renameSymbol(params) {
  const uri = resolveFile(params.path)
  const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', uri, cursorPosition(params), params.newName)
  if (!edit) throw new RequestError('No rename provider produced an edit at that position.', 'IDE_RENAME_UNAVAILABLE')
  if (!await vscode.workspace.applyEdit(edit)) throw new RequestError('The IDE refused the rename edit.', 'IDE_EDIT_REJECTED')

  let savedFiles = 0
  if (params.save ?? true) {
    for (const [changedUri] of edit.entries()) {
      const document = await vscode.workspace.openTextDocument(changedUri)
      if (await document.save()) savedFiles += 1
    }
  }
  return { applied: true, newName: params.newName, changedFiles: edit.entries().length, savedFiles }
}

async function executeCommand(params) {
  const allowed = new Set(vscode.workspace.getConfiguration('dshIdeBridge').get('allowedCommands', []))
  if (!allowed.has(params.command)) {
    throw new RequestError(`IDE command is not allowed: ${params.command}`, 'IDE_COMMAND_NOT_ALLOWED')
  }
  const args = Array.isArray(params.arguments) ? params.arguments : []
  const result = await vscode.commands.executeCommand(params.command, ...args)
  return { executed: true, command: params.command, result: jsonSafe(result) }
}

async function findDocumentSymbol(uri, requestedPath) {
  const roots = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri) ?? []
  const candidates = []
  collectSymbolPaths(roots, [], candidates)
  const needle = requestedPath.split('/').filter(Boolean).join('/')
  const matches = candidates.filter(candidate => candidate.namePath === needle || candidate.namePath.endsWith(`/${needle}`))
  if (matches.length === 0) throw new RequestError(`Symbol not found: ${requestedPath}`, 'IDE_SYMBOL_NOT_FOUND')
  if (matches.length > 1) {
    throw new RequestError(`Symbol is ambiguous: ${requestedPath}`, 'IDE_SYMBOL_AMBIGUOUS', { matches: matches.map(item => item.namePath) })
  }
  return matches[0].symbol
}

function collectSymbolPaths(symbols, parents, output) {
  for (const symbol of symbols) {
    if (!symbol.range || !symbol.name) continue
    const parts = [...parents, symbol.name]
    output.push({ namePath: parts.join('/'), symbol })
    if (Array.isArray(symbol.children)) collectSymbolPaths(symbol.children, parts, output)
  }
}

function flattenSymbols(symbols, depth, uri, parents = [], level = 0, output = []) {
  for (const item of symbols) {
    if (item.location) {
      output.push(symbolInformation(item))
      continue
    }
    const parts = [...parents, item.name]
    output.push({
      name: item.name,
      namePath: parts.join('/'),
      detail: item.detail,
      kind: symbolKindName(item.kind),
      path: displayPath(uri),
      range: range(item.range),
      selectionRange: range(item.selectionRange),
    })
    if (level < depth && Array.isArray(item.children)) flattenSymbols(item.children, depth, uri, parts, level + 1, output)
  }
  return output
}

function symbolInformation(item) {
  return {
    name: item.name,
    containerName: item.containerName,
    kind: symbolKindName(item.kind),
    location: location(item.location),
  }
}

function location(value) {
  if (!value) return null
  if (value.uri && value.range) return { path: displayPath(value.uri), range: range(value.range) }
  if (value.targetUri) {
    return {
      path: displayPath(value.targetUri),
      range: range(value.targetSelectionRange ?? value.targetRange),
      originSelectionRange: value.originSelectionRange ? range(value.originSelectionRange) : undefined,
    }
  }
  return null
}

function hover(value) {
  return {
    contents: (value.contents ?? []).map(content => typeof content === 'string' ? content : content.value ?? content.language ? content.value : String(content)),
    range: value.range ? range(value.range) : undefined,
  }
}

function editorSummary(editor) {
  return {
    path: displayPath(editor.document.uri),
    uri: editor.document.uri.toString(),
    languageId: editor.document.languageId,
    version: editor.document.version,
    dirty: editor.document.isDirty,
    lineCount: editor.document.lineCount,
    selection: range(editor.selection),
  }
}

function resolveFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw invalid('path is required')
  const folders = vscode.workspace.workspaceFolders ?? []
  let absolute
  if (path.isAbsolute(filePath)) absolute = path.resolve(filePath)
  else {
    const activeFolder = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
    const root = activeFolder ?? folders[0]
    if (!root) throw new RequestError('Open a workspace folder before using relative IDE paths.', 'IDE_WORKSPACE_REQUIRED')
    absolute = path.resolve(root.uri.fsPath, filePath)
  }

  let canonical
  try {
    canonical = fsSync.realpathSync.native(absolute)
  } catch (error) {
    throw new RequestError(`File not found: ${filePath}`, 'IDE_FILE_NOT_FOUND', { cause: error.message })
  }

  const config = vscode.workspace.getConfiguration('dshIdeBridge')
  const insideWorkspace = folders.some(folder => {
    try {
      return isWithin(canonical, fsSync.realpathSync.native(folder.uri.fsPath))
    } catch {
      return false
    }
  })
  if (!config.get('allowOutsideWorkspace', false) && !insideWorkspace) {
    throw new RequestError(`Path is outside the open workspace: ${filePath}`, 'IDE_PATH_OUTSIDE_WORKSPACE')
  }
  return vscode.Uri.file(canonical)
}

function isWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function displayPath(uri) {
  return vscode.workspace.asRelativePath(uri, false) || uri.fsPath
}

function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
}

function cursorPosition(params) {
  if (!Number.isInteger(params.line) || !Number.isInteger(params.column)) throw invalid('line and column are required integers')
  return new vscode.Position(params.line - 1, params.column - 1)
}

function position(value) {
  return { line: value.line + 1, column: value.character + 1 }
}

function range(value) {
  return { start: position(value.start), end: position(value.end) }
}

function severityThreshold(value) {
  const mapping = { error: 0, warning: 1, information: 2, hint: 3 }
  if (value === undefined) return 1
  if (!(value in mapping)) throw invalid(`unknown severity: ${value}`)
  return mapping[value]
}

function severityName(value) {
  return ['error', 'warning', 'information', 'hint'][value] ?? 'unknown'
}

function isHighValueSymbolKind(kind) {
  return new Set([
    'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Function',
    'Constructor', 'Interface', 'Struct', 'Enum', 'EnumMember', 'TypeParameter',
  ]).has(kind)
}

function symbolKindName(value) {
  return Object.entries(vscode.SymbolKind).find(([, numeric]) => numeric === value)?.[0] ?? String(value)
}

function allOffsets(text, needle) {
  const offsets = []
  let cursor = 0
  while (cursor <= text.length) {
    const index = text.indexOf(needle, cursor)
    if (index < 0) break
    offsets.push(index)
    cursor = index + Math.max(needle.length, 1)
  }
  return offsets
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw invalid(`expected an integer from ${minimum} to ${maximum}`)
  return value
}

function safeTokenEqual(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
}

function jsonSafe(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (item instanceof vscode.Uri) return item.toString()
      if (item instanceof vscode.Position) return position(item)
      if (item instanceof vscode.Range || item instanceof vscode.Selection) return range(item)
      return item
    }))
  } catch {
    return String(value)
  }
}

function invalid(message) {
  return new RequestError(message, 'IDE_INVALID_REQUEST')
}

let bridge

async function activate(extensionContext) {
  bridge = new IdeBridgeServer(extensionContext)
  extensionContext.subscriptions.push(
    vscode.commands.registerCommand('dshIdeBridge.restart', async () => {
      const info = await bridge.restart()
      void vscode.window.showInformationMessage(`DSH IDE Bridge listening on 127.0.0.1:${info.port}`)
    }),
    vscode.commands.registerCommand('dshIdeBridge.showStatus', () => {
      const info = bridge.info()
      void vscode.window.showInformationMessage(info.connected
        ? `DSH IDE Bridge listening on 127.0.0.1:${info.port}`
        : 'DSH IDE Bridge is stopped')
    }),
    { dispose: () => void bridge.stop() },
  )
  await bridge.start()
}

async function deactivate() {
  await bridge?.stop()
}

module.exports = { activate, deactivate }
