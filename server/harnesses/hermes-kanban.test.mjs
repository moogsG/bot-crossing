import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import hermesKanban, { createHermesKanban } from './hermes-kanban.mjs'
import { HARNESSES } from './index.mjs'

const temporaryHomes = []
const originalHermesHome = process.env.HERMES_HOME

async function fixtureHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-hermes-'))
  temporaryHomes.push(home)
  const boardDir = path.join(home, 'kanban', 'boards', 'native')
  await fsp.mkdir(boardDir, { recursive: true })
  const databasePath = path.join(boardDir, 'kanban.db')
  const db = new DatabaseSync(databasePath)
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      assignee TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      workspace_kind TEXT NOT NULL DEFAULT 'scratch',
      workspace_path TEXT,
      branch_name TEXT,
      project_id TEXT,
      tenant TEXT,
      current_run_id INTEGER,
      block_kind TEXT,
      last_heartbeat_at INTEGER,
      session_id TEXT
    );
    CREATE TABLE task_runs (
      id INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL,
      profile TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_heartbeat_at INTEGER
    );
  `)
  db.close()
  return { home, databasePath }
}

function createProjectsDatabase(home, rows) {
  const db = new DatabaseSync(path.join(home, 'projects.db'))
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      primary_path TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    )
  `)
  const insert = db.prepare(
    'INSERT INTO projects (id, slug, name, primary_path, archived) VALUES ($id, $slug, $name, $primary_path, $archived)'
  )
  for (const row of rows) insert.run({ archived: 0, primary_path: null, ...row })
  db.close()
}

function insertTask(databasePath, overrides = {}) {
  const task = {
    id: 't_default',
    title: 'Default task',
    body: '',
    assignee: 'builder',
    status: 'ready',
    created_at: 100,
    started_at: null,
    completed_at: null,
    workspace_kind: 'scratch',
    workspace_path: null,
    branch_name: null,
    project_id: null,
    tenant: null,
    current_run_id: null,
    block_kind: null,
    last_heartbeat_at: null,
    session_id: null,
    ...overrides,
  }
  const db = new DatabaseSync(databasePath)
  db.prepare(`
    INSERT INTO tasks (
      id, title, body, assignee, status, created_at, started_at, completed_at,
      workspace_kind, workspace_path, branch_name, project_id, tenant, current_run_id, block_kind,
      last_heartbeat_at, session_id
    ) VALUES (
      $id, $title, $body, $assignee, $status, $created_at, $started_at, $completed_at,
      $workspace_kind, $workspace_path, $branch_name, $project_id, $tenant, $current_run_id, $block_kind,
      $last_heartbeat_at, $session_id
    )
  `).run(task)
  db.close()
}

function insertRun(databasePath, overrides = {}) {
  const run = {
    id: 1,
    task_id: 't_default',
    profile: 'builder',
    status: 'running',
    started_at: 110,
    ended_at: null,
    last_heartbeat_at: null,
    ...overrides,
  }
  const db = new DatabaseSync(databasePath)
  db.prepare(`
    INSERT INTO task_runs (id, task_id, profile, status, started_at, ended_at, last_heartbeat_at)
    VALUES ($id, $task_id, $profile, $status, $started_at, $ended_at, $last_heartbeat_at)
  `).run(run)
  db.close()
}

afterEach(async () => {
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  await Promise.all(temporaryHomes.splice(0).map((home) => fsp.rm(home, { recursive: true, force: true })))
})

test('detects the native board database under HERMES_HOME', async () => {
  const { home } = await fixtureHome()
  process.env.HERMES_HOME = home
  assert.equal(await hermesKanban.detect(), true)

  process.env.HERMES_HOME = path.join(home, 'missing')
  assert.equal(await hermesKanban.detect(), false)
})

test('resolves the shared Hermes home from a profile-scoped HERMES_HOME', async () => {
  const { home } = await fixtureHome()
  process.env.HERMES_HOME = path.join(home, 'profiles', 'builder')
  await fsp.mkdir(process.env.HERMES_HOME, { recursive: true })

  assert.equal(await hermesKanban.detect(), true)
})

