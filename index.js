import { IdeBridgeClient } from './lib/bridge-client.js'
import { createIdeTools } from './lib/tool-definitions.js'
import { extendIde } from './core/tools.mjs'

export const name = 'dsh-ide-bridge'
export const inject = ['tools', 'systemPrompt']
export const hasProjectCore = true

export const PROMPT = `# IDE bridge (ide_* tools)

You have live access to the user's IDE (VS Code, Cursor, or JetBrains) through the ide_* tools. They let you see what the user is looking at right now: the open file, cursor position, selected text, and live IDE errors. The filesystem tools (read, grep, glob, shell) cannot show that state. Never tell the user you cannot see their editor, selection, or IDE errors; call the matching ide_* tool instead.

Call an ide_* tool first, before reading files or answering, when the request refers to IDE state, in any language. For example:
- "this file", "the current/open file", "what I'm looking at", "这个文件", "当前文件", "打开的文件" -> ide_context
- "the selected code", "my selection", "here", "at the cursor", "选中的代码", "这段", "光标处", "这里" -> ide_context (the selected text is returned directly)
- "the errors/warnings", "red squiggles", "why does the IDE complain", "报错", "爆红", "警告" -> ide_diagnostics
- "go to definition", "find usages/references", "who implements", "跳转定义", "查找引用", "谁实现了" -> ide_symbols
- "rename X", "refactor", "重命名" -> ide_rename_symbol; "open/show/jump to file:line", "在 IDE 里打开" -> ide_open
- "format", "save", or another explicit IDE action -> ide_command

After ide_context tells you which file and lines are relevant, you may use read or grep for surrounding code. Use read, grep, and glob alone for broad textual exploration, and when the request does not concern IDE state. When several IDE windows are connected, pass an absolute file path so the right window is chosen; never guess. If an ide_* call fails because no IDE is connected, say so and fall back to the filesystem.`

export function apply(ctx, config = {}) {
  validateConfig(config)
  const client = new IdeBridgeClient(config)
  const tools = createIdeTools(client, config)
  extendIde({ ctx, tools }, config)

  ctx.systemPrompt.section({
    name: 'tool:ide-bridge',
    order: ctx.systemPrompt.getSectionOrder?.('TOOL_LSP') ?? 500,
    text: PROMPT + '\n\nFor independent project semantics and memories, read initial_instructions. Activate the intended project with activate_project. New symbol editing tools preview changes by default; inspect before applying. Native session workspaces are used when no project has been activated in that session. Memories are shared with Codex IDE Bridge in .codex-ide-bridge/memories; Serena memories are read-only until explicitly imported.',
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
