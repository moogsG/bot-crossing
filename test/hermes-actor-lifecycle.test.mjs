import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createActorState,
  reconcileActorSnapshot,
  reduceActorBatch,
  visibleActors,
} from '../src/game/actor-lifecycle.js'
import { fetchActorEventBacklog } from '../src/game/api.js'

const actor = (overrides = {}) => ({
  id: 'hermes-kanban:actor:t_build:41',
  taskId: 't_build',
  runId: 41,
  profile: 'builder',
  lifecycleState: 'working',
  heartbeat: { lastAt: 1_000, freshness: 'fresh' },
  ...overrides,
})

test('actor snapshots add and update current runs while suppressing duplicates and stale runs', () => {
  const taskIds = new Set(['t_build', 't_review'])
  let state = reconcileActorSnapshot(createActorState(), [
    actor(),
    actor({ lifecycleState: 'reviewing' }),
    actor({ id: 'duplicate-id', heartbeat: { lastAt: 500, freshness: 'stale' } }),
    actor({ id: 'attention-only', runId: null, profile: 'jynx', requiresMorgan: true }),
    actor({ id: 'unknown-task', taskId: 't_hidden' }),
  ], { taskIds, cursor: 7, now: 2_000 })

  assert.deepEqual(visibleActors(state, 2_000).map(({ id, lifecycleState }) => [id, lifecycleState]), [
    ['hermes-kanban:actor:t_build:41', 'working'],
  ])

  state = reconcileActorSnapshot(state, [
    actor({ lifecycleState: 'reviewing', profile: 'reviewer' }),
    actor({ id: 'hermes-kanban:actor:t_review:42', taskId: 't_review', runId: 42, profile: 'drone' }),
  ], { taskIds, cursor: 8, now: 3_000 })

  assert.deepEqual(visibleActors(state, 3_000).map(({ id, lifecycleState, profile }) => [id, lifecycleState, profile]), [
    ['hermes-kanban:actor:t_build:41', 'reviewing', 'reviewer'],
    ['hermes-kanban:actor:t_review:42', 'working', 'drone'],
  ])
})

test('completed runs celebrate for a bounded grace then disappear with ended and archived runs', () => {
  const taskIds = new Set(['t_build', 't_review'])
  let state = reconcileActorSnapshot(createActorState(), [
    actor(),
    actor({ id: 'hermes-kanban:actor:t_review:42', taskId: 't_review', runId: 42 }),
  ], { taskIds, cursor: 10, now: 1_000 })

  state = reduceActorBatch(state, [
    { id: 11, taskId: 't_build', runId: 41, kind: 'completed' },
    { id: 12, taskId: 't_review', runId: 42, kind: 'archived' },
  ], { now: 2_000, celebrationMs: 2_000 })
  assert.equal(state.needsReconcile, false, 'terminal actor events are authoritative during completion grace')
  state = reconcileActorSnapshot(state, [], { taskIds, cursor: 12, now: 2_100 })

  assert.deepEqual(visibleActors(state, 3_999).map(({ id, lifecycleState }) => [id, lifecycleState]), [
    ['hermes-kanban:actor:t_build:41', 'completed'],
  ])
  assert.deepEqual(visibleActors(state, 4_000), [])

  state = reconcileActorSnapshot(state, [], { taskIds, cursor: 13, now: 4_000 })
  assert.equal(state.actors.size, 0)
  assert.equal(state.celebrations.size, 0)
})

test('event backlog advances across bounded pages through the snapshot boundary', async () => {
  const since = []
  const pages = [
    { cursor: 12, events: [{ id: 11, kind: 'heartbeat' }] },
    { cursor: 14, events: [{ id: 13, kind: 'completed' }] },
  ]

  const result = await fetchActorEventBacklog(10, 14, async (cursor) => {
    since.push(cursor)
    return pages.shift()
  })

  assert.deepEqual(since, [10, 12])
  assert.deepEqual(result, {
    cursor: 14,
    events: [{ id: 11, kind: 'heartbeat' }, { id: 13, kind: 'completed' }],
  })
})

test('global event id gaps do not force reconciliation for an authoritative batch', () => {
  const state = reconcileActorSnapshot(createActorState(), [actor()], {
    taskIds: new Set(['t_build']), cursor: 1, now: 1_000,
  })

  const next = reduceActorBatch(state, [
    { id: 3, taskId: 't_build', runId: 41, kind: 'heartbeat' },
  ], { now: 2_000 })

  assert.equal(next.cursor, 3)
  assert.equal(next.needsReconcile, false)
})

test('native failure and recovery events request an authoritative snapshot', () => {
  for (const kind of ['crashed', 'timed_out', 'spawn_failed', 'gave_up', 'reclaimed', 'review_reopened']) {
    const state = reconcileActorSnapshot(createActorState(), [actor()], {
      taskIds: new Set(['t_build']), cursor: 1, now: 1_000,
    })
    const next = reduceActorBatch(state, [
      { id: 2, taskId: 't_build', runId: 41, kind },
    ], { now: 2_000 })
    assert.equal(next.needsReconcile, true, kind)
  }
})