test('reads active projects from the profile-scoped HERMES_HOME without mutating the registry', async () => {
  const { home } = await fixtureHome()
  const profileHome = path.join(home, 'profiles', 'jynx')
  await fsp.mkdir(profileHome, { recursive: true })
  createProjectsDatabase(profileHome, [
    { id: 'p_active', slug: 'fleet-pilot', name: 'Hermes Fleet Pilot', primary_path: '/work/fleet-pilot' },
    { id: 'p_quiet', slug: 'perch', name: 'Perch', primary_path: '/work/perch' },
    { id: 'p_old', slug: 'old', name: 'Old', primary_path: '/work/old', archived: 1 },
  ])
  process.env.HERMES_HOME = profileHome
  const before = await fsp.readFile(path.join(profileHome, 'projects.db'))

  const projects = await hermesKanban.scanProjects()

  assert.deepEqual(projects, [
    { id: 'p_active', slug: 'fleet-pilot', name: 'Hermes Fleet Pilot', path: '/work/fleet-pilot' },
    { id: 'p_quiet', slug: 'perch', name: 'Perch', path: '/work/perch' },
  ])
  assert.deepEqual(await fsp.readFile(path.join(profileHome, 'projects.db')), before)
})

test('scans only active native-board task statuses', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  for (const status of ['ready', 'running', 'review', 'blocked', 'todo', 'done', 'triage']) {
    insertTask(databasePath, { id: `t_${status}`, status, title: status })
  }

  const threads = await hermesKanban.scanThreads()

  assert.deepEqual(
    threads.map(({ id }) => id).sort(),
    ['hermes-kanban:t_blocked', 'hermes-kanban:t_ready', 'hermes-kanban:t_review', 'hermes-kanban:t_running']
  )
})

test('resolves products by project, tenant, workspace basename, then Other', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  insertTask(databasePath, {
    id: 't_project',
    project_id: 'product-project',
    tenant: 'product-tenant',
    workspace_path: '/work/product-workspace',
  })
  insertTask(databasePath, { id: 't_tenant', tenant: 'product-tenant', workspace_path: '/work/product-workspace' })
  insertTask(databasePath, { id: 't_workspace', workspace_path: '/work/product-workspace' })
  insertTask(databasePath, { id: 't_other' })

  const threads = Object.fromEntries((await hermesKanban.scanThreads()).map((thread) => [thread.ref.taskId, thread]))

  assert.equal(threads.t_project.project, 'product-project')
  assert.equal(threads.t_tenant.project, 'product-tenant')
  assert.equal(threads.t_workspace.project, 'product-workspace')
  assert.equal(threads.t_other.project, 'Other')
})

test('maps Kanban states to working, waiting, and blocked semantics', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  for (const status of ['ready', 'running', 'review', 'blocked']) {
    insertTask(databasePath, { id: `t_${status}`, status })
  }

  const threads = Object.fromEntries((await hermesKanban.scanThreads()).map((thread) => [thread.ref.taskId, thread]))

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(threads).map(([id, thread]) => [
        id,
        {
          running: thread.running,
          unread: thread.unread,
          hasError: thread.hasError,
          status: thread.ref.status,
          attention: thread.ref.attention,
        },
      ])
    ),
    {
      t_ready: { running: false, unread: false, hasError: false, status: 'ready', attention: 'none' },
      t_running: { running: true, unread: false, hasError: false, status: 'running', attention: 'none' },
      t_review: { running: false, unread: false, hasError: false, status: 'review', attention: 'review' },
      t_blocked: { running: false, unread: false, hasError: true, status: 'blocked', attention: 'blocked' },
    }
  )
})

test('preserves user-facing blocked attention metadata behind blocked UI semantics', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  insertTask(databasePath, { id: 't_input', status: 'blocked', block_kind: 'needs_input' })

  const [thread] = await hermesKanban.scanThreads()

  assert.equal(thread.hasError, true)
  assert.equal(thread.unread, false)
  assert.equal(thread.ref.status, 'blocked')
  assert.equal(thread.ref.attention, 'needs_input')
})

