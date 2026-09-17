import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

test('Cordis entry registers prompt guidance and every IDE tool', () => {
  const registered = []
  let prompt
  const ctx = {
    tools: { register(tool) { registered.push(tool.name) } },
    systemPrompt: {
      getSectionOrder() { return 42 },
      section(value) { prompt = value },
    },
  }

  apply(ctx, { timeoutMs: 1000 })
  assert.equal(prompt.name, 'tool:ide-bridge')
  assert.equal(prompt.order, 42)
  assert.match(prompt.text, /ide_context/)
  assert.equal(registered.length, 8)
  assert.ok(registered.includes('ide_edit'))
})

test('Cordis entry rejects unsafe numeric configuration', () => {
  const ctx = { tools: { register() {} }, systemPrompt: { section() {} } }
  assert.throws(() => apply(ctx, { timeoutMs: 0 }), /positive integer/)
  assert.throws(() => apply(ctx, { port: 70000 }), /1 to 65535/)
})
