import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

import { createHermesKanban } from '../server/harnesses/hermes-kanban.mjs'

const execFileAsync = promisify(execFile)
const temporaryHomes = []

async function fixtureHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-hermes-'))
  temporaryHomes.push(home)
  const boardDir = path.join(home, 'kanban', 'boards', 'native')
  await fsp.mkdir(boardDir, { recursive: true })
  const databasePath = path.join(boardDir, 'kanban.db')
  const db = new DatabaseSync(databasePath)
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
      workspace_kind TEXT NOT NULL DEFAULT 'scratch', workspace_path TEXT, branch_name TEXT,
      project_id TEXT, tenant TEXT, current_run_id INTEGER, block_kind TEXT,
      last_heartbeat_at INTEGER, session_id TEXT
    );
    CREATE TABLE task_runs (
      id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, profile TEXT, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, last_heartbeat_at INTEGER
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER,
      kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL
    );
  `)
  db.close()
  return { home, databasePath }
}

function createProjectsDatabase(file, rows) {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    primary_path TEXT, archived INTEGER NOT NULL DEFAULT 0
  )`)
  const insert = db.prepare(
    'INSERT INTO projects (id, slug, name, primary_path, archived) VALUES ($id, $slug, $name, $primary_path, $archived)'
  )
  for (const row of rows) insert.run({ primary_path: null, archived: 0, ...row })
  db.close()
}

function insertTask(databasePath, overrides = {}) {
  const task = {
    id: 't_default', title: 'Default task', body: '', assignee: 'builder', status: 'ready',
    created_at: 100, started_at: null, completed_at: null, workspace_kind: 'scratch',
    workspace_path: null, branch_name: null, project_id: null, tenant: null,
    current_run_id: null, block_kind: null, last_heartbeat_at: null, session_id: null,
    ...overrides,
  }
  const db = new DatabaseSync(databasePath)
  db.prepare(`INSERT INTO tasks (
    id, title, body, assignee, status, created_at, started_at, completed_at,
    workspace_kind, workspace_path, branch_name, project_id, tenant, current_run_id,
    block_kind, last_heartbeat_at, session_id
  ) VALUES (
    $id, $title, $body, $assignee, $status, $created_at, $started_at, $completed_at,
    $workspace_kind, $workspace_path, $branch_name, $project_id, $tenant, $current_run_id,
    $block_kind, $last_heartbeat_at, $session_id
  )`).run(task)
  db.close()
}

function insertRun(databasePath, overrides = {}) {
  const run = {
    id: 1, task_id: 't_default', profile: 'builder', status: 'running', started_at: 110,
    ended_at: null, last_heartbeat_at: null, ...overrides,
  }
  const db = new DatabaseSync(databasePath)
  db.prepare(`INSERT INTO task_runs (
    id, task_id, profile, status, started_at, ended_at, last_heartbeat_at
  ) VALUES ($id, $task_id, $profile, $status, $started_at, $ended_at, $last_heartbeat_at)`).run(run)
  db.close()
}

function insertEvent(databasePath, overrides = {}) {
  const event = {
    task_id: 't_default', run_id: 1, kind: 'claimed', payload: null, created_at: 110,
    ...overrides,
  }
  const db = new DatabaseSync(databasePath)
  db.prepare(`INSERT INTO task_events (task_id, run_id, kind, payload, created_at)
    VALUES ($task_id, $run_id, $kind, $payload, $created_at)`).run(event)
  db.close()
}

async function gitRepositoryFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-repository-'))
  temporaryHomes.push(root)
  await execFileAsync('git', ['init', root])
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'bot-crossing@example.test'])
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Bot Crossing Test'])
  await fsp.writeFile(path.join(root, 'fixture.txt'), 'fixture\n')
  await execFileAsync('git', ['-C', root, 'add', 'fixture.txt'])
  await execFileAsync('git', ['-C', root, 'commit', '-m', 'fixture'])
  const first = `${root}-first`
  const second = `${root}-second`
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '-b', 'fixture/first', first])
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '-b', 'fixture/second', second])
  temporaryHomes.push(first, second)
  return { root, first, second }
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((home) => fsp.rm(home, { recursive: true, force: true })))
})