test('distinguishes Morgan attention, internal waits, review, and generic blocked states', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  for (const blockKind of ['needs_input', 'capability', 'dependency', 'transient', null, 'unexpected']) {
    insertTask(databasePath, { id: `t_${blockKind || 'missing'}`, status: 'blocked', block_kind: blockKind })
  }
  insertTask(databasePath, { id: 't_review_attention', status: 'review' })

  const threads = Object.fromEntries((await hermesKanban.scanThreads()).map((thread) => [thread.ref.taskId, thread]))

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(threads).map(([id, thread]) => [id, [thread.requiresMorgan, thread.attentionLabel]])
    ),
    {
      t_needs_input: [true, 'Requires Morgan'],
      t_capability: [true, 'Requires Morgan'],
      t_dependency: [false, 'Internal wait'],
      t_transient: [false, 'Internal wait'],
      t_missing: [false, 'Blocked'],
      t_unexpected: [false, 'Blocked'],
      t_review_attention: [false, 'In review'],
    }
  )
})

test('presents Jynx as steward and annotates the current worker run secondarily', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  insertTask(databasePath, { id: 't_owned', assignee: 'reviewer', status: 'running', current_run_id: 42 })
  insertRun(databasePath, { id: 42, task_id: 't_owned', profile: 'builder', status: 'running' })

  const [thread] = await hermesKanban.scanThreads()

  assert.equal(thread.model, 'Jynx')
  assert.equal(thread.ref.steward, 'Jynx')
  assert.deepEqual(thread.ref.worker, { assignee: 'reviewer', profile: 'builder', runStatus: 'running' })
  assert.equal(thread.requiresMorgan, false)
  assert.equal(thread.attentionLabel, '')
})

test('maps task details and heartbeat without consulting run end time', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  insertTask(databasePath, {
    id: 't_details',
    title: 'Operational detail',
    body: 'Useful task summary',
    status: 'running',
    project_id: 'p_product',
    tenant: 'tenant-product',
    workspace_kind: 'worktree',
    workspace_path: '/work/product/.worktrees/t_details',
    branch_name: 'product/t_details',
    current_run_id: 7,
    last_heartbeat_at: 140,
  })
  insertRun(databasePath, {
    id: 7,
    task_id: 't_details',
    profile: 'builder',
    ended_at: 999999,
    last_heartbeat_at: 150,
  })

  const [thread] = await hermesKanban.scanThreads()

  assert.deepEqual(thread.details, {
    taskId: 't_details',
    body: 'Useful task summary',
    kanbanStatus: 'running',
    projectId: 'p_product',
    tenant: 'tenant-product',
    workspace: '/work/product/.worktrees/t_details',
    workspaceKind: 'worktree',
    branch: 'product/t_details',
    steward: 'Jynx',
    assignee: 'builder',
    runProfile: 'builder',
    runStatus: 'running',
    lastHeartbeatAt: 150000,
  })
  assert.equal(JSON.stringify(thread).includes('999999'), false)
})

test('opens only valid managing sessions with the supported encoded desktop deep link', () => {
  assert.deepEqual(hermesKanban.openThread({ sessionId: 'session/with spaces' }), {
    ok: true,
    url: 'hermes://open/session%2Fwith%20spaces',
  })
  assert.equal(hermesKanban.openThread({ sessionId: '' }).ok, false)
  assert.equal(hermesKanban.openThread({ sessionId: 42 }).ok, false)
})

