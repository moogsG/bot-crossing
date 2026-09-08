import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  codebaseSizeTier,
  codebaseTerritoryTier,
  createCodebaseMemoryEnricher,
  execFileWithClosedStdin,
  parseProjectSnapshot,
  resolveCodebaseMemoryExecutable,
} from './codebase-memory.mjs'

const indexedProject = ({ name = 'index', root = '/repos/app', nodes = 1_999, git = {} } = {}) => ({
  name,
  root_path: root,
  nodes,
  git: { is_git: true, root_exists: true, canonical_root: root, ...git },
})

const output = (projects) => JSON.stringify({ projects })

test('real execFile invocation closes stdin so an EOF-waiting CLI can respond', async () => {
  const childProgram =
    "process.stdin.on('end',()=>{process.stdout.write('{\\\"projects\\\":[]}');process.stderr.write('level=info msg=mem.init')});process.stdin.resume()"

  assert.deepEqual(await execFileWithClosedStdin(process.execPath, ['-e', childProgram], { timeout: 1_000 }), {
    stdout: '{"projects":[]}',
    stderr: 'level=info msg=mem.init',
  })
})

test('real execFile invocation kills a child that ignores SIGTERM at the hard deadline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bot-crossing-timeout-'))
  const pidFile = path.join(directory, 'child.pid')
  const childProgram =
    "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  let pid

  try {
    const execution = execFileWithClosedStdin(process.execPath, ['-e', childProgram, pidFile], { timeout: 100 })
    for (let attempt = 0; attempt < 50 && !pid; attempt += 1) {
      try {
        pid = Number(await readFile(pidFile, 'utf8'))
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    assert.ok(pid)

    let pendingTimer
    const result = await Promise.race([
      execution.catch((error) => error),
      new Promise((resolve) => {
        pendingTimer = setTimeout(() => resolve(new Error('execution remained pending')), 500)
      }),
    ])
    clearTimeout(pendingTimer)
    assert.equal(result.code, 'ETIMEDOUT')

    let running = true
    for (let attempt = 0; attempt < 50 && running; attempt += 1) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 10))
      } catch (error) {
        assert.equal(error.code, 'ESRCH')
        running = false
      }
    }
    assert.equal(running, false)
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test('node counts map to the exact repository size tier boundaries', () => {
  assert.equal(codebaseSizeTier(1_999), 'small')
  assert.equal(codebaseSizeTier(2_000), 'medium')
  assert.equal(codebaseSizeTier(19_999), 'medium')
  assert.equal(codebaseSizeTier(20_000), 'large')
  assert.equal(codebaseSizeTier(-1), undefined)
  assert.equal(codebaseSizeTier(1.5), undefined)
  assert.equal(codebaseSizeTier('2000'), undefined)
})

test('node counts map to all six exact repository territory tier boundaries', () => {
  const boundaries = [
    [0, 'xs'],
    [499, 'xs'],
    [500, 'small'],
    [1_999, 'small'],
    [2_000, 'medium'],
    [9_999, 'medium'],
    [10_000, 'large'],
    [19_999, 'large'],
    [20_000, 'xl'],
    [49_999, 'xl'],
    [50_000, 'xxl'],
    [Number.MAX_SAFE_INTEGER, 'xxl'],
  ]

  assert.deepEqual(
    boundaries.map(([nodes]) => codebaseTerritoryTier(nodes)),
    boundaries.map(([, tier]) => tier)
  )
  for (const invalid of [-1, 1.5, '2000', NaN, Infinity, null, undefined]) {
    assert.equal(codebaseTerritoryTier(invalid), undefined)
  }
})

test('project snapshot parses stdout while ignoring process stderr logs', () => {
  const snapshot = parseProjectSnapshot(output([indexedProject()]), 'level=info msg=mem.init')

  assert.deepEqual(snapshot, [indexedProject()])
})

test('project snapshot excludes dead, non-Git, missing-root, and invalid-node indexes', () => {
  const projects = [
    indexedProject({ name: 'live' }),
    indexedProject({ name: 'dead', git: { root_exists: false } }),
    indexedProject({ name: 'not-git', git: { is_git: false } }),
    indexedProject({ name: 'rootless', git: { canonical_root: null } }),
    indexedProject({ name: 'invalid', nodes: '1999' }),
  ]

  assert.deepEqual(parseProjectSnapshot(output(projects)), [projects[0]])
})

test('catalog enrichment matches canonical roots and resolves duplicate indexes deterministically', async () => {
  const calls = []
  const enrich = createCodebaseMemoryEnricher({
    resolveExecutable: async () => '/opt/codebase-memory-mcp',
    execFile: async (...args) => {
      calls.push(args)
      return {
        stdout: output([
          indexedProject({ name: 'z-stale', root: '/aliases/app', nodes: 20_000 }),
          indexedProject({ name: 'a-preferred', root: '/repos/app', nodes: 2_000 }),
        ]),
        stderr: 'level=info msg=mem.init',
      }
    },
    canonicalize: async (value) => (value === '/aliases/app' ? '/repos/app' : value),
  })
  const catalog = [{ id: 'p_app', slug: 'app', name: 'App', path: '/worktree/app' }]

  const enriched = await enrich(catalog, {
    canonicalize: async (value) => (value === '/worktree/app' ? '/repos/app' : value),
  })

  assert.deepEqual(enriched, [
    { ...catalog[0], codebaseSizeTier: 'medium', codebaseTerritoryTier: 'medium' },
  ])
  assert.deepEqual(calls, [
    ['/opt/codebase-memory-mcp', ['cli', 'list_projects'], { timeout: 5_000, maxBuffer: 1024 * 1024 }],
  ])
})

