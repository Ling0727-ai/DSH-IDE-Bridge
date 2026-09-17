const ANY_JSON_OUTPUT = {}
const DEFAULT_MAX_RENDER_CHARS = 12_000

export function createIdeTools(client, options = {}) {
  const maxRenderChars = options.maxRenderChars ?? DEFAULT_MAX_RENDER_CHARS
  const request = (method, args, exec) => client.request(method, args, exec?.signal, selectionContext(args, exec))

  return [
    tool({
      name: 'ide_status',
      description: 'Check the IDE connection and report the selected IDE instance, workspace folders, and active editor.',
      properties: {},
      required: [],
      execute: (_args, exec) => request('status', {}, exec),
      render: renderStatus,
      maxRenderChars,
    }),
    tool({
      name: 'ide_context',
      description: 'Read compact active-editor context: file, language, cursor/selection, selected text, and optional nearby source.',
      properties: {
        include_text: { type: 'boolean', description: 'Include text around the active selection. Defaults to false.' },
        max_chars: { type: 'integer', minimum: 1, maximum: 50000, description: 'Maximum nearby text characters. Defaults to 2000.' },
      },
      required: [],
      execute: (args, exec) => request('context', camelArgs({ max_chars: 2_000, ...args }), exec),
      render: renderContext,
      maxRenderChars,
    }),
    tool({
      name: 'ide_open',
      description: 'Open a workspace file in the IDE and optionally reveal a one-based line and column.',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
        line: { type: 'integer', minimum: 1, description: 'One-based line to reveal.' },
        column: { type: 'integer', minimum: 1, description: 'One-based UTF-16 column to reveal.' },
        preview: { type: 'boolean', description: 'Open as a preview editor. Defaults to false.' },
        preserve_focus: { type: 'boolean', description: 'Keep focus in the current editor. Defaults to false.' },
      },
      required: ['path'],
      execute: (args, exec) => request('open', camelArgs(args), exec),
      render: renderEditor,
      maxRenderChars,
    }),
    tool({
      name: 'ide_diagnostics',
      description: 'Read compact live IDE diagnostics, optionally limited to one file. Defaults to errors and warnings to avoid low-value output.',
      properties: {
        path: { type: 'string', description: 'Optional workspace-relative or absolute file path.' },
        severity: { type: 'string', enum: ['error', 'warning', 'information', 'hint'], description: 'Minimum severity. Defaults to warning.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum diagnostics. Defaults to 100.' },
      },
      required: [],
      execute: (args, exec) => request('diagnostics', { severity: 'warning', limit: 100, ...args }, exec),
      render: renderDiagnostics,
      maxRenderChars,
    }),
    tool({
      name: 'ide_symbols',
      description: 'Use the IDE language service for compact document/workspace symbols, definitions, references, implementations, or hover information.',
      properties: {
        operation: { type: 'string', enum: ['documentSymbols', 'workspaceSymbols', 'definition', 'references', 'implementations', 'hover'] },
        path: { type: 'string', description: 'File path for all operations except workspaceSymbols.' },
        query: { type: 'string', description: 'Symbol query for workspaceSymbols.' },
        line: { type: 'integer', minimum: 1, description: 'One-based line for position-based operations.' },
        column: { type: 'integer', minimum: 1, description: 'One-based UTF-16 column for position-based operations.' },
        include_declaration: { type: 'boolean', description: 'Include the declaration in reference results. Defaults to true.' },
        include_low_value: { type: 'boolean', description: 'Include imports, parameters, properties, and other low-level symbols. Defaults to false.' },
        depth: { type: 'integer', minimum: 0, maximum: 20, description: 'Document-symbol child depth. Defaults to 0.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum returned entries. Defaults to 50.' },
      },
      required: ['operation'],
      execute: (args, exec) => request('symbols', camelArgs({ depth: 0, limit: 50, include_low_value: false, ...args }), exec),
      render: renderSymbols,
      maxRenderChars,
    }),
    tool({
      name: 'ide_edit',
      description: 'Apply a safe IDE workspace edit. exactReplace requires an exact old_text match; symbol operations use the language-service symbol tree.',
      properties: {
        operation: { type: 'string', enum: ['exactReplace', 'replaceSymbol', 'insertBeforeSymbol', 'insertAfterSymbol'] },
        path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
        old_text: { type: 'string', description: 'Exact source text to replace for exactReplace.' },
        new_text: { type: 'string', description: 'Replacement or insertion text.' },
        symbol: { type: 'string', description: 'Slash-delimited symbol path such as ClassName/methodName.' },
        replace_all: { type: 'boolean', description: 'Replace every exact match. Defaults to false and requires exactly one match.' },
        save: { type: 'boolean', description: 'Save the document after editing. Defaults to true.' },
      },
      required: ['operation', 'path', 'new_text'],
      execute: (args, exec) => request('edit', camelArgs(args), exec),
      render: renderMutation,
      maxRenderChars,
    }),
    tool({
      name: 'ide_rename_symbol',
      description: 'Rename the symbol at a precise IDE cursor position through the language refactoring provider, then optionally save affected files.',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
        line: { type: 'integer', minimum: 1, description: 'One-based line on the symbol.' },
        column: { type: 'integer', minimum: 1, description: 'One-based UTF-16 column on the symbol.' },
        new_name: { type: 'string', description: 'New symbol name.' },
        save: { type: 'boolean', description: 'Save affected files after renaming. Defaults to true.' },
      },
      required: ['path', 'line', 'column', 'new_name'],
      execute: (args, exec) => request('rename', camelArgs(args), exec),
      render: renderMutation,
      maxRenderChars,
    }),
    tool({
      name: 'ide_command',
      description: 'Execute an IDE command only when it is present in the extension allowlist. Useful for formatting, saving, navigation, and IDE UI actions.',
      properties: {
        command: { type: 'string', description: 'VS Code command identifier.' },
        arguments: { type: 'array', items: {}, description: 'Optional JSON arguments passed to the command.' },
      },
      required: ['command'],
      execute: (args, exec) => request('command', args, exec),
      maxRenderChars,
    }),
  ]
}

