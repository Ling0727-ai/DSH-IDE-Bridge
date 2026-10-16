import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply } from '../index.js'

test('native DSH registration uses the shared semantic core and isolates sessions', async t => {
  const scratch = resolve(import.meta.dirname, '../work/native-core')
  await fs.mkdir(scratch, { recursive: true })
  const root = await fs.mkdtemp(join(scratch, 'project-'))
  const other = await fs.mkdtemp(join(scratch, 'other-'))
  await fs.writeFile(join(root, 'a.ts'), 'export function sum(a: number, b: number) { return a + b; }\n')
  await fs.writeFile(join(root, 'b.ts'), 'import { sum } from "./a.js";\nexport const result = sum(1, 2);\n// sum comment\n')
  await fs.writeFile(join(other, 'other.ts'), 'export const isolated = 42;\n')
  await fs.mkdir(join(root, '.serena/memories'), { recursive: true })
  await fs.writeFile(join(root, '.serena/memories/legacy.md'), 'Preserved Serena knowledge.\n')
  const tools = new Map(), disposers = []
  apply({
    tools: { register(tool) { assert.ok(tool.output.schema); assert.equal(typeof tool.output.render, 'function'); tools.set(tool.name, tool) } },
    systemPrompt: { section() {}, context() {} },
    effect(callback) { disposers.push(callback()) },
  }, { discoveryDir: join(scratch, 'no-ide') })
  t.after(async () => { for (const dispose of disposers) await dispose() })
  assert.equal(tools.size, 30)
  const exec = (id, cwd = root) => ({ signal: new AbortController().signal, agent: { session: { header: { id, cwd } } } })
  const call = (name, args = {}, context = exec('one')) => tools.get(name).execute(args, context)
  assert.equal((await call('get_current_config')).root, await fs.realpath(root))
  await call('activate_project', { project: other })
  assert.equal((await call('get_current_config')).root, await fs.realpath(other))
  assert.equal((await call('get_current_config', {}, exec('two'))).root, await fs.realpath(root))
  await call('activate_project', { project: root })
  const symbols = await call('find_symbol', { name_path_pattern: 'sum', include_body: true })
  assert.equal(symbols.symbols.length, 1)
  const references = await call('find_referencing_symbols', { relative_path: 'a.ts', name_path: 'sum' })
  assert.ok(references.locations.some(location => location.relative_path === 'b.ts' && location.range.start.line === 1))
  assert.ok(!references.locations.some(location => location.relative_path === 'b.ts' && location.range.start.line === 2))
  const preview = await call('rename_symbol', { relative_path: 'a.ts', name_path: 'sum', new_name: 'add' })
  assert.equal(preview.applied, false)
  assert.ok(preview.files.some(file => file.changes.some(change => change.old_text === 'sum' && change.new_text === 'add')))
  await call('rename_symbol', { relative_path: 'a.ts', name_path: 'sum', new_name: 'add', dry_run: false })
  assert.match(await fs.readFile(join(root, 'b.ts'), 'utf8'), /add\(1, 2\)/)
  assert.match(await fs.readFile(join(root, 'b.ts'), 'utf8'), /\/\/ sum comment/)
  await call('write_memory', { memory_file_name: 'architecture', content: 'Shared knowledge.' })
  assert.equal((await call('read_memory', { memory_file_name: 'architecture' })).content, 'Shared knowledge.')
  assert.match((await call('read_memory', { memory_file_name: 'legacy', source: 'serena' })).content, /Preserved/)
  await call('import_serena_memories')
  assert.equal(await fs.readFile(join(root, '.serena/memories/legacy.md'), 'utf8'), 'Preserved Serena knowledge.\n')
  const fallback = await call('ide_symbols', { operation: 'documentSymbols', path: 'a.ts' })
  assert.equal(fallback.backend, 'standalone')
  assert.match(tools.get('ide_symbols').output.render({}, fallback)[0].text, /add/)
  await fs.writeFile(join(root, 'python.py'), 'def greet(name: str) -> str:\n    return name\n')
  const python = await call('get_symbols_overview', { relative_path: 'python.py' })
  assert.ok(python.symbols.some(symbol => symbol.name === 'greet'))
})
