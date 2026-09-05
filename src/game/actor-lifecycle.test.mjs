import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  actorOpenTarget,
  actorPresentation,
  createActorState,
  reconcileActorUpdate,
  reconcileActorSnapshot,
  reduceActorBatch,
  visibleActors,
} from './actor-lifecycle.js'
import { fetchActorEventBacklog } from './api.js'

const actor = (overrides = {}) => ({
  id: 'hermes-kanban:actor:t_live:7',
  taskId: 't_live',
  runId: 7,
  profile: 'builder',
  lifecycleState: 'working',
  requiresMorgan: false,
  managingSession: { id: 'session-7', canOpen: true },
  steward: 'Jynx',
  ...overrides,
})

const event = (id, kind, overrides = {}) => ({
  id,
  taskId: 't_live',
  runId: 7,
  kind,
  ...overrides,
})

test('snapshot reconciliation deduplicates current actors and drops orphan task actors', () => {
  let state = createActorState()
  state = reconcileActorSnapshot(state, [actor(), actor(), actor({ id: 'orphan', taskId: 't_missing' })], {
    taskIds: new Set(['t_live']),
    cursor: 10,
    now: 1000,
  })

  assert.deepEqual(visibleActors(state).map((entry) => entry.id), ['hermes-kanban:actor:t_live:7'])
  assert.equal(state.cursor, 10)
})

test('ordered batches ignore duplicate and stale-run events while requesting authoritative recovery', () => {
  let state = reconcileActorSnapshot(createActorState(), [actor()], {
    taskIds: new Set(['t_live']),
    cursor: 10,
    now: 1000,
  })

  state = reduceActorBatch(
    state,
    [event(13, 'heartbeat'), event(11, 'heartbeat'), event(11, 'heartbeat'), event(12, 'blocked', { runId: 6 })],
    { now: 1200 }
  )

  assert.equal(state.cursor, 13)
  assert.equal(state.actors.get(actor().id).lifecycleState, 'working')
  assert.equal(state.needsReconcile, true)
})

test('completion celebrates once for a bounded interval and then removes only the actor', () => {
  let state = reconcileActorSnapshot(createActorState(), [actor()], {
    taskIds: new Set(['t_live']),
    cursor: 20,
    now: 1000,
  })

  state = reduceActorBatch(state, [event(21, 'completed')], { now: 2000, celebrationMs: 2000 })
  assert.equal(visibleActors(state, 3999)[0].lifecycleState, 'completed')
  assert.equal(visibleActors(state, 4000).length, 0)

  state = reduceActorBatch(state, [event(21, 'completed')], { now: 2500, celebrationMs: 2000 })
  assert.equal(state.celebrations.get(actor().id), 4000)
})

test('snapshot boundary completion survives an empty scan for one bounded celebration', () => {
  let state = reconcileActorSnapshot(createActorState(), [actor()], {
    taskIds: new Set(['t_live']),
    cursor: 20,
    now: 1000,
  })

  state = reconcileActorUpdate(
    state,
    { actors: [], cursor: 20 },
    { events: [event(21, 'completed')], cursor: 21 },
    { taskIds: new Set(['t_live']), now: 2000, celebrationMs: 2000 }
  )

  assert.deepEqual(visibleActors(state, 3999).map(({ id, lifecycleState }) => ({ id, lifecycleState })), [
    { id: actor().id, lifecycleState: 'completed' },
  ])
  assert.equal(visibleActors(state, 4000).length, 0)
  assert.equal(state.cursor, 21)
})

test('snapshot boundary completion overrides a stale working scan during celebration', () => {
  let state = reconcileActorSnapshot(createActorState(), [actor()], {
    taskIds: new Set(['t_live']),
    cursor: 20,
    now: 1000,
  })

  state = reconcileActorUpdate(
    state,
    { actors: [actor()], cursor: 20 },
    { events: [event(21, 'completed')], cursor: 21 },
    { taskIds: new Set(['t_live']), now: 2000, celebrationMs: 2000 }
  )

  assert.equal(visibleActors(state, 3999)[0].lifecycleState, 'completed')
})

test('snapshot recovery drains a multi-page boundary before applying an empty actor scan', async () => {
  let state = reconcileActorSnapshot(createActorState(), [actor()], {
    taskIds: new Set(['t_live']),
    cursor: 20,
    now: 1000,
  })
  const requested = []
  const backlog = await fetchActorEventBacklog(20, 221, async (since) => {
    requested.push(since)
    if (since === 20) {
      return {
        cursor: 220,
        events: Array.from({ length: 200 }, (_, index) => event(21 + index, 'heartbeat', { taskId: 'other' })),
      }
    }
    return { cursor: 221, events: [event(221, 'completed')] }
  })

  state = reconcileActorUpdate(
    state,
    { actors: [], cursor: 20 },
    backlog,
    { taskIds: new Set(['t_live']), now: 2000, celebrationMs: 2000 }
  )

  assert.deepEqual(requested, [20, 220])
  assert.equal(state.celebrations.size, 1)
  assert.equal(visibleActors(state, 3999)[0].lifecycleState, 'completed')
  assert.equal(visibleActors(state, 4000).length, 0)
})

test('presentation keeps internal waits quiet and reserves the wave for Jynx attention', () => {
  assert.deepEqual(actorPresentation(actor({ lifecycleState: 'waiting' })), {
    status: 'internal-wait',
    role: 'builder',
    stewardSignal: false,
  })
  assert.deepEqual(actorPresentation(actor({ lifecycleState: 'waiting', requiresMorgan: true })), {
    status: 'requires-morgan',
    role: 'jynx',
    stewardSignal: true,
  })
  assert.deepEqual(actorPresentation(actor({ lifecycleState: 'reviewing', profile: 'reviewer' })), {
    status: 'reviewing',
    role: 'reviewer',
    stewardSignal: false,
  })
})

test('actor navigation uses only the authoritative managing session', () => {
  assert.deepEqual(actorOpenTarget(actor()), {
    harness: 'hermes-kanban',
    ref: { sessionId: 'session-7' },
  })
  assert.equal(actorOpenTarget(actor({ managingSession: { id: '', canOpen: false } })), null)
})

test('authoritative snapshots reset a regressed cursor after event storage recovery', () => {
  const stale = { ...createActorState(), cursor: 99, needsReconcile: true }
  const recovered = reconcileActorSnapshot(stale, [], {
    taskIds: new Set(),
    cursor: 4,
    now: 1000,
  })

  assert.equal(recovered.cursor, 4)
  assert.equal(recovered.needsReconcile, false)
})
