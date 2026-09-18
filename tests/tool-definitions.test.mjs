import test from 'node:test'
import assert from 'node:assert/strict'
import { createIdeTools } from '../lib/tool-definitions.js'

test('registers the complete IDE tool surface', () => {
  const tools = createIdeTools({ request: async () => ({ ok: true }) })
  assert.deepEqual(tools.map(tool => tool.name), [
    'ide_status',
    'ide_context',
    'ide_open',
    'ide_diagnostics',
    'ide_symbols',
    'ide_edit',
    'ide_rename_symbol',
    'ide_command',
  ])
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('renders symbols as compact lines instead of verbose JSON', () => {
  const tools = createIdeTools({ request: async () => ({}) })
  const symbolTool = tools.find(tool => tool.name === 'ide_symbols')
  const value = {
    symbols: [{
      name: 'request',
      namePath: 'IdeBridgeClient/request',
      kind: 'JSFunctionImpl',
      path: 'lib/bridge-client.js',
      range: { start: { line: 78, column: 3 }, end: { line: 156, column: 4 } },
      selectionRange: { start: { line: 78, column: 9 }, end: { line: 78, column: 16 } },
    }],
    truncated: false,
  }
  const rendered = symbolTool.output.render({}, value)[0].text
  assert.equal(rendered, 'function IdeBridgeClient/request — lib/bridge-client.js:78:3-156')
  assert.ok(rendered.length < JSON.stringify(value, null, 2).length / 3)
})

test('filters local variables and anonymous function expressions by default', () => {
  const tools = createIdeTools({ request: async () => ({}) })
  const symbolTool = tools.find(tool => tool.name === 'ide_symbols')
  const value = {
    symbols: [
      { name: 'DEFAULT_LIMIT', namePath: 'DEFAULT_LIMIT', kind: 'JSVariableImpl', path: 'src/app.js', range: { start: { line: 1, column: 7 } } },
      { name: 'run', namePath: 'Controller/run', kind: 'JSFunctionImpl', path: 'src/app.js', range: { start: { line: 5, column: 3 }, end: { line: 10, column: 4 } } },
      { name: 'result', namePath: 'result', kind: 'JSVariableImpl', path: 'src/app.js', range: { start: { line: 6, column: 9 }, end: { line: 6, column: 15 } } },
      { name: 'callback', namePath: 'callback', kind: 'JSFunctionExpressionImpl', path: 'src/app.js', range: { start: { line: 7, column: 9 }, end: { line: 9, column: 4 } } },
    ],
    truncated: false,
  }
  const compact = symbolTool.output.render({}, value)[0].text
  assert.match(compact, /DEFAULT_LIMIT/)
  assert.match(compact, /Controller\/run/)
  assert.doesNotMatch(compact, /result/)
  assert.doesNotMatch(compact, /callback/)

  const complete = symbolTool.output.render({ include_low_value: true }, value)[0].text
  assert.match(complete, /result/)
  assert.match(complete, /callback/)
})

test('omits blank hints and renders actionable diagnostics on one line', () => {
  const tools = createIdeTools({ request: async () => ({}) })
  const diagnosticTool = tools.find(tool => tool.name === 'ide_diagnostics')
  const rendered = diagnosticTool.output.render({}, {
    diagnostics: [
      { path: 'src/app.ts', severity: 'hint', range: { start: { line: 1, column: 1 } } },
      { path: 'src/app.ts', severity: 'warning', message: 'Unused value', range: { start: { line: 8, column: 5 } } },
    ],
    truncated: false,
  })[0].text
  assert.match(rendered, /^W src\/app\.ts:8:5 Unused value/m)
  assert.match(rendered, /omitted 1 diagnostic/)
  assert.doesNotMatch(rendered, /"range"/)
})
test('maps arguments and forwards the DSH session selection context', async () => {
  let observed
  const [status, context] = createIdeTools({
    async request(method, args, signal, selection) {
      observed = { method, args, signal, selection }
      return { ok: true }
    },
  })
  const signal = new AbortController().signal
  const exec = {
    signal,
    agent: { session: { header: { id: 'session-1', cwd: 'C:/work/project' } } },
  }

  await context.execute({ include_text: true, max_chars: 123 }, exec)
  assert.deepEqual(observed, {
    method: 'context',
    args: { includeText: true, maxChars: 123 },
    signal,
    selection: { sessionId: 'session-1', workspaceRoot: 'C:/work/project', requestPath: undefined },
  })
  assert.deepEqual(await status.execute({}, exec), { ok: true })
})
