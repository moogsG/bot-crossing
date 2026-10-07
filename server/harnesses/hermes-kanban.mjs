import { execFile as execFileCallback } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCallback)
const VISIBLE_STATUSES = Object.freeze(['ready', 'running', 'review', 'blocked'])
const ACTOR_PROFILES = new Set(['builder', 'reviewer', 'drone'])
const ACTIVE_RUN_STATUSES = new Set(['running', 'blocked', 'review', 'review_requested'])
const FRESH_HEARTBEAT_MS = 2 * 60 * 1000

export const ACTOR_EVENT_VOCABULARY = Object.freeze([
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

function configuredHome(env) {
  return env.HERMES_HOME || path.join(os.homedir(), '.hermes')
}

function sharedHermesHome(env) {
  const home = configuredHome(env)
  return path.basename(path.dirname(home)) === 'profiles' ? path.dirname(path.dirname(home)) : home
}

function databasePath(env) {
  return path.join(sharedHermesHome(env), 'kanban', 'boards', 'native', 'kanban.db')
}

const normalizedPath = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
const epochMilliseconds = (seconds) => (Number(seconds) || 0) * 1000

function attentionFor(status, blockKind) {
  if (status === 'review') return { attention: 'review', attentionLabel: 'In review', requiresMorgan: false }
  if (status !== 'blocked' && status !== 'triage') {
    return { attention: 'none', attentionLabel: '', requiresMorgan: false }
  }
  if (blockKind === 'needs_input' || blockKind === 'capability') {
    return { attention: blockKind, attentionLabel: 'Requires Morgan', requiresMorgan: true }
  }
  if (blockKind === 'dependency' || blockKind === 'transient') {
    return { attention: blockKind, attentionLabel: 'Internal wait', requiresMorgan: false }
  }
  return { attention: 'blocked', attentionLabel: 'Blocked', requiresMorgan: false }
}

function actorHeartbeat(lastAt, now) {
  if (!lastAt) return { lastAt: 0, freshness: 'missing' }
  return { lastAt, freshness: Math.max(0, now - lastAt) <= FRESH_HEARTBEAT_MS ? 'fresh' : 'stale' }
}

async function projectDatabasePaths(env) {
  const home = sharedHermesHome(env)
  let profiles = []
  try {
    profiles = (await fsp.readdir(path.join(home, 'profiles'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    // A shared Hermes home can validly have no profile directory yet.
  }
  return [path.join(home, 'projects.db'), ...profiles.map((profile) => path.join(home, 'profiles', profile, 'projects.db'))]
}

function projectsFrom(databaseFile) {
  let db
  try {
    db = new DatabaseSync(databaseFile, { readOnly: true })
    return db.prepare(`
      SELECT id, slug, name, primary_path
      FROM projects
      WHERE archived = 0
    `).all()
  } catch {
    return []
  } finally {
    db?.close()
  }
}

async function canonicalProjectPath(value) {
  if (!value) return ''
  try {
    return normalizedPath(await fsp.realpath(String(value)))
  } catch {
    return normalizedPath(path.resolve(String(value)))
  }
}

async function repositoryFor(workspacePath, fallback, execFile) {
  if (!workspacePath) return { repositoryId: `metadata:${fallback || 'Other'}`, repositoryPath: '' }
  let canonicalWorkspace
  try {
    canonicalWorkspace = await fsp.realpath(workspacePath)
  } catch {
    canonicalWorkspace = path.resolve(workspacePath)
  }
  try {
    const { stdout } = await execFile('git', [
      '-C', canonicalWorkspace, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir',
    ], { timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true })
    const [topLevel, commonDirectory] = String(stdout).trim().split(/\r?\n/)
    if (!topLevel || !commonDirectory) throw new Error('Git repository identity was incomplete')
    return {
      repositoryId: `git:${normalizedPath(commonDirectory)}`,
      repositoryPath: normalizedPath(path.basename(commonDirectory) === '.git' ? path.dirname(commonDirectory) : topLevel),
    }
  } catch {
    const repositoryPath = normalizedPath(canonicalWorkspace)
    return { repositoryId: `workspace:${repositoryPath}`, repositoryPath }
  }
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await mapper(values[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()))
  return results
}

function projectFor(task, repository, catalog) {
  const explicit = String(task.project_id || '')
  const known = catalog.find((project) =>
    (explicit && (project.id === explicit || project.slug === explicit))
    || (repository.repositoryPath && project.path === repository.repositoryPath)
  )
  if (known) return known
  const repositoryName = repository.repositoryPath.split(/[\\/]/).filter(Boolean).at(-1) || ''
  return {
    id: explicit,
    slug: repositoryName || String(task.tenant || task.workspace_path || 'Other'),
    name: repositoryName || String(task.tenant || task.workspace_path || 'Other'),
    path: repository.repositoryPath,
  }
}

export function createHermesKanban({ env = process.env, execFile = execFileAsync, now = Date.now } = {}) {
  async function detect() {
    try {
      await fsp.access(databasePath(env))
      return true
    } catch {
      return false
    }
  }

  async function scanProjects() {
    const stores = await projectDatabasePaths(env)
    const projects = (
      await Promise.all(
        stores.flatMap((databaseFile) =>
          projectsFrom(databaseFile).map(async (project) => ({
            id: String(project.id),
            slug: String(project.slug),
            name: String(project.name),
            path: await canonicalProjectPath(project.primary_path),
          }))
        )
      )
    ).sort((a, b) => a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id) || a.path.localeCompare(b.path))

    const repositories = new Map()
    for (const project of projects) {
      const identity = project.path ? `path:${project.path}` : `project:${project.id}`
      if (!repositories.has(identity)) repositories.set(identity, project)
    }
    return [...repositories.values()]
  }

  async function scanThreads() {
    const catalog = await scanProjects()
    const db = new DatabaseSync(databasePath(env), { readOnly: true })
    let tasks
    try {
      tasks = db.prepare(`
        SELECT
          t.id, t.title, t.body, t.status, t.block_kind, t.assignee, t.created_at,
          t.started_at, t.workspace_kind, t.project_id, t.tenant, t.workspace_path,
          t.branch_name, t.last_heartbeat_at, t.session_id,
          r.profile AS run_profile, r.status AS run_status, r.started_at AS run_started_at,
          r.last_heartbeat_at AS run_last_heartbeat_at
        FROM tasks t
        LEFT JOIN task_runs r ON r.id = t.current_run_id AND r.task_id = t.id
        WHERE t.status IN ('ready', 'running', 'review', 'blocked')
           OR (t.status = 'triage' AND t.block_kind IN ('needs_input', 'capability'))
        ORDER BY t.id
      `).all()
    } finally {
      db.close()
    }

    const repositories = new Map()
    return mapWithConcurrency(tasks, 4, async (task) => {
      const taskId = String(task.id)
      const body = String(task.body || '')
      const workspacePath = String(task.workspace_path || '')
      const workspaceName = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || ''
      const project = String(task.project_id || task.tenant || workspaceName || 'Other')
      const repositoryKey = workspacePath ? path.resolve(workspacePath) : `metadata:${project}`
      if (!repositories.has(repositoryKey)) repositories.set(repositoryKey, repositoryFor(workspacePath, project, execFile))
      const repository = await repositories.get(repositoryKey)
      const projectInfo = projectFor(task, repository, catalog)
      const heartbeat = Math.max(
        epochMilliseconds(task.run_last_heartbeat_at),
        epochMilliseconds(task.last_heartbeat_at)
      )
      const attention = attentionFor(task.status, task.block_kind)
      return {
        id: `hermes-kanban:${taskId}`,
        title: String(task.title || 'Untitled task'),
        preview: body.replace(/\s+/g, ' ').trim().slice(0, 240),
        project: projectInfo.slug,
        projectId: String(projectInfo.id || task.project_id || ''),
        tenant: String(task.tenant || ''),
        projectPath: workspacePath,
        repositoryId: repository.repositoryId,
        repositoryPath: repository.repositoryPath,
        worktree: task.workspace_kind === 'worktree' ? workspaceName : '',
        cwd: workspacePath,
        gitBranch: String(task.branch_name || ''),
        model: String(task.run_profile || task.assignee || ''),
        effort: '',
        createdAt: epochMilliseconds(task.created_at),
        lastActivityAt: Math.max(
          heartbeat,
          epochMilliseconds(task.run_started_at),
          epochMilliseconds(task.started_at),
          epochMilliseconds(task.created_at)
        ),
        lastFocusedAt: 0,
        running: task.status === 'running',
        unread: false,
        hasError: task.status === 'blocked' || attention.requiresMorgan,
        starred: false,
        routine: '',
        prState: '',
        archived: false,
        sizeBytes: Buffer.byteLength(body),
        source: 'native-kanban',
        canOpen: false,
        canArchive: false,
        requiresMorgan: attention.requiresMorgan,
        attentionLabel: attention.attentionLabel,
        details: {
          taskId,
          body: body.slice(0, 600),
          kanbanStatus: String(task.status),
          projectId: String(task.project_id || ''),
          tenant: String(task.tenant || ''),
          workspace: workspacePath,
          workspaceKind: String(task.workspace_kind || ''),
          branch: String(task.branch_name || ''),
          assignee: String(task.assignee || ''),
          runProfile: String(task.run_profile || ''),
          runStatus: String(task.run_status || ''),
          lastHeartbeatAt: heartbeat,
        },
        ref: {
          taskId,
          board: 'native',
          status: String(task.status),
          attention: attention.attention,
        },
      }
    })
  }

  async function scanActors() {
    const db = new DatabaseSync(databasePath(env), { readOnly: true })
    let rows
    try {
      rows = db.prepare(`
        SELECT
          t.id AS task_id, t.status AS task_status, t.block_kind,
          t.last_heartbeat_at AS task_last_heartbeat_at, t.session_id,
          r.id AS run_id, r.profile, r.status AS run_status,
          r.last_heartbeat_at AS run_last_heartbeat_at
        FROM tasks t
        LEFT JOIN task_runs r ON r.id = t.current_run_id AND r.task_id = t.id
        WHERE t.status IN ('ready', 'running', 'review', 'blocked')
           OR (t.status = 'triage' AND t.block_kind IN ('needs_input', 'capability'))
        ORDER BY t.id, r.id
      `).all()
    } finally {
      db.close()
    }

    const actors = []
    for (const row of rows) {
      const attention = attentionFor(row.task_status, row.block_kind)
      const hasCurrentRun = row.run_id !== null
        && ACTOR_PROFILES.has(String(row.profile || '').toLowerCase())
        && ACTIVE_RUN_STATUSES.has(String(row.run_status || '').toLowerCase())
      if (!hasCurrentRun) continue
      const taskId = String(row.task_id)
      const heartbeatAt = Math.max(
        epochMilliseconds(row.run_last_heartbeat_at),
        epochMilliseconds(row.task_last_heartbeat_at)
      )
      actors.push({
        id: `hermes-kanban:actor:${taskId}:${Number(row.run_id)}`,
        taskId,
        runId: Number(row.run_id),
        profile: String(row.profile).toLowerCase(),
        lifecycleState: attention.requiresMorgan || row.task_status === 'blocked' || row.run_status === 'blocked'
          ? 'waiting'
          : row.task_status === 'review' || String(row.profile).toLowerCase() === 'reviewer'
            ? 'reviewing'
            : 'working',
        heartbeat: actorHeartbeat(heartbeatAt, now()),
        requiresMorgan: attention.requiresMorgan,
        managingSession: {
          id: typeof row.session_id === 'string' ? row.session_id : '',
          canOpen: false,
        },
      })
    }
    return actors
  }

  async function scanActorEvents(since = 0) {
    const cursor = Math.max(0, Number(since) || 0)
    const db = new DatabaseSync(databasePath(env), { readOnly: true })
    try {
      const rows = db.prepare(`
        SELECT id, task_id, run_id, kind, payload, created_at
        FROM task_events
        WHERE id > ?
        ORDER BY id ASC
        LIMIT 200
      `).all(cursor)
      let nextCursor = cursor
      const events = []
      for (const row of rows) {
        nextCursor = Number(row.id)
        if (!ACTOR_EVENT_VOCABULARY.includes(row.kind)) continue
        let payload = null
        try {
          payload = row.payload ? JSON.parse(row.payload) : null
        } catch {
          // Malformed optional metadata does not erase the authoritative event.
        }
        events.push({
          id: Number(row.id),
          taskId: String(row.task_id),
          runId: row.run_id === null ? null : Number(row.run_id),
          kind: String(row.kind),
          payload,
          createdAt: epochMilliseconds(row.created_at),
        })
      }
      return { cursor: nextCursor, events }
    } finally {
      db.close()
    }
  }

  async function actorEventCursor() {
    const db = new DatabaseSync(databasePath(env), { readOnly: true })
    try {
      return Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS cursor FROM task_events').get().cursor)
    } finally {
      db.close()
    }
  }

  return {
    id: 'hermes-kanban',
    name: 'Hermes Kanban',
    detect,
    scanProjects,
    scanThreads,
    scanActors,
    scanActorEvents,
    actorEventCursor,
    openThread: () => ({ ok: false, error: 'Hermes Kanban tasks are read-only in Bot Crossing' }),
    newSession: () => ({ ok: false, error: 'Hermes Kanban cannot start conversations from Bot Crossing' }),
  }
}

export { VISIBLE_STATUSES }
export default createHermesKanban()