function tool({ name, description, properties, required, execute, render = renderValue, maxRenderChars }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties,
      required,
    },
    output: {
      schema: ANY_JSON_OUTPUT,
      render: (args, value) => [{ type: 'text', text: truncate(render(args, value), maxRenderChars) }],
    },
    execute,
  }
}

function selectionContext(args, exec) {
  const header = exec?.agent?.session?.header
  return {
    sessionId: header?.id,
    workspaceRoot: header?.cwd,
    requestPath: args?.path,
  }
}

function camelArgs(args) {
  const result = {}
  for (const [key, value] of Object.entries(args ?? {})) {
    const camel = key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase())
    result[camel] = value
  }
  return result
}

function renderStatus(_args, value) {
  const folders = value?.workspaceFolders?.join(', ') || '(no workspace)'
  const active = value?.activeEditor ? ` | active: ${editorLine(value.activeEditor)}` : ''
  return `${value?.ide ?? 'IDE'} ${value?.ideVersion ?? ''} | workspace: ${folders}${active}`.trim()
}

function renderEditor(_args, value) {
  return editorLine(value)
}

function renderContext(_args, value) {
  if (!value || value.activeEditor === null) return 'No active editor.'
  const lines = [editorLine(value)]
  const selection = value.selection ?? value.selections?.[0]
  if (selection) lines.push(`selection: ${formatRange(selection)}`)
  const selectedText = value.selectedText ?? selection?.text
  if (selectedText) lines.push(`selected:\n${selectedText}`)
  if (value.nearbyText?.text) lines.push(`nearby ${formatRange(value.nearbyText.range)}:\n${value.nearbyText.text}`)
  return lines.join('\n')
}

function renderDiagnostics(args, value) {
  const diagnostics = Array.isArray(value?.diagnostics) ? value.diagnostics : []
  const useful = diagnostics.filter(item => item?.message || item?.severity === 'error' || item?.severity === 'warning')
  if (useful.length === 0) return `No diagnostics at severity ${args?.severity ?? 'warning'} or higher.`
  const lines = useful.map(item => {
    const marker = { error: 'E', warning: 'W', information: 'I', hint: 'H' }[item.severity] ?? '?'
    const start = item.range?.start
    const position = start ? `:${start.line}:${start.column ?? start.character ?? 1}` : ''
    const source = item.source ? ` [${item.source}]` : ''
    return `${marker} ${item.path ?? ''}${position} ${item.message ?? ''}${source}`.trimEnd()
  })
  const omitted = diagnostics.length - useful.length
  if (omitted > 0) lines.push(`… omitted ${omitted} diagnostics without actionable messages`)
  if (value?.truncated) lines.push('… result truncated by limit')
  return lines.join('\n')
}

