import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  codebaseSizeTier,
  codebaseTerritoryTier,
  createCodebaseMemoryEnricher,
  execFileWithClosedStdin,
  parseProjectSnapshot,
} from '../server/codebase-memory.mjs'

const catalog = [{ id: 'p_app', slug: 'app', name: 'App', path: '/repos/app' }]
const output = (nodes) => JSON.stringify({ projects: [{
  name: 'app-index', root_path: '/repos/app', nodes,
  git: { is_git: true, root_exists: true, canonical_root: '/repos/app' },
}] })

test('node counts map to bounded silhouette and six-tier territory contracts', () => {
  assert.deepEqual([0, 499, 500, 1_999, 2_000, 9_999, 10_000, 19_999, 20_000, 49_999, 50_000].map(codebaseTerritoryTier),
    ['xs', 'xs', 'small', 'small', 'medium', 'medium', 'large', 'large', 'xl', 'xl', 'xxl'])
  assert.deepEqual([1_999, 2_000, 19_999, 20_000].map(codebaseSizeTier), ['small', 'medium', 'medium', 'large'])
  assert.throws(() => parseProjectSnapshot('{"records":[]}'), /invalid project catalog/)
})

test('optional enrichment is cached, bounded, fail-open, and keeps last-known-good data', async () => {
  let clock = 0
  let attempt = 0
  const calls = []
  const enrich = createCodebaseMemoryEnricher({
    now: () => clock,
    ttlMs: 10,
    canonicalize: async (value) => value,
    resolveExecutable: async () => 'codebase-memory-mcp',
    execFile: async (...args) => {
      calls.push(args)
      attempt += 1
      if (attempt === 1 || attempt === 3) throw Object.assign(new Error('unavailable'), { code: 'ETIMEDOUT' })
      return { stdout: output(20_000), stderr: 'bounded diagnostic' }
    },
  })

  assert.strictEqual(await enrich(catalog), catalog)
  clock = 5
  assert.strictEqual(await enrich(catalog), catalog)
  clock = 11
  assert.deepEqual(await enrich(catalog), [{ ...catalog[0], codebaseSizeTier: 'large', codebaseTerritoryTier: 'xl' }])
  clock = 22
  assert.deepEqual(await enrich(catalog), [{ ...catalog[0], codebaseSizeTier: 'large', codebaseTerritoryTier: 'xl' }])
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0][2], { timeout: 5_000, maxBuffer: 1024 * 1024 })
})

test('the optional subprocess closes stdin and enforces timeout and output bounds', async () => {
  const eof = await execFileWithClosedStdin(
    process.execPath,
    ['-e', "process.stdin.once('end', () => process.stdout.write('eof')); process.stdin.resume()"],
    { timeout: 1_000, maxBuffer: 16 }
  )
  assert.equal(eof.stdout, 'eof')

  await assert.rejects(
    execFileWithClosedStdin(process.execPath, ['-e', "setTimeout(() => {}, 10_000)"], { timeout: 20 }),
    (error) => error.code === 'ETIMEDOUT'
  )
  await assert.rejects(
    execFileWithClosedStdin(process.execPath, ['-e', "process.stdout.write('x'.repeat(32))"], { maxBuffer: 8 }),
    (error) => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  )
})
