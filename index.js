import { IdeBridgeClient } from './lib/bridge-client.js'
import { createIdeTools } from './lib/tool-definitions.js'

export const name = 'dsh-ide-bridge'
export const inject = ['tools', 'systemPrompt']

const PROMPT = [
  'A live IDE may be available through ide_* tools.',
  'Use ide_context to understand the user’s active editor and selection.',
  'Use ide_symbols and ide_diagnostics when language-service precision is useful.',
  'Before symbol edits, retrieve the symbol structure or relevant source first.',
  'Prefer ide_edit exactReplace for guarded textual changes and symbol operations for whole definitions.',
  'Use ide_command only for explicit IDE actions; the companion extension enforces an allowlist.',
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

  for (const tool of tools) ctx.tools.register(tool)
}

function validateConfig(config) {
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
