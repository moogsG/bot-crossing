import assert from 'node:assert/strict'
import { test } from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apiMiddleware, readActorSnapshot } from '../server/api.mjs'

function responseCapture() {
  let status
  let headers
  let body = ''
  return {
    response: {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        headers = nextHeaders
      },
      end(chunk = '') {
        body += chunk
      },
    },
    result: () => ({ status, headers, body: JSON.parse(body) }),
  }
}

async function request(url) {
  const capture = responseCapture()
  await apiMiddleware({ url, method: 'GET', headers: { host: 'localhost:5274' } }, capture.response)
  return capture.result()
}

test('actor snapshots stabilize their event boundary and reject perpetually moving truth', async () => {
  const actor = { id: 'hermes-kanban:actor:t_live:7', taskId: 't_live', runId: 7 }
  const cursors = [20, 21, 21]
  const scans = [[], [actor]]

  const snapshot = await readActorSnapshot({
    readCursor: async () => cursors.shift(),
    readActors: async () => scans.shift(),
  })

  assert.deepEqual(snapshot, { actors: [actor], cursor: 20, through: 21 })

  let cursor = 0
  await assert.rejects(
    readActorSnapshot({
      readCursor: async () => cursor++,
      readActors: async () => [actor],
    }),
    /kept changing/
  )
})

test('read-only Hermes endpoints expose projects, current actors, and ordered events', async () => {
  const originalHome = process.env.HERMES_HOME
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-hermes-api-'))
  try {
    const boardDir = path.join(home, 'kanban', 'boards', 'native')
    await fsp.mkdir(boardDir, { recursive: true })
    const db = new DatabaseSync(path.join(boardDir, 'kanban.db'))
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, block_kind TEXT, last_heartbeat_at INTEGER,
        session_id TEXT, current_run_id INTEGER
      );
      CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, profile TEXT, status TEXT NOT NULL,
        last_heartbeat_at INTEGER
      );
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER,
        kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL
      );
      INSERT INTO tasks VALUES ('t_api', 'running', NULL, 100, NULL, 7);
      INSERT INTO task_runs VALUES (7, 't_api', 'builder', 'running', 100);
      INSERT INTO task_events (task_id, run_id, kind, payload, created_at)
        VALUES ('t_api', 7, 'claimed', '{"source_status":"ready"}', 101);
    `)
    db.close()
    const projects = new DatabaseSync(path.join(home, 'projects.db'))
    projects.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        primary_path TEXT, archived INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO projects VALUES ('p_quiet', 'quiet', 'Quiet repository', '/work/quiet', 0);
    `)
    projects.close()
    process.env.HERMES_HOME = home

    const projectResponse = await request('/api/projects')
    const actorResponse = await request('/api/actors')
    const eventResponse = await request('/api/events?since=0')

    assert.equal(projectResponse.status, 200)
    assert.deepEqual(projectResponse.body.projects, [
      { id: 'p_quiet', slug: 'quiet', name: 'Quiet repository', path: '/work/quiet' },
    ])
    assert.equal(actorResponse.status, 200)
    assert.equal(actorResponse.headers['Cache-Control'], 'no-store')
    assert.equal(actorResponse.body.cursor, 1)
    assert.equal(actorResponse.body.through, 1)
    assert.equal(actorResponse.body.actors[0].id, 'hermes-kanban:actor:t_api:7')
    assert.deepEqual(actorResponse.body.eventVocabulary, [
      'claimed', 'heartbeat', 'blocked', 'review_requested', 'changes_requested', 'completed', 'archived',
      'crashed', 'timed_out', 'spawn_failed', 'gave_up', 'reclaimed', 'review_reopened',
    ])
    assert.deepEqual(eventResponse.body.events.map(({ id, kind }) => [id, kind]), [[1, 'claimed']])
  } finally {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('events reject unsafe cursors', async () => {
  for (const since of ['1.5', 'Infinity', '-1', '9007199254740992', 'not-a-number']) {
    const response = await request(`/api/events?since=${since}`)
    assert.equal(response.status, 400, since)
    assert.deepEqual(response.body, { error: 'since must be a non-negative safe integer' })
  }
})

test('browser API uses the injected embedded transport without changing standalone URLs', async () => {
  const calls = []
  const original = globalThis.__BOT_CROSSING_TRANSPORT__
  globalThis.__BOT_CROSSING_TRANSPORT__ = async (...args) => {
    calls.push(args)
    return new Response(JSON.stringify({ threads: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const { fetchThreads } = await import(`../src/game/api.js?embedded=${Date.now()}`)
    assert.deepEqual(await fetchThreads(), { threads: [] })
    assert.equal(calls[0][0], '/api/threads?source=native-kanban')
  } finally {
    if (original === undefined) delete globalThis.__BOT_CROSSING_TRANSPORT__
    else globalThis.__BOT_CROSSING_TRANSPORT__ = original
  }
})