test('aggregates profile-independent active projects while retaining quiet repositories', async () => {
  const { home } = await fixtureHome()
  const sharedPath = path.join(home, 'repositories', 'shared')
  const builderHome = path.join(home, 'profiles', 'builder')
  const reviewerHome = path.join(home, 'profiles', 'reviewer')
  await Promise.all([
    fsp.mkdir(sharedPath, { recursive: true }),
    fsp.mkdir(builderHome, { recursive: true }),
    fsp.mkdir(reviewerHome, { recursive: true }),
  ])
  createProjectsDatabase(path.join(home, 'projects.db'), [
    { id: 'p_root', slug: 'root', name: 'Root', primary_path: '/work/root' },
    { id: 'p_old', slug: 'old', name: 'Old', primary_path: '/work/old', archived: 1 },
  ])
  createProjectsDatabase(path.join(builderHome, 'projects.db'), [
    { id: 'p_shared_builder', slug: 'shared-builder', name: 'Shared', primary_path: sharedPath },
    { id: 'p_quiet', slug: 'quiet', name: 'Quiet', primary_path: '/work/quiet' },
  ])
  createProjectsDatabase(path.join(reviewerHome, 'projects.db'), [
    { id: 'p_shared_reviewer', slug: 'shared-reviewer', name: 'Shared duplicate', primary_path: `${sharedPath}/.` },
  ])

  const projects = await createHermesKanban({ env: { HERMES_HOME: builderHome } }).scanProjects()

  assert.deepEqual(projects, [
    { id: 'p_quiet', slug: 'quiet', name: 'Quiet', path: '/work/quiet' },
    { id: 'p_root', slug: 'root', name: 'Root', path: '/work/root' },
    { id: 'p_shared_builder', slug: 'shared-builder', name: 'Shared', path: await fsp.realpath(sharedPath) },
  ])
})

test('projects only visible native tasks with explicit attention and no mutation capability', async () => {
  const { home, databasePath } = await fixtureHome()
  for (const status of ['ready', 'running', 'review', 'blocked', 'todo', 'done', 'triage', 'archived']) {
    insertTask(databasePath, {
      id: `t_${status}`,
      title: `${status} task`,
      body: `Body for ${status}`,
      status,
      block_kind: status === 'blocked' ? 'needs_input' : null,
    })
  }

  const threads = await createHermesKanban({ env: { HERMES_HOME: home } }).scanThreads()
  const byTask = Object.fromEntries(threads.map((thread) => [thread.ref.taskId, thread]))

  assert.deepEqual(Object.keys(byTask).sort(), ['t_blocked', 't_ready', 't_review', 't_running'])
  assert.deepEqual(
    Object.fromEntries(Object.entries(byTask).map(([id, thread]) => [id, {
      running: thread.running,
      hasError: thread.hasError,
      attention: thread.ref.attention,
      requiresMorgan: thread.requiresMorgan,
      canArchive: thread.canArchive,
    }])),
    {
      t_ready: { running: false, hasError: false, attention: 'none', requiresMorgan: false, canArchive: false },
      t_running: { running: true, hasError: false, attention: 'none', requiresMorgan: false, canArchive: false },
      t_review: { running: false, hasError: false, attention: 'review', requiresMorgan: false, canArchive: false },
      t_blocked: { running: false, hasError: true, attention: 'needs_input', requiresMorgan: true, canArchive: false },
    }
  )
})

test('triage escalation remains visible while Jynx stays thread-derived', async () => {
  const { home, databasePath } = await fixtureHome()
  insertTask(databasePath, {
    id: 't_triage_input', status: 'triage', block_kind: 'needs_input', current_run_id: null,
  })
  insertTask(databasePath, {
    id: 't_triage_capability', status: 'triage', block_kind: 'capability', current_run_id: null,
  })
  const adapter = createHermesKanban({ env: { HERMES_HOME: home } })

  const threads = Object.fromEntries((await adapter.scanThreads()).map((thread) => [thread.ref.taskId, thread]))
  const actors = Object.fromEntries((await adapter.scanActors()).map((actor) => [actor.taskId, actor]))

  assert.deepEqual(Object.keys(threads).sort(), ['t_triage_capability', 't_triage_input'])
  assert.deepEqual(
    Object.fromEntries(Object.entries(threads).map(([id, thread]) => [id, {
      attention: thread.ref.attention,
      requiresMorgan: thread.requiresMorgan,
      hasError: thread.hasError,
    }])),
    {
      t_triage_input: { attention: 'needs_input', requiresMorgan: true, hasError: true },
      t_triage_capability: { attention: 'capability', requiresMorgan: true, hasError: true },
    }
  )
  assert.deepEqual(actors, {})
})

test('groups a repository root and sibling worktrees by canonical Git common directory', async () => {
  const { home, databasePath } = await fixtureHome()
  const repository = await gitRepositoryFixture()
  insertTask(databasePath, { id: 't_root', workspace_path: repository.root, branch_name: 'main' })
  insertTask(databasePath, {
    id: 't_first', workspace_kind: 'worktree', workspace_path: repository.first, branch_name: 'fixture/first',
  })
  insertTask(databasePath, {
    id: 't_second', workspace_kind: 'worktree', workspace_path: repository.second, branch_name: 'fixture/second',
  })

  const threads = await createHermesKanban({ env: { HERMES_HOME: home } }).scanThreads()

  assert.equal(new Set(threads.map(({ repositoryId }) => repositoryId)).size, 1)
  assert.deepEqual(new Set(threads.map(({ repositoryPath }) => repositoryPath)), new Set([await fsp.realpath(repository.root)]))
  assert.deepEqual(threads.map(({ gitBranch }) => gitBranch).sort(), ['fixture/first', 'fixture/second', 'main'])
})

