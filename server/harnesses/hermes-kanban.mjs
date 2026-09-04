import { execFile as execFileCallback } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCallback)
const TASK_ID = /^t_[A-Za-z0-9_-]+$/
const FRESH_HEARTBEAT_MS = 2 * 60 * 1000

export const ACTOR_EVENT_VOCABULARY = Object.freeze([
  'claimed',
  'heartbeat',
  'blocked',
  'review_requested',
  'changes_requested',
  'completed',
  'archived',
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

function projectsPath(env) {
  return path.join(configuredHome(env), 'projects.db')
}

const epochMilliseconds = (seconds) => (Number(seconds) || 0) * 1000

function attentionFor(status, blockKind) {
  if (status === 'review') return { attention: 'review', attentionLabel: 'In review', requiresMorgan: false }
  if (status !== 'blocked') return { attention: 'none', attentionLabel: '', requiresMorgan: false }
  if (blockKind === 'needs_input' || blockKind === 'capability') {
    return { attention: blockKind, attentionLabel: 'Requires Morgan', requiresMorgan: true }
  }
  if (blockKind === 'dependency' || blockKind === 'transient') {
    return { attention: blockKind, attentionLabel: 'Internal wait', requiresMorgan: false }
  }
  return { attention: 'blocked', attentionLabel: 'Blocked', requiresMorgan: false }
}

function validSessionId(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function actorLifecycleState(taskStatus, runStatus, claimedFromReview) {
  if (taskStatus === 'done' || taskStatus === 'archived' || runStatus === 'done' || runStatus === 'released') {
    return 'completed'
  }
  if (taskStatus === 'blocked' || taskStatus === 'todo' || runStatus === 'blocked') return 'waiting'
  if (taskStatus === 'review' || (taskStatus === 'running' && runStatus === 'running' && claimedFromReview)) {
    return 'reviewing'
  }
  if (runStatus === 'running') return 'working'
  return null
}

function actorHeartbeat(lastAt, now) {
  if (!lastAt) return { lastAt: 0, freshness: 'missing' }
  return {
    lastAt,
    freshness: Math.max(0, now - lastAt) <= FRESH_HEARTBEAT_MS ? 'fresh' : 'stale',
  }
}

const normalizedPath = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')

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
      '-C',
      canonicalWorkspace,
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
    ])
    const [topLevel, commonDirectory] = String(stdout).trim().split(/\r?\n/)
    if (!topLevel || !commonDirectory) throw new Error('Git repository identity was incomplete')
    const repositoryPath = normalizedPath(
      path.basename(commonDirectory) === '.git' ? path.dirname(commonDirectory) : topLevel
    )
    return {
      repositoryId: `git:${normalizedPath(commonDirectory)}`,
      repositoryPath,
    }
  } catch {
    const repositoryPath = normalizedPath(canonicalWorkspace)
    return { repositoryId: `workspace:${repositoryPath}`, repositoryPath }
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
    const db = new DatabaseSync(projectsPath(env), { readOnly: true })
    try {
      return db
        .prepare(`
          SELECT id, slug, name, primary_path
          FROM projects
          WHERE archived = 0
          ORDER BY slug, id
        `)
        .all()
        .map((project) => ({
          id: String(project.id),
          slug: String(project.slug),
          name: String(project.name),
          path: String(project.primary_path || ''),
        }))
    } finally {
      db.close()
    }
  }

  async function scanThreads() {
    const db = new DatabaseSync(databasePath(env), { readOnly: true })
    let tasks
    try {
      tasks = db
        .prepare(`
          SELECT
            t.id,
            t.title,
            t.body,
            t.status,
            t.block_kind,
            t.assignee,
            t.created_at,
            t.started_at,
            t.workspace_kind,
            t.project_id,
            t.tenant,
            t.workspace_path,
            t.branch_name,
            t.last_heartbeat_at,
            t.session_id,
            r.profile AS run_profile,
            r.status AS run_status,
            r.started_at AS run_started_at,
            r.last_heartbeat_at AS run_last_heartbeat_at
          FROM tasks t
          LEFT JOIN task_runs r ON r.id = t.current_run_id AND r.task_id = t.id
          WHERE t.status <> 'archived'
        `)
        .all()
    } finally {
      db.close()
    }

    const repositories = new Map()
    return Promise.all(
      tasks.map(async (task) => {
          const taskId = String(task.id)
          const threadId = `hermes-kanban:${taskId}`
          const workspacePath = String(task.workspace_path || '')
          const workspaceName = workspacePath.split(/[\\/]/).filter(Boolean).at(-1)
          const project = String(task.project_id || task.tenant || workspaceName || 'Other')
          const repositoryKey = workspacePath ? path.resolve(workspacePath) : `metadata:${project}`
          if (!repositories.has(repositoryKey)) {
            repositories.set(repositoryKey, repositoryFor(workspacePath, project, execFile))
          }
          const repository = await repositories.get(repositoryKey)
          const body = String(task.body || '')
          const preview = body.replace(/\s+/g, ' ').trim().slice(0, 240)
          const sessionId = validSessionId(task.session_id) ? task.session_id : ''
          const heartbeat = Math.max(
            epochMilliseconds(task.run_last_heartbeat_at),
            epochMilliseconds(task.last_heartbeat_at)
          )
          const attention = attentionFor(task.status, task.block_kind)
          const worker = {
            assignee: String(task.assignee || ''),
            profile: String(task.run_profile || ''),
            runStatus: String(task.run_status || ''),
          }
          return {
            id: threadId,
            title: String(task.title || 'Untitled task'),
            preview,
            project,
            projectId: String(task.project_id || ''),
            tenant: String(task.tenant || ''),
            projectPath: workspacePath,
            repositoryId: repository.repositoryId,
            repositoryPath: repository.repositoryPath,
            worktree: task.workspace_kind === 'worktree' ? String(workspaceName || '') : '',
            cwd: workspacePath,
            gitBranch: String(task.branch_name || ''),
            model: 'Jynx',
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
            hasError: task.status === 'blocked',
            starred: false,
            routine: '',
            prState: '',
            archived: false,
            sizeBytes: Buffer.byteLength(body),
            source: 'native-kanban',
            canOpen: Boolean(sessionId),
            canArchive: true,
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
              steward: 'Jynx',
              assignee: worker.assignee,
              runProfile: worker.profile,
              runStatus: worker.runStatus,
              lastHeartbeatAt: heartbeat,
            },
            ref: {
              taskId,
              threadId,
              board: 'native',
              sessionId,
              status: String(task.status),
              attention: attention.attention,
              steward: 'Jynx',
              worker,
            },
          }
        })
    )
  }

  async function scanActors() {
    const db = new DatabaseSync(databasePath(env), { readOnly: true })
    let rows
    try {
      rows = db
        .prepare(`
          SELECT
            t.id AS task_id,
            t.status AS task_status,
            t.block_kind,
            t.last_heartbeat_at AS task_last_heartbeat_at,
            t.session_id,
            r.id AS run_id,
            r.profile,
            r.status AS run_status,
            r.last_heartbeat_at AS run_last_heartbeat_at,
            (
              SELECT e.payload
              FROM task_events e
              WHERE e.task_id = t.id AND e.run_id = r.id AND e.kind = 'claimed'
              ORDER BY e.id DESC
              LIMIT 1
            ) AS claimed_payload
          FROM tasks t
          INNER JOIN task_runs r ON r.id = t.current_run_id AND r.task_id = t.id
          ORDER BY t.id, r.id
        `)
        .all()
    } finally {
      db.close()
    }

    const actors = []
    for (const row of rows) {
      let claimedFromReview = false
      try {
        claimedFromReview = JSON.parse(row.claimed_payload || 'null')?.source_status === 'review'
      } catch {
        // Missing or malformed lifecycle metadata cannot truthfully establish review provenance.
      }
      const lifecycleState = actorLifecycleState(row.task_status, row.run_status, claimedFromReview)
      if (!lifecycleState) continue
      const taskId = String(row.task_id)
      const runId = Number(row.run_id)
      const sessionId = validSessionId(row.session_id) ? row.session_id : ''
      const heartbeatAt = Math.max(
        epochMilliseconds(row.run_last_heartbeat_at),
        epochMilliseconds(row.task_last_heartbeat_at)
      )
      actors.push({
        id: `hermes-kanban:actor:${taskId}:${runId}`,
        taskId,
        runId,
        profile: String(row.profile || ''),
        lifecycleState,
        heartbeat: actorHeartbeat(heartbeatAt, now()),
        requiresMorgan: attentionFor(row.task_status, row.block_kind).requiresMorgan,
        managingSession: { id: sessionId, canOpen: Boolean(sessionId) },
        steward: 'Jynx',
      })
    }
    return actors
  }

  /** Ordered native lifecycle tail. Unknown events advance the cursor but never reach the UI. */
  async function scanActorEvents(since = 0) {
    const cursor = Math.max(0, Number(since) || 0)
    const db = new DatabaseSync(databasePath(env), { readOnly: true })
    try {
      const rows = db
        .prepare(`
          SELECT id, task_id, run_id, kind, payload, created_at
          FROM task_events
          WHERE id > ?
          ORDER BY id ASC
          LIMIT 200
        `)
        .all(cursor)
      let nextCursor = cursor
      const events = []
      for (const row of rows) {
        nextCursor = Number(row.id)
        if (!ACTOR_EVENT_VOCABULARY.includes(row.kind)) continue
        let payload = null
        try {
          payload = row.payload ? JSON.parse(row.payload) : null
        } catch {
          payload = null
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

  function openThread(ref) {
    if (!validSessionId(ref?.sessionId)) return { ok: false, error: 'No managing Hermes session is available' }
    return { ok: true, url: `hermes://open/${encodeURIComponent(ref.sessionId)}` }
  }

  async function setArchived(ref, archived) {
    if (archived !== true) return { ok: false, error: 'Hermes Kanban unarchive is not supported' }
    const taskId = ref?.taskId
    if (
      typeof taskId !== 'string' ||
      !TASK_ID.test(taskId) ||
      ref?.board !== 'native' ||
      ref?.threadId !== `hermes-kanban:${taskId}`
    ) {
      return { ok: false, error: 'Invalid Hermes Kanban task reference' }
    }

    await execFile('hermes', ['kanban', '--board', 'native', 'archive', taskId])

    const db = new DatabaseSync(databasePath(env), { readOnly: true })
    try {
      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId)
      if (!task) throw new Error(`Archived task ${taskId} could not be read back from native board`)
      if (task.status !== 'archived') throw new Error(`Archived task ${taskId} did not report archived status`)
    } finally {
      db.close()
    }
    return { ok: true, archived: true }
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
    openThread,
    newSession: () => ({ ok: false, error: 'Hermes Kanban cannot start conversations from Bot Crossing' }),
    setArchived,
  }
}

export default createHermesKanban()
