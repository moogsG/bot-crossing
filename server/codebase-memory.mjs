import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_TTL_MS = 30_000
const PROCESS_TIMEOUT_MS = 5_000
const PROCESS_MAX_BUFFER = 1024 * 1024

const normalizedPath = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')

async function canonicalPath(value) {
  if (!value) return ''
  try {
    return normalizedPath(await fsp.realpath(String(value)))
  } catch {
    return normalizedPath(path.resolve(String(value)))
  }
}

/** The CLI reads stdin before dispatching, so explicitly deliver EOF after launching it. */
export function execFileWithClosedStdin(file, args, options) {
  return new Promise((resolve, reject) => {
    const { timeout = 0, maxBuffer = Infinity, encoding = 'utf8', ...spawnOptions } = options || {}
    const child = spawn(file, args, { ...spawnOptions, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timer = null
    let settled = false

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.stdin.removeListener('error', onStdinError)
    }
    const settle = (error, result) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(result)
    }
    const terminate = (error) => {
      child.kill('SIGKILL')
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      settle(error)
    }
    const append = (chunks, chunk, streamName) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (streamName === 'stdout') stdoutBytes += buffer.length
      else stderrBytes += buffer.length
      if ((streamName === 'stdout' ? stdoutBytes : stderrBytes) > maxBuffer) {
        const error = new RangeError(`${streamName} maxBuffer length exceeded`)
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        terminate(error)
        return
      }
      chunks.push(buffer)
    }
    function onStdout(chunk) {
      append(stdout, chunk, 'stdout')
    }
    function onStderr(chunk) {
      append(stderr, chunk, 'stderr')
    }
    function onStdinError() {}
    function onError(error) {
      settle(error)
    }
    function onClose(code, signal) {
      if (code === 0) {
        settle(null, {
          stdout: Buffer.concat(stdout).toString(encoding),
          stderr: Buffer.concat(stderr).toString(encoding),
        })
        return
      }
      const error = new Error(`Command failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`)
      error.code = code
      error.signal = signal
      settle(error)
    }

    child.on('error', onError)
    child.on('close', onClose)
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.stdin.on('error', onStdinError)
    if (timeout > 0) {
      timer = setTimeout(() => {
        const error = new Error(`Command timed out after ${timeout}ms`)
        error.code = 'ETIMEDOUT'
        error.signal = 'SIGKILL'
        terminate(error)
      }, timeout)
    }
    child.stdin.end()
  })
}

export function codebaseSizeTier(nodes) {
  if (!Number.isInteger(nodes) || nodes < 0) return undefined
  if (nodes >= 20_000) return 'large'
  if (nodes >= 2_000) return 'medium'
  return 'small'
}

export function codebaseTerritoryTier(nodes) {
  if (!Number.isInteger(nodes) || nodes < 0) return undefined
  if (nodes >= 50_000) return 'xxl'
  if (nodes >= 20_000) return 'xl'
  if (nodes >= 10_000) return 'large'
  if (nodes >= 2_000) return 'medium'
  if (nodes >= 500) return 'small'
  return 'xs'
}

export function parseProjectSnapshot(stdout, _stderr = '') {
  const payload = JSON.parse(String(stdout || ''))
  if (!Array.isArray(payload?.projects)) throw new Error('Codebase Memory returned an invalid project catalog')
  return payload.projects.filter(
    (project) =>
      project?.git?.is_git === true &&
      project.git.root_exists === true &&
      typeof project.git.canonical_root === 'string' &&
      project.git.canonical_root.length > 0 &&
      codebaseSizeTier(project.nodes)
  )
}

export async function resolveCodebaseMemoryExecutable({
  env = process.env,
  homedir = os.homedir,
  access = fsp.access,
} = {}) {
  if (env.CODEBASE_MEMORY_MCP_BIN) return env.CODEBASE_MEMORY_MCP_BIN
  const homeExecutable = path.join(homedir(), '.local', 'bin', 'codebase-memory-mcp')
  try {
    await access(homeExecutable, fsConstants.X_OK)
    return homeExecutable
  } catch {
    return 'codebase-memory-mcp'
  }
}

// Duplicate precedence is stable and source-independent: name, source root, then larger graph.
const compareIndexes = (left, right) =>
  String(left.name || '').localeCompare(String(right.name || '')) ||
  String(left.root_path || '').localeCompare(String(right.root_path || '')) ||
  right.nodes - left.nodes

export function createCodebaseMemoryEnricher({
  execFile = execFileWithClosedStdin,
  resolveExecutable = resolveCodebaseMemoryExecutable,
  canonicalize = canonicalPath,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  let lastKnownGood = null
  let lastCheckedAt = -Infinity
  let inFlight = null

  const refresh = async () => {
    const executable = await resolveExecutable()
    const { stdout, stderr } = await execFile(executable, ['cli', 'list_projects'], {
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: PROCESS_MAX_BUFFER,
    })
    const projects = parseProjectSnapshot(stdout, stderr)
    const canonicalProjects = await Promise.all(
      projects.map(async (project) => ({ ...project, canonicalRoot: await canonicalize(project.git.canonical_root) }))
    )
    return canonicalProjects
  }

  return async function enrichProjectCatalog(catalog, { canonicalize: canonicalizeCatalog = canonicalize } = {}) {
    const checkedAt = now()
    const elapsed = checkedAt - lastCheckedAt
    if ((elapsed < 0 || elapsed >= ttlMs) && !inFlight) {
      lastCheckedAt = checkedAt
      inFlight = refresh()
        .then((projects) => (lastKnownGood = projects))
        .catch(() => lastKnownGood)
        .finally(() => (inFlight = null))
    }
    if (inFlight) await inFlight
    if (!lastKnownGood) return catalog

    const byRoot = new Map()
    for (const project of [...lastKnownGood].sort(compareIndexes)) {
      if (project.canonicalRoot && !byRoot.has(project.canonicalRoot)) byRoot.set(project.canonicalRoot, project)
    }

    return Promise.all(
      catalog.map(async (project) => {
        const root = await canonicalizeCatalog(project?.path)
        const indexed = byRoot.get(root)
        const tier = indexed && codebaseSizeTier(indexed.nodes)
        const territoryTier = indexed && codebaseTerritoryTier(indexed.nodes)
        return tier && territoryTier
          ? { ...project, codebaseSizeTier: tier, codebaseTerritoryTier: territoryTier }
          : project
      })
    )
  }
}

export const enrichProjectCatalog = createCodebaseMemoryEnricher()
