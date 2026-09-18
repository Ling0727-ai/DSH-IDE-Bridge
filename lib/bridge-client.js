import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const DISCOVERY_FRESHNESS_MS = 30_000

export class IdeBridgeError extends Error {
  constructor(message, code = 'IDE_BRIDGE_ERROR', details) {
    super(message)
    this.name = 'IdeBridgeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export class IdeBridgeClient {
  constructor(config = {}) {
    this.config = {
      host: config.host ?? '127.0.0.1',
      port: config.port,
      token: config.token ?? process.env.DSH_IDE_TOKEN,
      discoveryFile: config.discoveryFile ?? process.env.DSH_IDE_DISCOVERY_FILE,
      discoveryDir: config.discoveryDir ?? process.env.DSH_IDE_DISCOVERY_DIR ?? path.join(os.tmpdir(), 'dsh-ide-bridge'),
      workspaceRoot: config.workspaceRoot,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    }
    this.sessionEndpoints = new Map()
  }

  availabilityContext() {
    if (this.config.port !== undefined) {
      return 'IDE bridge endpoint is configured. Use ide_status to verify it before IDE-dependent work.'
    }

    const records = readDiscoveryRecordsSync(this.config)
    const now = Date.now()
    const windows = records
      .filter(record => record && record.port && record.token)
      .filter(record => this.config.discoveryFile || isFreshDiscovery(record, now))
      .map(record => ({
        ide: [record.ide, record.ideVersion].filter(Boolean).join(' ') || 'IDE',
        folders: Array.isArray(record.workspaceFolders)
          ? record.workspaceFolders.filter(folder => typeof folder === 'string').slice(0, 4)
          : [],
      }))
      .filter((window, index, all) => all.findIndex(candidate =>
        candidate.ide === window.ide && JSON.stringify(candidate.folders) === JSON.stringify(window.folders)) === index)
      .sort((left, right) => {
        const leftKey = `${left.ide}|${left.folders.join('|')}`
        const rightKey = `${right.ide}|${right.folders.join('|')}`
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
      })
      .slice(0, 6)

    if (windows.length === 0) return ''
    const summary = windows.map(window => `${window.ide} [${window.folders.join(', ') || 'no workspace'}]`).join('; ')
    return `Connected IDE windows: ${summary}. Use ide_context for the active editor or selection. When multiple workspaces are open, use an absolute path to bind the intended window.`
  }

  async endpoint(selection = {}) {
    if (this.config.port !== undefined) {
      const port = toPort(this.config.port)
      if (!this.config.token) {
        throw new IdeBridgeError('A token is required when an explicit IDE bridge port is configured.', 'IDE_TOKEN_REQUIRED')
      }
      return { host: this.config.host, port, token: this.config.token, cacheKey: `fixed:${this.config.host}:${port}` }
    }

    const candidates = this.config.discoveryFile
      ? [await readDiscoveryFile(this.config.discoveryFile)]
      : await readDiscoveryDirectory(this.config.discoveryDir)

    const now = Date.now()
    const usable = candidates
      .filter(Boolean)
      .filter(candidate => candidate.port && candidate.token)
      .map(candidate => normalizeCandidate(candidate, selection, this.config.workspaceRoot))
      .filter(candidate => this.config.discoveryFile || candidate.timestamp === 0 || now - candidate.timestamp < DISCOVERY_FRESHNESS_MS)

    if (usable.length === 0) {
      throw new IdeBridgeError(
        `No running IDE bridge was discovered in ${this.config.discoveryDir}. Install and enable a companion IDE extension.`,
        'IDE_NOT_CONNECTED',
      )
    }

    const sessionId = selection.sessionId === undefined ? undefined : String(selection.sessionId)
    const cachedKey = sessionId === undefined ? undefined : this.sessionEndpoints.get(sessionId)
    const cached = cachedKey === undefined ? undefined : usable.find(candidate => candidate.cacheKey === cachedKey)
    if (cached) return publicEndpoint(cached)
    if (sessionId !== undefined && cachedKey !== undefined) this.sessionEndpoints.delete(sessionId)

    usable.sort((left, right) => right.score - left.score || right.timestamp - left.timestamp)
    const selected = selectUnambiguousCandidate(usable, selection)
    if (sessionId !== undefined) this.sessionEndpoints.set(sessionId, selected.cacheKey)
    return publicEndpoint(selected)
  }

  async request(method, params = {}, signal, selection = {}) {
    const endpoint = await this.endpoint(selection)
    if (signal?.aborted) throw abortError()

    return await new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port })
      let buffer = ''
      let byteCount = 0
      let settled = false

