import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IdeBridgeClient, IdeBridgeError } from '../lib/bridge-client.js'

async function createMockBridge(directory, options = {}) {
  const token = options.token ?? 'secret'
  const server = net.createServer(socket => {
    socket.setEncoding('utf8')
    let input = ''
    socket.on('data', chunk => {
      input += chunk
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(input.slice(0, newline))
      if (options.handler) options.handler(socket, request)
      else socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { bridge: options.name ?? 'fixture' } })}\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await writeFile(path.join(directory, `${options.name ?? 'fixture'}.json`), JSON.stringify({
    pid: options.pid ?? port,
    ide: options.ide ?? 'Test IDE',
    port,
    host: '127.0.0.1',
    token,
    workspaceFolders: options.workspaceFolders ?? [process.cwd()],
    updatedAt: new Date().toISOString(),
  }))
  return async () => new Promise(resolve => server.close(resolve))
}

async function fixture(handler) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-test-'))
  const closeServer = await createMockBridge(directory, { handler })
  return {
    directory,
    close: async () => {
      await closeServer()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('discovers the bridge and exchanges an authenticated request', async t => {
  const bridge = await fixture((socket, request) => {
    assert.equal(request.token, 'secret')
    assert.equal(request.method, 'status')
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { connected: true } })}\n`)
  })
  t.after(bridge.close)

  const client = new IdeBridgeClient({ discoveryDir: bridge.directory, timeoutMs: 2_000 })
  assert.deepEqual(await client.request('status'), { connected: true })
})

test('surfaces structured IDE errors', async t => {
  const bridge = await fixture((socket, request) => {
    socket.end(`${JSON.stringify({
      id: request.id,
      ok: false,
      error: { code: 'IDE_COMMAND_NOT_ALLOWED', message: 'blocked' },
    })}\n`)
  })
  t.after(bridge.close)

  const client = new IdeBridgeClient({ discoveryDir: bridge.directory, timeoutMs: 2_000 })
  await assert.rejects(client.request('command'), error => {
    assert.ok(error instanceof IdeBridgeError)
    assert.equal(error.code, 'IDE_COMMAND_NOT_ALLOWED')
    return true
  })
})

test('selects IDE windows by request path and keeps each session bound', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-multi-'))
  const projectA = path.join(directory, 'project-a')
  const projectB = path.join(directory, 'project-b')
  const closeA = await createMockBridge(directory, { name: 'a', pid: 101, token: 'token-a', workspaceFolders: [projectA] })
  const closeB = await createMockBridge(directory, { name: 'b', pid: 202, token: 'token-b', workspaceFolders: [projectB] })
  t.after(async () => {
    await Promise.all([closeA(), closeB()])
    await rm(directory, { recursive: true, force: true })
  })

  const client = new IdeBridgeClient({ discoveryDir: directory, timeoutMs: 2_000 })
  const first = await client.request('open', { path: path.join(projectA, 'README.md') }, undefined, {
    sessionId: 'session-a',
    requestPath: path.join(projectA, 'README.md'),
  })
  assert.equal(first.bridge, 'a')

  const stillBound = await client.request('status', {}, undefined, {
    sessionId: 'session-a',
    workspaceRoot: projectB,
  })
  assert.equal(stillBound.bridge, 'a')

  const otherSession = await client.request('status', {}, undefined, {
    sessionId: 'session-b',
    workspaceRoot: projectB,
  })
  assert.equal(otherSession.bridge, 'b')
})

test('rejects ambiguous multi-window discovery instead of choosing the newest heartbeat', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-ambiguous-'))
  const closeA = await createMockBridge(directory, { name: 'a', pid: 101, workspaceFolders: [path.join(directory, 'a')] })
  const closeB = await createMockBridge(directory, { name: 'b', pid: 202, workspaceFolders: [path.join(directory, 'b')] })
  t.after(async () => {
    await Promise.all([closeA(), closeB()])
    await rm(directory, { recursive: true, force: true })
  })

  const client = new IdeBridgeClient({ discoveryDir: directory })
  await assert.rejects(client.request('status', {}, undefined, { sessionId: 'unknown' }), error => {
    assert.equal(error.code, 'IDE_INSTANCE_AMBIGUOUS')
    assert.equal(error.details.candidates.length, 2)
    return true
  })
})

test('ignores stale discovery records', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-stale-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'stale.json'), JSON.stringify({
    port: 12345,
    token: 'expired',
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  }))
  const client = new IdeBridgeClient({ discoveryDir: directory })
  await assert.rejects(client.request('status'), { code: 'IDE_NOT_CONNECTED' })
})

test('reports a helpful error when no IDE is discoverable', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-empty-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const client = new IdeBridgeClient({ discoveryDir: directory })
  await assert.rejects(client.request('status'), { code: 'IDE_NOT_CONNECTED' })
})
