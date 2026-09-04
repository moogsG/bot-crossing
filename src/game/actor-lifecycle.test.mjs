import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  actorOpenTarget,
  actorPresentation,
  createActorState,
  reconcileActorSnapshot,
  reduceActorBatch,
  visibleActors,
} from './actor-lifecycle.js'

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
