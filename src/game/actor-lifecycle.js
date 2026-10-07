const DEFAULT_CELEBRATION_MS = 2000
const ACTOR_PROFILES = new Set(['builder', 'reviewer', 'drone'])
const LIFECYCLE_EVENTS = new Set([
  'claimed',
  'heartbeat',
  'blocked',
  'review_requested',
  'changes_requested',
  'completed',
  'archived',
  'crashed',
  'timed_out',
  'spawn_failed',
  'gave_up',
  'reclaimed',
  'review_reopened',
])

export function createActorState() {
  return {
    cursor: 0,
    actors: new Map(),
    celebrations: new Map(),
    needsReconcile: false,
  }
}

function currentActor(actor, taskIds) {
  return Boolean(
    actor?.id &&
    actor.taskId &&
    taskIds.has(actor.taskId) &&
    actor.runId !== null &&
    actor.runId !== undefined &&
    ACTOR_PROFILES.has(String(actor.profile || '').toLowerCase()) &&
    actor.heartbeat?.freshness !== 'stale'
  )
}

export function reconcileActorSnapshot(state, snapshot, { taskIds, cursor = state.cursor, now = Date.now() }) {
  const actors = new Map()
  const runs = new Set()
  for (const actor of snapshot || []) {
    if (!currentActor(actor, taskIds)) continue
    const run = `${actor.taskId}:${actor.runId}`
    if (actors.has(actor.id) || runs.has(run)) continue
    actors.set(actor.id, actor)
    runs.add(run)
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
    next.cursor = id
    if (!LIFECYCLE_EVENTS.has(event.kind)) continue

    const actor = [...next.actors.values()].find(
      (entry) => entry.taskId === event.taskId && Number(entry.runId) === Number(event.runId)
    )
    if (!actor) {
      if (!['heartbeat', 'completed', 'archived'].includes(event.kind)) next.needsReconcile = true
      continue
    }

    if (event.kind === 'completed') {
      if (!next.celebrations.has(actor.id)) next.celebrations.set(actor.id, now + celebrationMs)
      next.actors.set(actor.id, { ...actor, lifecycleState: 'completed' })
    } else if (event.kind === 'archived') {
      next.actors.delete(actor.id)
      next.celebrations.delete(actor.id)
    } else if (event.kind !== 'heartbeat') {
      next.needsReconcile = true
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

export function statusForActor(actor) {
  if (actor?.lifecycleState === 'completed') return 'celebrating'
  if (actor?.lifecycleState === 'working') return 'working'
  return 'idle'
}

const normalizedPath = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')

/** Merge the persistent project catalog with task-derived repositories without inventing work. */
export function projectGroups(threads, catalog = [], archivedIds = new Set()) {
  const groups = new Map()
  for (const project of catalog) {
    if (!project?.slug) continue
    groups.set(project.slug, {
      id: project.slug,
      name: project.name || project.slug,
      path: project.path || '',
      threads: [],
    })
  }

  for (const thread of threads || []) {
    if (thread.archived || archivedIds.has(thread.id)) continue
    const workspace = normalizedPath(thread.projectPath || thread.cwd)
    const repository = normalizedPath(thread.repositoryPath)
    const canonicalGitRepository = String(thread.repositoryId || '').startsWith('git:')
    const known = catalog.find((project) => {
      const root = normalizedPath(project.path)
      if (canonicalGitRepository) return repository && root === repository
      return (
        thread.projectId === project.id ||
        thread.projectId === project.slug ||
        thread.tenant === project.id ||
        thread.tenant === project.slug ||
        thread.project === project.id ||
        thread.project === project.slug ||
        thread.project === project.name ||
        (root && (workspace === root || workspace.startsWith(`${root}/`)))
      )
    })
    const id = known?.slug || thread.repositoryId || thread.project || 'unknown'
    if (!groups.has(id)) {
      const name = repository.split('/').at(-1) || thread.project || id
      groups.set(id, {
        id,
        name,
        path: thread.repositoryPath || thread.projectPath || thread.cwd || '',
        threads: [],
      })
    }
    groups.get(id).threads.push(
      known ? { ...thread, project: id, projectPath: known.path || thread.projectPath } : { ...thread, project: id }
    )
  }
  return [...groups.values()]
}

/** Join authoritative current runs to their task worksites; tasks themselves are not actors. */
export function actorRosterEntries(actors, threads, sites) {
  const threadByTask = new Map()
  for (const thread of threads.values()) {
    if (thread.ref?.taskId) threadByTask.set(thread.ref.taskId, thread)
  }
  const roster = []
  const seen = new Set()
  for (const actor of actors || []) {
    if (!actor?.id || actor.runId == null || seen.has(actor.id)) continue
    const thread = threadByTask.get(actor.taskId)
    const location = thread && sites.get(thread.id)
    if (!thread || !location) continue
    roster.push({ id: actor.id, thread, actor, status: statusForActor(actor), ...location })
    seen.add(actor.id)
  }
  return roster.sort((a, b) => a.id.localeCompare(b.id))
}
