import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apiMiddleware } from './api.mjs'

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
  assert.equal(typeof result.body.scannedAt, 'number')
})
