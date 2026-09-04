import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apiMiddleware, readActorSnapshot } from './api.mjs'

const temporaryHomes = []
const originalHermesHome = process.env.HERMES_HOME

async function actorFixtureHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-api-'))
  temporaryHomes.push(home)
  const boardDir = path.join(home, 'kanban', 'boards', 'native')
  await fsp.mkdir(boardDir, { recursive: true })
  const db = new DatabaseSync(path.join(boardDir, 'kanban.db'))
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      block_kind TEXT,
      last_heartbeat_at INTEGER,
      session_id TEXT,
      current_run_id INTEGER
    );
    CREATE TABLE task_runs (
      id INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL,
      profile TEXT,
      status TEXT NOT NULL,
      last_heartbeat_at INTEGER
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_id INTEGER,
      kind TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO tasks VALUES ('t_api', 'running', NULL, 100, NULL, 7);
    INSERT INTO task_runs VALUES (7, 't_api', 'builder', 'running', 100);
  `)
  db.close()
  return home
}

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

afterEach(async () => {
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  await Promise.all(temporaryHomes.splice(0).map((home) => fsp.rm(home, { recursive: true, force: true })))
})

test('GET /api/actors returns normalized snapshots and the explicit lifecycle event vocabulary', async () => {
  process.env.HERMES_HOME = await actorFixtureHome()
  const capture = responseCapture()
  const request = { url: '/api/actors', method: 'GET', headers: { host: 'localhost:5274' } }

  await apiMiddleware(request, capture.response)

  const result = capture.result()
  assert.equal(result.status, 200)
  assert.equal(result.headers['Cache-Control'], 'no-store')
  assert.deepEqual(result.body.eventVocabulary, [
    'claimed',
    'heartbeat',
    'blocked',
    'review_requested',
    'changes_requested',
    'completed',
    'archived',
  ])
  assert.equal(result.body.actors.length, 1)
  assert.equal(result.body.actors[0].id, 'hermes-kanban:actor:t_api:7')
  assert.equal(result.body.actors[0].taskId, 't_api')
  assert.equal(result.body.actors[0].runId, 7)
  assert.equal(result.body.actors[0].harness, 'hermes-kanban')
  assert.equal(result.body.cursor, 0)
  assert.equal(typeof result.body.scannedAt, 'number')
})

test('actor snapshot captures its cursor before a transition can make the actor scan stale', async () => {
  const home = await actorFixtureHome()
  process.env.HERMES_HOME = home
  const databasePath = path.join(home, 'kanban', 'boards', 'native', 'kanban.db')
  const workingActor = { id: 'hermes-kanban:actor:t_api:7', lifecycleState: 'working' }

  const snapshot = await readActorSnapshot({
    readCursor: async () => {
      const db = new DatabaseSync(databasePath, { readOnly: true })
      try {
        return Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS cursor FROM task_events').get().cursor)
      } finally {
        db.close()
      }
    },
    readActors: async () => {
      const db = new DatabaseSync(databasePath)
      db.exec(`
        BEGIN;
        UPDATE tasks SET status = 'done' WHERE id = 't_api';
        UPDATE task_runs SET status = 'done' WHERE id = 7;
        INSERT INTO task_events (task_id, run_id, kind, payload, created_at)
        VALUES ('t_api', 7, 'completed', NULL, 101);
        COMMIT;
      `)
      db.close()
      return [workingActor]
    },
  })
  const capture = responseCapture()
  const request = { url: `/api/events?since=${snapshot.cursor}`, method: 'GET', headers: { host: 'localhost:5274' } }

  await apiMiddleware(request, capture.response)

  assert.equal(snapshot.cursor, 0)
  assert.deepEqual(snapshot.actors, [workingActor])
  assert.deepEqual(capture.result().body.events.map(({ id, kind }) => [id, kind]), [[1, 'completed']])
})

test('GET /api/events returns an ordered no-store lifecycle cursor', async () => {
  const home = await actorFixtureHome()
  process.env.HERMES_HOME = home
  const db = new DatabaseSync(path.join(home, 'kanban', 'boards', 'native', 'kanban.db'))
  db.exec(`
    INSERT INTO task_events (task_id, run_id, kind, payload, created_at)
    VALUES ('t_api', 7, 'claimed', '{"source_status":"ready"}', 101),
           ('t_api', 7, 'heartbeat', NULL, 102)
  `)
  db.close()
  const capture = responseCapture()
  const request = { url: '/api/events?since=0', method: 'GET', headers: { host: 'localhost:5274' } }

  await apiMiddleware(request, capture.response)

  const result = capture.result()
  assert.equal(result.status, 200)
  assert.equal(result.headers['Cache-Control'], 'no-store')
  assert.equal(result.body.cursor, 2)
  assert.deepEqual(result.body.events.map(({ id, kind }) => [id, kind]), [
    [1, 'claimed'],
    [2, 'heartbeat'],
  ])
})