      const forgetEndpoint = () => {
        if (selection.sessionId !== undefined && this.sessionEndpoints.get(String(selection.sessionId)) === endpoint.cacheKey) {
          this.sessionEndpoints.delete(String(selection.sessionId))
        }
      }
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        socket.destroy()
        if (error) reject(error)
        else resolve(value)
      }

      const onAbort = () => finish(abortError())
      const timer = setTimeout(() => {
        finish(new IdeBridgeError(`IDE request timed out after ${this.config.timeoutMs}ms.`, 'IDE_TIMEOUT'))
      }, this.config.timeoutMs)

      signal?.addEventListener('abort', onAbort, { once: true })
      socket.setEncoding('utf8')

      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id: requestId, token: endpoint.token, method, params })}\n`)
      })
      socket.on('data', chunk => {
        byteCount += Buffer.byteLength(chunk)
        if (byteCount > this.config.maxResponseBytes) {
          finish(new IdeBridgeError('IDE response exceeded the configured size limit.', 'IDE_RESPONSE_TOO_LARGE'))
          return
        }

        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return

        let message
        try {
          message = JSON.parse(buffer.slice(0, newline))
        } catch (error) {
          finish(new IdeBridgeError(`IDE bridge returned invalid JSON: ${error.message}`, 'IDE_INVALID_RESPONSE'))
          return
        }

        if (message.id !== requestId) {
          finish(new IdeBridgeError('IDE bridge returned a mismatched request id.', 'IDE_INVALID_RESPONSE'))
          return
        }
        if (!message.ok) {
          finish(new IdeBridgeError(
            message.error?.message ?? 'The IDE rejected the request.',
            message.error?.code ?? 'IDE_REQUEST_FAILED',
            message.error?.details,
          ))
          return
        }
        finish(undefined, message.result)
      })
      socket.on('error', error => {
        forgetEndpoint()
        finish(new IdeBridgeError(`Cannot connect to the IDE bridge: ${error.message}`, 'IDE_CONNECTION_FAILED'))
      })
      socket.on('end', () => {
        if (!settled) {
          forgetEndpoint()
          finish(new IdeBridgeError('IDE bridge closed the connection without a response.', 'IDE_EMPTY_RESPONSE'))
        }
      })
    })
  }
}

function readDiscoveryRecordsSync(config) {
  if (config.discoveryFile) {
    const record = readDiscoveryFileSync(config.discoveryFile)
    return record === undefined ? [] : [record]
  }

  try {
    return readdirSync(config.discoveryDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .slice(0, 32)
      .map(entry => readDiscoveryFileSync(path.join(config.discoveryDir, entry.name)))
      .filter(Boolean)
  } catch {
    return []
  }
}

function readDiscoveryFileSync(file) {
  try {
    if (statSync(file).size > 64 * 1024) return undefined
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

function isFreshDiscovery(candidate, now = Date.now()) {
  const timestamp = Date.parse(candidate.updatedAt ?? candidate.startedAt ?? '') || 0
  return timestamp === 0 || now - timestamp < DISCOVERY_FRESHNESS_MS
}

async function readDiscoveryDirectory(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new IdeBridgeError(`Cannot read IDE discovery directory: ${error.message}`, 'IDE_DISCOVERY_FAILED')
  }

  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(directory, entry.name))
  return (await Promise.all(files.map(async file => {
    try {
      return await readDiscoveryFile(file)
    } catch {
      return undefined
    }
  }))).filter(Boolean)
}

async function readDiscoveryFile(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    if (!value || typeof value !== 'object') throw new Error('expected a JSON object')
    return value
  } catch (error) {
    throw new IdeBridgeError(`Cannot read IDE discovery file ${file}: ${error.message}`, 'IDE_DISCOVERY_FAILED')
  }
}

function normalizeCandidate(candidate, selection, configuredWorkspaceRoot) {
  const port = toPort(candidate.port)
  const host = candidate.host ?? '127.0.0.1'
  const workspaceRoot = selection.workspaceRoot ?? configuredWorkspaceRoot
  const requestTarget = requestTargetPath(selection.requestPath, workspaceRoot)
  const requestScore = workspaceScore(requestTarget, candidate.workspaceFolders)
  const rootScore = workspaceScore(workspaceRoot, candidate.workspaceFolders)
  return {
    ...candidate,
    host,
    port,
    score: requestScore > 0 ? 1_000_000 + requestScore : rootScore,
    timestamp: Date.parse(candidate.updatedAt ?? candidate.startedAt ?? '') || 0,
    cacheKey: `${candidate.pid ?? ''}|${host}|${port}|${candidate.token}`,
  }
}

function selectUnambiguousCandidate(candidates, selection) {
  if (candidates.length === 1) return candidates[0]
  const topScore = candidates[0].score
  const tied = candidates.filter(candidate => candidate.score === topScore)
  if (topScore <= 0 || tied.length > 1) {
    const target = selection.requestPath ?? selection.workspaceRoot
    throw new IdeBridgeError(
      target
        ? `More than one IDE window is running and none uniquely matches ${target}. Use an absolute path or configure workspaceRoot.`
        : 'More than one IDE window is running. Open the DSH session from the intended workspace or configure workspaceRoot.',
      'IDE_INSTANCE_AMBIGUOUS',
      {
        candidates: candidates.map(candidate => ({
          pid: candidate.pid,
          ide: candidate.ide,
          workspaceFolders: candidate.workspaceFolders ?? [],
        })),
      },
    )
  }
  return candidates[0]
}

function publicEndpoint(candidate) {
  return {
    host: candidate.host,
    port: candidate.port,
    token: candidate.token,
    cacheKey: candidate.cacheKey,
  }
}

function requestTargetPath(requestPath, workspaceRoot) {
  if (typeof requestPath !== 'string' || requestPath.length === 0) return undefined
  if (path.isAbsolute(requestPath)) return requestPath
  if (!workspaceRoot) return undefined
  return path.resolve(workspaceRoot, requestPath)
}

function workspaceScore(workspaceRoot, folders) {
  if (!workspaceRoot || !Array.isArray(folders)) return 0
  const target = normalizePath(workspaceRoot)
  let best = 0
  for (const folder of folders) {
    if (typeof folder !== 'string') continue
    const candidate = normalizePath(folder)
    if (target === candidate) best = Math.max(best, 20_000 + candidate.length)
    else if (target.startsWith(`${candidate}${path.sep}`)) best = Math.max(best, 10_000 + candidate.length)
    else if (candidate.startsWith(`${target}${path.sep}`)) best = Math.max(best, 1_000 + target.length)
  }
  return best
}

function normalizePath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function toPort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new IdeBridgeError(`Invalid IDE bridge port: ${value}`, 'IDE_INVALID_CONFIG')
  }
  return port
}

function abortError() {
  const error = new Error('IDE request aborted.')
  error.name = 'AbortError'
  return error
}