test('concurrent cold enrichment shares one refresh and cannot overwrite the snapshot out of order', async () => {
  let processes = 0
  let complete
  let clock = 0
  const catalog = [{ id: 'p_app', slug: 'app', name: 'App', path: '/repos/app' }]
  const enrich = createCodebaseMemoryEnricher({
    now: () => clock,
    resolveExecutable: async () => 'codebase-memory-mcp',
    canonicalize: async (value) => value,
    execFile: async () => {
      processes += 1
      return new Promise((resolve) => (complete = resolve))
    },
  })

  const requests = Array.from({ length: 8 }, () => enrich(catalog))
  await Promise.resolve()
  await Promise.resolve()
  clock = 60_000
  requests.push(enrich(catalog))
  assert.equal(processes, 1)
  complete({ stdout: output([indexedProject({ nodes: 2_000 })]), stderr: '' })

  const results = await Promise.all(requests)
  assert.equal(processes, 1)
  assert.ok(
    results.every(
      ([project]) => project.codebaseSizeTier === 'medium' && project.codebaseTerritoryTier === 'medium'
    )
  )
})

test('failure keeps the original catalog before first success and last-known-good after success', async () => {
  let attempt = 0
  let clock = 0
  const catalog = [{ id: 'p_app', slug: 'app', name: 'App', path: '/repos/app' }]
  const enrich = createCodebaseMemoryEnricher({
    now: () => clock,
    ttlMs: 10,
    resolveExecutable: async () => 'codebase-memory-mcp',
    canonicalize: async (value) => value,
    execFile: async () => {
      attempt += 1
      if (attempt !== 2) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
      return { stdout: output([indexedProject({ nodes: 20_000 })]), stderr: '' }
    },
  })

  assert.strictEqual(await enrich(catalog), catalog)
  clock = 5
  assert.strictEqual(await enrich(catalog), catalog)
  assert.equal(attempt, 1)
  clock = 11
  assert.deepEqual(await enrich(catalog), [
    { ...catalog[0], codebaseSizeTier: 'large', codebaseTerritoryTier: 'xl' },
  ])
  clock = 22
  assert.deepEqual(await enrich(catalog), [
    { ...catalog[0], codebaseSizeTier: 'large', codebaseTerritoryTier: 'xl' },
  ])
})

test('clock rollback expires both failed and successful cache entries', async () => {
  let attempt = 0
  let clock = 100
  const catalog = [{ id: 'p_app', slug: 'app', name: 'App', path: '/repos/app' }]
  const enrich = createCodebaseMemoryEnricher({
    now: () => clock,
    ttlMs: 10,
    resolveExecutable: async () => 'codebase-memory-mcp',
    canonicalize: async (value) => value,
    execFile: async () => {
      attempt += 1
      if (attempt === 1) throw new Error('unavailable')
      const nodes = attempt === 2 ? 2_000 : 20_000
      return { stdout: output([indexedProject({ nodes })]), stderr: '' }
    },
  })

  assert.strictEqual(await enrich(catalog), catalog)
  clock = 90
  assert.deepEqual(await enrich(catalog), [
    { ...catalog[0], codebaseSizeTier: 'medium', codebaseTerritoryTier: 'medium' },
  ])
  clock = 80
  assert.deepEqual(await enrich(catalog), [
    { ...catalog[0], codebaseSizeTier: 'large', codebaseTerritoryTier: 'xl' },
  ])
  assert.equal(attempt, 3)
})

test('executable resolution respects explicit env, executable home fallback, then PATH', async () => {
  const requested = []
  const access = async (file, mode) => {
    requested.push([file, mode])
    if (!file.endsWith('/.local/bin/codebase-memory-mcp')) throw new Error('not executable')
  }

  assert.equal(
    await resolveCodebaseMemoryExecutable({
      env: { CODEBASE_MEMORY_MCP_BIN: '/custom/memory' },
      homedir: () => '/home/test',
      access,
    }),
    '/custom/memory'
  )
  assert.equal(
    await resolveCodebaseMemoryExecutable({ env: {}, homedir: () => '/home/test', access }),
    '/home/test/.local/bin/codebase-memory-mcp'
  )
  assert.equal(requested.length, 1)

  assert.equal(
    await resolveCodebaseMemoryExecutable({
      env: {},
      homedir: () => '/other',
      access: async () => Promise.reject(new Error('missing')),
    }),
    'codebase-memory-mcp'
  )
})