test('returns a complete Thread contract with stable serializable refs and no undefined fields', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  insertTask(databasePath, {
    id: 't_contract',
    title: '',
    body: null,
    status: 'running',
    created_at: 100,
    started_at: 120,
    workspace_kind: 'worktree',
    workspace_path: '/work/repo/.worktrees/t_contract',
    branch_name: null,
    current_run_id: 9,
  })
  insertRun(databasePath, { id: 9, task_id: 't_contract', profile: null, started_at: 130 })

  const [first] = await hermesKanban.scanThreads()
  const [second] = await hermesKanban.scanThreads()

  assert.deepEqual(
    {
      id: first.id,
      title: first.title,
      preview: first.preview,
      projectPath: first.projectPath,
      worktree: first.worktree,
      cwd: first.cwd,
      gitBranch: first.gitBranch,
      createdAt: first.createdAt,
      lastActivityAt: first.lastActivityAt,
      canOpen: first.canOpen,
      canArchive: first.canArchive,
      source: first.source,
    },
    {
      id: 'hermes-kanban:t_contract',
      title: 'Untitled task',
      preview: '',
      projectPath: '/work/repo/.worktrees/t_contract',
      worktree: 't_contract',
      cwd: '/work/repo/.worktrees/t_contract',
      gitBranch: '',
      createdAt: 100000,
      lastActivityAt: 130000,
      canOpen: false,
      canArchive: true,
      source: 'native-kanban',
    }
  )
  assert.deepEqual(first.ref, second.ref)
  assert.deepEqual(JSON.parse(JSON.stringify(first.ref)), first.ref)
  assert.equal(Object.values(first).includes(undefined), false)
  assert.equal(Object.values(first.ref).includes(undefined), false)
  assert.equal(Object.values(first.ref.worker).includes(undefined), false)
})

test('scans a read-only database without mutating Kanban state', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  insertTask(databasePath, { id: 't_read_only', status: 'running' })
  const snapshot = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true })
    const state = {
      tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
      runs: db.prepare('SELECT * FROM task_runs ORDER BY id').all(),
    }
    db.close()
    return state
  }
  const before = snapshot()
  await fsp.chmod(databasePath, 0o444)

  const threads = await hermesKanban.scanThreads()

  assert.equal(threads.length, 1)
  assert.deepEqual(snapshot(), before)
})

test('archives with canonical CLI arguments and verifies exact native-board readback', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  insertTask(databasePath, { id: 't_disposable', status: 'ready' })
  const calls = []
  const adapter = createHermesKanban({
    execFile: async (command, args) => {
      calls.push([command, args])
      const db = new DatabaseSync(databasePath)
      db.prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run('t_disposable')
      db.close()
    },
  })
  const ref = { taskId: 't_disposable', threadId: 'hermes-kanban:t_disposable', board: 'native', sessionId: '' }

  assert.deepEqual(await adapter.setArchived(ref, true), { ok: true, archived: true })
  assert.deepEqual(calls, [['hermes', ['kanban', '--board', 'native', 'archive', 't_disposable']]])
})

test('refuses unarchive and malformed or mismatched archive refs before invoking the CLI', async () => {
  const calls = []
  const adapter = createHermesKanban({ execFile: async (...args) => calls.push(args) })
  const valid = { taskId: 't_disposable', threadId: 'hermes-kanban:t_disposable', board: 'native', sessionId: '' }

  assert.equal((await adapter.setArchived(valid, false)).ok, false)
  assert.equal((await adapter.setArchived({ ...valid, taskId: '../task' }, true)).ok, false)
  assert.equal((await adapter.setArchived({ ...valid, threadId: 'hermes-kanban:t_other' }, true)).ok, false)
  assert.equal((await adapter.setArchived({ ...valid, board: 'other' }, true)).ok, false)
  assert.deepEqual(calls, [])
})

test('fails archive when exact post-command readback is missing or not archived', async () => {
  const { home, databasePath } = await fixtureHome()
  process.env.HERMES_HOME = home
  insertTask(databasePath, { id: 't_disposable', status: 'ready' })
  const adapter = createHermesKanban({ execFile: async () => {} })
  const ref = { taskId: 't_disposable', threadId: 'hermes-kanban:t_disposable', board: 'native', sessionId: '' }

  await assert.rejects(adapter.setArchived(ref, true), /did not report archived/)
  const missing = { ...ref, taskId: 't_missing', threadId: 'hermes-kanban:t_missing' }
  await assert.rejects(adapter.setArchived(missing, true), /could not be read back/)
})

test('registers only the native Kanban Hermes adapter', () => {
  assert.equal(HARNESSES.filter(({ id }) => id === 'hermes-kanban').length, 1)
  assert.equal(HARNESSES.some(({ id }) => id === 'hermes'), false)
})
