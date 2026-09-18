import { IdeBridgeClient } from './lib/bridge-client.js'
import { createIdeTools } from './lib/tool-definitions.js'

export const name = 'dsh-ide-bridge'
export const inject = ['tools', 'systemPrompt']

const PROMPT = [
  'IDE tools are the first choice when the user refers to the current or open file, editor, selection, cursor, diagnostics, symbol definitions, references, implementations, refactoring, or an IDE UI action.',
  'For those requests, call the relevant ide_* tool before answering instead of guessing from filesystem state.',
  'Use ide_context for current editor state, ide_symbols for semantic navigation, ide_diagnostics for live IDE findings, and ide_rename_symbol or ide_edit for IDE-backed changes.',
  'Use read, grep, and glob for broad textual exploration or when no IDE window matches the target workspace.',
  'Do not call IDE tools for unrelated tasks merely because an IDE is connected.',
  'When multiple IDE windows are connected, use an absolute file path to bind the intended workspace and never guess.',
].join(' ')

export function apply(ctx, config = {}) {
  validateConfig(config)
  const client = new IdeBridgeClient(config)
  const tools = createIdeTools(client, config)

  ctx.systemPrompt.section({
    name: 'tool:ide-bridge',
    order: ctx.systemPrompt.getSectionOrder?.('TOOL_LSP') ?? 500,
    text: PROMPT,
  })

  if (config.autoContext !== false) {
    ctx.systemPrompt.context({
      name: 'ide:availability',
      order: 130,
      text: () => client.availabilityContext(),
    })
  }

  for (const tool of tools) ctx.tools.register(tool)
}

function validateConfig(config) {
  if (config.autoContext !== undefined && typeof config.autoContext !== 'boolean') {
    throw new Error('dsh-ide-bridge: autoContext must be a boolean')
  }
  for (const key of ['timeoutMs', 'maxResponseBytes', 'maxRenderChars']) {
    if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < 1)) {
      throw new Error(`dsh-ide-bridge: ${key} must be a positive integer`)
    }
  }
  if (config.port !== undefined) {
    const port = Number(config.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('dsh-ide-bridge: port must be an integer from 1 to 65535')
    }
  }
}