test('bounds and times out repository identity probes', async () => {
  const { home, databasePath } = await fixtureHome()
  let active = 0
  let peak = 0
  const options = []
  for (let index = 0; index < 12; index++) {
    insertTask(databasePath, { id: `t_repo_${index}`, workspace_path: `/work/repo-${index}` })
  }
  const execFile = async (_command, args, commandOptions) => {
    active++
    peak = Math.max(peak, active)
    options.push(commandOptions)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return { stdout: `${args[1]}/.git\n` }
  }

  await createHermesKanban({ env: { HERMES_HOME: home }, execFile }).scanThreads()

  assert.ok(peak <= 4, `expected at most four Git probes, observed ${peak}`)
  assert.ok(options.every(({ timeout, maxBuffer }) => timeout === 1500 && maxBuffer === 64 * 1024))
})

test('projects actors only from authoritative current worker runs', async () => {
  const { home, databasePath } = await fixtureHome()
  insertTask(databasePath, {
    id: 't_builder', status: 'running', current_run_id: 11, session_id: 'builder-session', last_heartbeat_at: 995,
  })
  insertRun(databasePath, {
    id: 11, task_id: 't_builder', profile: 'builder', status: 'running', last_heartbeat_at: 999,
  })
  insertTask(databasePath, { id: 't_reviewer', status: 'review', current_run_id: 12 })
  insertRun(databasePath, { id: 12, task_id: 't_reviewer', profile: 'reviewer', status: 'running' })
  insertTask(databasePath, { id: 't_drone', status: 'blocked', block_kind: 'dependency', current_run_id: 13 })
  insertRun(databasePath, { id: 13, task_id: 't_drone', profile: 'drone', status: 'blocked' })
  insertTask(databasePath, {
    id: 't_attention', status: 'blocked', block_kind: 'needs_input', current_run_id: null,
    session_id: 'stale-session', last_heartbeat_at: 900,
  })
  insertTask(databasePath, { id: 't_stale_link', status: 'running', current_run_id: null, session_id: 'old-session' })
  insertRun(databasePath, { id: 14, task_id: 't_stale_link', profile: 'builder', status: 'running' })
  insertTask(databasePath, { id: 't_other_profile', status: 'running', current_run_id: 15 })
  insertRun(databasePath, { id: 15, task_id: 't_other_profile', profile: 'writer', status: 'running' })
  const adapter = createHermesKanban({ env: { HERMES_HOME: home }, now: () => 1_000_000 })

  const actors = Object.fromEntries((await adapter.scanActors()).map((actor) => [actor.taskId, actor]))

  assert.deepEqual(Object.keys(actors).sort(), ['t_builder', 't_drone', 't_reviewer'])
  assert.deepEqual(actors.t_builder, {
    id: 'hermes-kanban:actor:t_builder:11', taskId: 't_builder', runId: 11, profile: 'builder',
    lifecycleState: 'working', heartbeat: { lastAt: 999000, freshness: 'fresh' }, requiresMorgan: false,
    managingSession: { id: 'builder-session', canOpen: false },
  })
  assert.equal(actors.t_reviewer.lifecycleState, 'reviewing')
  assert.equal(actors.t_drone.lifecycleState, 'waiting')
})

test('suppresses terminal current runs instead of rendering stale workers', async () => {
  const { home, databasePath } = await fixtureHome()
  const terminal = ['done', 'completed', 'crashed', 'timed_out', 'spawn_failed', 'reclaimed', 'gave_up']
  terminal.forEach((status, index) => {
    const id = index + 20
    insertTask(databasePath, { id: `t_${status}`, status: 'running', current_run_id: id })
    insertRun(databasePath, { id, task_id: `t_${status}`, status })
  })

  const actors = await createHermesKanban({ env: { HERMES_HOME: home } }).scanActors()

  assert.deepEqual(actors, [])
})

test('tails ordered bounded lifecycle events while advancing the cursor past unrelated evidence', async () => {
  const { home, databasePath } = await fixtureHome()
  insertEvent(databasePath, { task_id: 't_live', run_id: 7, kind: 'claimed', payload: '{"source_status":"ready"}' })
  insertEvent(databasePath, { task_id: 't_live', run_id: 7, kind: 'edited', payload: '{"title":"new"}' })
  insertEvent(databasePath, { task_id: 't_live', run_id: 7, kind: 'heartbeat', payload: 'not-json', created_at: 112 })
  const adapter = createHermesKanban({ env: { HERMES_HOME: home } })

  const first = await adapter.scanActorEvents(0)
  const second = await adapter.scanActorEvents(first.cursor)

  assert.equal(await adapter.actorEventCursor(), 3)
  assert.deepEqual(first, {
    cursor: 3,
    events: [
      { id: 1, taskId: 't_live', runId: 7, kind: 'claimed', payload: { source_status: 'ready' }, createdAt: 110000 },
      { id: 3, taskId: 't_live', runId: 7, kind: 'heartbeat', payload: null, createdAt: 112000 },
    ],
  })
  assert.deepEqual(second, { cursor: 3, events: [] })
})
