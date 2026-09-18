import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

test('Cordis entry registers prompt guidance and every IDE tool', () => {
  const registered = []
  let prompt
  let runtimeContext
  const ctx = {
    tools: { register(tool) { registered.push(tool.name) } },
    systemPrompt: {
      getSectionOrder() { return 42 },
      section(value) { prompt = value },
      context(value) { runtimeContext = value },
    },
  }

  apply(ctx, { timeoutMs: 1000 })
  assert.equal(prompt.name, 'tool:ide-bridge')
  assert.equal(prompt.order, 42)
  assert.match(prompt.text, /current or open file/)
  assert.match(prompt.text, /call the relevant ide_\* tool before answering/)
  assert.equal(runtimeContext.name, 'ide:availability')
  assert.equal(runtimeContext.order, 130)
  assert.equal(typeof runtimeContext.text, 'function')
  assert.equal(registered.length, 8)
  assert.ok(registered.includes('ide_edit'))
})

test('Cordis entry rejects unsafe configuration', () => {
  const ctx = { tools: { register() {} }, systemPrompt: { section() {}, context() {} } }
  assert.throws(() => apply(ctx, { timeoutMs: 0 }), /positive integer/)
  assert.throws(() => apply(ctx, { port: 70000 }), /1 to 65535/)
  assert.throws(() => apply(ctx, { autoContext: 'yes' }), /autoContext must be a boolean/)
})