function renderSymbols(args, value) {
  if (Array.isArray(value?.symbols)) {
    const symbols = args?.include_low_value ? value.symbols : value.symbols.filter(symbol => !isLowValueRenderedKind(symbol.kind))
    if (symbols.length === 0) return 'No high-value symbols found. Pass include_low_value: true for the complete list.'
    const lines = symbols.map(symbol => {
      const location = symbol.location ?? symbol
      const name = compactNamePath(symbol.namePath ?? symbol.name ?? '(anonymous)', location.path)
      const kind = compactKind(symbol.kind)
      return `${kind} ${name} — ${formatLocation(location)}`
    })
    const omitted = value.symbols.length - symbols.length
    if (omitted > 0) lines.push(`… omitted ${omitted} low-value symbols`)
    if (value.truncated) lines.push('… result truncated by limit')
    return lines.join('\n')
  }
  if (Array.isArray(value?.locations)) {
    if (value.locations.length === 0) return 'No locations found.'
    const lines = value.locations.map(formatLocation)
    if (value.truncated) lines.push('… result truncated by limit')
    return lines.join('\n')
  }
  if (Array.isArray(value?.hovers)) {
    return value.hovers.flatMap(item => item.contents ?? []).join('\n') || 'No hover information.'
  }
  return renderValue(args, value)
}

function renderMutation(_args, value) {
  const state = value?.applied === false ? 'not applied' : 'applied'
  const details = [value?.operation, value?.path, value?.newName && `→ ${value.newName}`, value?.editCount && `${value.editCount} edit(s)`, value?.saved && 'saved']
    .filter(Boolean)
    .join(' | ')
  const diagnostics = renderDiagnostics({ severity: 'warning' }, { diagnostics: value?.diagnostics ?? [] })
  return `${state}${details ? ` | ${details}` : ''}${diagnostics.startsWith('No diagnostics') ? '' : `\n${diagnostics}`}`
}

function editorLine(value) {
  if (!value) return 'No active editor.'
  const caret = value.caret ?? value.selection?.start
  const position = caret ? `:${caret.line}:${caret.column ?? caret.character ?? 1}` : ''
  const flags = [value.languageId, value.dirty ? 'dirty' : undefined, value.lineCount && `${value.lineCount} lines`].filter(Boolean).join(', ')
  return `${value.path ?? value.uri ?? '(unknown file)'}${position}${flags ? ` (${flags})` : ''}`
}

function formatLocation(value) {
  if (!value) return '(unknown location)'
  const location = value.location ?? value
  const start = location.range?.start
  const end = location.range?.end
  if (!start) return location.path ?? location.uri ?? '(unknown location)'
  const startColumn = start.column ?? start.character ?? 1
  const endPart = end && end.line !== start.line ? `-${end.line}` : ''
  return `${location.path ?? location.uri ?? '(unknown)'}:${start.line}:${startColumn}${endPart}`
}

function formatRange(value) {
  if (!value) return '(unknown range)'
  const start = value.start ?? value.anchor
  const end = value.end ?? value.active
  if (!start) return '(unknown range)'
  const startColumn = start.column ?? start.character ?? 1
  const endColumn = end?.column ?? end?.character ?? startColumn
  return `${start.line}:${startColumn}-${end?.line ?? start.line}:${endColumn}`
}

function isLowValueRenderedKind(kind) {
  const value = String(kind ?? '').toLowerCase()
  return ['import', 'binding', 'specifier', 'parameter', 'property', 'field', 'reference', 'definitionexpression', 'literal']
    .some(fragment => value.includes(fragment))
}

function compactNamePath(namePath, filePath) {
  if (!filePath || (!namePath.includes(':/') && !namePath.startsWith('/'))) return namePath
  const normalizedName = namePath.replaceAll('\\', '/')
  const normalizedFile = filePath.replaceAll('\\', '/')
  const index = normalizedName.toLowerCase().lastIndexOf(normalizedFile.toLowerCase())
  if (index < 0) return namePath
  return normalizedName.slice(index + normalizedFile.length).replace(/^\/+/, '') || namePath
}

function compactKind(kind) {
  if (!kind) return 'symbol'
  return String(kind)
    .replace(/^(ES6|JS|Psi)/, '')
    .replace(/(Impl|Element)$/, '')
    .toLowerCase()
}

function renderValue(_args, value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n… omitted ${text.length - maxChars} characters`
}
