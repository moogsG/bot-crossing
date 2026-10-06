/**
 * Project names: the disambiguation that should only fire when two checkouts really do collide.
 *
 * The interesting cases are all Windows, because Windows is where one folder on disk reaches the
 * scanner spelled three different ways — `C:\…`, `c:\…`, and `\\?\C:\…`. Counted as three paths
 * instead of one, a name that nothing collides with looks ambiguous against itself, and both
 * plots get renamed to their full absolute paths on a machine that has no collision at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  disambiguateProjects,
  scanActorSnapshotsFrom,
  scanNativeKanbanThreadsFrom,
  scanProjectCatalogFrom,
} from '../server/scan.mjs'

const thread = (id, project, projectPath) => ({ id, project, projectPath })
const names = (threads) => disambiguateProjects(threads).map((t) => t.project)

test('one checkout spelled with and without the extended-length prefix is still one project', () => {
  assert.deepEqual(
    names([
      thread('a', 'geh', '\\\\?\\C:\\Users\\me\\Documents\\Codex\\geh'),
      thread('b', 'geh', 'C:\\Users\\me\\Documents\\Codex\\geh'),
    ]),
    ['geh', 'geh']
  )
})

test('the drive letter alone never splits a project in two', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', 'c:\\work\\foo'),
      thread('b', 'foo', 'C:\\work\\foo'),
    ]),
    ['foo', 'foo']
  )
})

test('all three spellings of one path collapse together', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', '\\\\?\\C:\\work\\foo'),
      thread('b', 'foo', 'c:\\work\\foo'),
      thread('c', 'foo', 'C:\\work\\foo'),
    ]),
    ['foo', 'foo', 'foo']
  )
})

test('two real checkouts of the same repo still separate', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', 'C:\\work\\1\\foo'),
      thread('b', 'foo', 'C:\\work\\2\\foo'),
    ]),
    ['1/foo', '2/foo']
  )
})

test('a prefixed path and a real second checkout separate on the path, not the prefix', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', '\\\\?\\C:\\work\\1\\foo'),
      thread('b', 'foo', 'C:\\work\\2\\foo'),
    ]),
    ['1/foo', '2/foo']
  )
})

test('a share is not a drive — \\\\?\\UNC\\… keeps its own identity', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', '\\\\?\\UNC\\server\\share\\foo'),
      thread('b', 'foo', 'C:\\work\\foo'),
    ]),
    ['share/foo', 'work/foo']
  )
})

test('posix paths are untouched by any of it', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', '/home/me/1/foo'),
      thread('b', 'foo', '/home/me/2/foo'),
    ]),
    ['1/foo', '2/foo']
  )
})

test('project catalog aggregation is stable, deduplicated, and fault isolated', async () => {
  const warnings = []
  const projects = await scanProjectCatalogFrom([
    {
      id: 'good',
      scanProjects: async () => [
        { id: 'p_two', slug: 'two', name: 'Two', path: '/work/two' },
        { id: 'p_one', slug: 'one', name: 'One', path: '/work/one' },
      ],
    },
    { id: 'duplicate', scanProjects: async () => [{ id: 'p_other', slug: 'one', name: 'Duplicate', path: '/other' }] },
    { id: 'threads-only' },
    { id: 'broken', scanProjects: async () => Promise.reject(new Error('broken registry')) },
  ], (message) => warnings.push(message))

  assert.deepEqual(projects, [
    { id: 'p_one', slug: 'one', name: 'One', path: '/work/one' },
    { id: 'p_two', slug: 'two', name: 'Two', path: '/work/two' },
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /broken registry/)
})

test('actor aggregation is stable, deduplicated, and fault isolated', async () => {
  const warnings = []
  const actor = { id: 'hermes-kanban:actor:t_one:1', taskId: 't_one', runId: 1 }
  const actors = await scanActorSnapshotsFrom([
    { id: 'first', scanActors: async () => [actor] },
    { id: 'duplicate', scanActors: async () => [{ ...actor }] },
    { id: 'threads-only' },
    { id: 'broken', scanActors: async () => Promise.reject(new Error('broken actor scan')) },
  ], (message) => warnings.push(message))

  assert.deepEqual(actors, [{ ...actor, harness: 'first' }])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /broken actor scan/)
})

test('native colony work items exclude transcript sessions and retain Kanban cards', async () => {
  const tasks = await scanNativeKanbanThreadsFrom([
    {
      id: 'hermes-kanban',
      name: 'Hermes Kanban',
      scanThreads: async () => [
        { id: 'hermes-kanban:t_live', source: 'native-kanban', lastActivityAt: 200 },
      ],
    },
    {
      id: 'hermes',
      name: 'Hermes',
      scanThreads: async () => [
        { id: 'hermes:session-1', source: 'hermes', lastActivityAt: 300 },
      ],
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      scanThreads: async () => [
        { id: 'claude:session-2', source: 'claude-code', lastActivityAt: 400 },
      ],
    },
  ])

  assert.deepEqual(tasks.map(({ id, harness }) => [id, harness]), [
    ['hermes-kanban:t_live', 'hermes-kanban'],
  ])
})
