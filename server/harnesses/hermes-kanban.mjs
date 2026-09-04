import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function databasePath() {
  const configuredHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
  const hermesHome =
    path.basename(path.dirname(configuredHome)) === 'profiles' ? path.dirname(path.dirname(configuredHome)) : configuredHome
  return path.join(hermesHome, 'kanban', 'boards', 'native', 'kanban.db')
}

const epochMilliseconds = (seconds) => (Number(seconds) || 0) * 1000

async function detect() {
  try {
    await fsp.access(databasePath())
    return true
  } catch {
    return false
  }
}

async function scanThreads() {
  const db = new DatabaseSync(databasePath(), { readOnly: true })
  try {
    return db
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
          r.profile AS run_profile,
          r.status AS run_status,
          r.started_at AS run_started_at
        FROM tasks t
        LEFT JOIN task_runs r ON r.id = t.current_run_id AND r.task_id = t.id
        WHERE t.status IN ('ready', 'running', 'review', 'blocked')
      `)
      .all()
      .map((task) => {
        const workspaceName = String(task.workspace_path || '')
          .split(/[\\/]/)
          .filter(Boolean)
          .at(-1)
        const workspacePath = String(task.workspace_path || '')
        const preview = String(task.body || '').replace(/\s+/g, ' ').trim().slice(0, 240)
        return {
          id: `hermes-kanban:${task.id}`,
          title: String(task.title || 'Untitled task'),
          preview,
          project: String(task.project_id || task.tenant || workspaceName || 'Other'),
          projectPath: workspacePath,
          worktree: task.workspace_kind === 'worktree' ? String(workspaceName || '') : '',
          cwd: workspacePath,
          gitBranch: String(task.branch_name || ''),
          model: 'Jynx',
          effort: '',
          createdAt: epochMilliseconds(task.created_at),
          lastActivityAt: Math.max(
            epochMilliseconds(task.run_started_at),
            epochMilliseconds(task.started_at),
            epochMilliseconds(task.created_at)
          ),
          lastFocusedAt: 0,
          running: task.status === 'running',
          unread: task.status === 'review',
          hasError: task.status === 'blocked',
          starred: false,
          routine: '',
          prState: '',
          archived: false,
          sizeBytes: Buffer.byteLength(String(task.body || '')),
          source: 'native-kanban',
          canOpen: false,
          canArchive: false,
          ref: {
            taskId: String(task.id),
            readOnly: true,
            status: String(task.status),
            attention:
              task.status === 'review' ? 'review' : task.status === 'blocked' ? String(task.block_kind || 'blocked') : 'none',
            steward: 'Jynx',
            worker: {
              assignee: String(task.assignee || ''),
              profile: String(task.run_profile || ''),
              runStatus: String(task.run_status || ''),
            },
          },
        }
      })
  } finally {
    db.close()
  }
}

const unsupported = () => ({ ok: false, error: 'Hermes Kanban is read-only in Bot Crossing' })

async function setArchived() {
  return unsupported()
}

export default {
  id: 'hermes-kanban',
  name: 'Hermes Kanban',
  detect,
  scanThreads,
  openThread: unsupported,
  newSession: unsupported,
  setArchived,
}
