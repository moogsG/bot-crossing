const DEFAULT_CELEBRATION_MS = 2000
const LIFECYCLE_EVENTS = new Set([
  'claimed',
  'heartbeat',
  'blocked',
  'review_requested',
  'changes_requested',
  'completed',
  'archived',
])

export function createActorState() {
  return {
    cursor: 0,
    actors: new Map(),
    celebrations: new Map(),
    needsReconcile: false,
  }
}

export function reconcileActorSnapshot(state, snapshot, { taskIds, cursor = state.cursor, now = Date.now() }) {
  const actors = new Map()
  for (const actor of snapshot || []) {
    if (!actor?.id || !actor.taskId || !taskIds.has(actor.taskId) || actors.has(actor.id)) continue
    actors.set(actor.id, actor)
  }

  const celebrations = new Map()
  for (const [id, until] of state.celebrations) {
    if (until <= now) continue
    const prior = state.actors.get(id)
    if (!prior || !taskIds.has(prior.taskId)) continue
    celebrations.set(id, until)
    actors.set(id, { ...(actors.get(id) || prior), lifecycleState: 'completed' })
  }

  return {
    cursor: Math.max(0, Number(cursor) || 0),
    actors,
    celebrations,
    needsReconcile: false,
  }
}

export function reduceActorBatch(state, events, { now = Date.now(), celebrationMs = DEFAULT_CELEBRATION_MS } = {}) {
  const next = {
    cursor: state.cursor,
    actors: new Map(state.actors),
    celebrations: new Map(state.celebrations),
    needsReconcile: state.needsReconcile,
  }
  const ordered = [...(events || [])].sort((a, b) => Number(a?.id) - Number(b?.id))

  for (const event of ordered) {
    const id = Number(event?.id)
    if (!Number.isInteger(id) || id <= next.cursor) continue
    if (id > next.cursor + 1 && next.cursor > 0) next.needsReconcile = true
    next.cursor = id
    if (!LIFECYCLE_EVENTS.has(event.kind)) continue

    const actor = [...next.actors.values()].find(
      (entry) => entry.taskId === event.taskId && Number(entry.runId) === Number(event.runId)
    )
    next.needsReconcile = true
    if (!actor) continue

    if (event.kind === 'completed') {
      if (!next.celebrations.has(actor.id)) next.celebrations.set(actor.id, now + celebrationMs)
      next.actors.set(actor.id, { ...actor, lifecycleState: 'completed' })
    } else if (event.kind === 'archived') {
      next.actors.delete(actor.id)
      next.celebrations.delete(actor.id)
    }
  }
  return next
}

export function reconcileActorUpdate(
  state,
  snapshot,
  batch,
  { taskIds, now = Date.now(), celebrationMs = DEFAULT_CELEBRATION_MS }
) {
  const boundary = Math.max(0, Number(snapshot?.cursor) || 0)
  const staged = reduceActorBatch(
    { ...state, cursor: boundary, needsReconcile: false },
    batch?.events || [],
    { now, celebrationMs }
  )
  const cursor = Math.max(staged.cursor, Number(batch?.cursor) || 0)
  return reconcileActorSnapshot(staged, snapshot?.actors || [], { taskIds, cursor, now })
}

export function visibleActors(state, now = Date.now()) {
  return [...state.actors.values()]
    .filter((actor) => {
      const until = state.celebrations.get(actor.id)
      return actor.lifecycleState !== 'completed' || (until !== undefined && until > now)
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function actorPresentation(actor) {
  if (actor?.requiresMorgan === true) {
    return { status: 'requires-morgan', role: 'jynx', stewardSignal: true }
  }
  const lifecycle = actor?.lifecycleState
  return {
    status:
      lifecycle === 'waiting'
        ? 'internal-wait'
        : lifecycle === 'completed'
          ? 'celebrating'
          : lifecycle || 'idle',
    role: String(actor?.profile || 'builder').toLowerCase(),
    stewardSignal: false,
  }
}

export function standingClipFor(agent) {
  switch (agent.status) {
    case 'working': return 'work'
    case 'reviewing': return 'interact'
    case 'requires-morgan': return agent.role === 'jynx' && agent.stewardSignal ? 'wave' : 'idle'
    case 'waiting': return 'wave'
    case 'blocked': return 'hit'
    case 'celebrating': return 'cheer'
    case 'sleeping': return agent.clipKey === 'sit' ? 'sit' : 'sitDown'
    default: return 'idle'
  }
}

export function actorOpenTarget(actor) {
  const session = actor?.managingSession
  if (!session?.canOpen || typeof session.id !== 'string' || !session.id.trim()) return null
  return { harness: 'hermes-kanban', ref: { sessionId: session.id } }
}
