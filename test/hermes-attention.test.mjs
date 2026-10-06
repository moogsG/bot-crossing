import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { Colony, actorRosterEntries, wantsMorganAttention } = await vite.ssrLoadModule('/src/game/colony.js')
const { BADGE } = await vite.ssrLoadModule('/src/agents/indicators.js')
await vite.close()

test('production-shaped runless Morgan attention signals one repository Jynx without fabricating a worker', () => {
  const task = {
    id: 'hermes-kanban:t_blocked', project: 'bot-crossing', source: 'native-kanban', requiresMorgan: true,
    ref: { taskId: 't_blocked', status: 'blocked' },
  }
  const attention = {
    id: 'hermes-kanban:actor:t_blocked:attention', taskId: 't_blocked', runId: null,
    profile: 'jynx', lifecycleState: 'waiting', requiresMorgan: true,
  }
  const roster = actorRosterEntries(
    [attention],
    new Map([[task.id, task]]),
    new Map([[task.id, { site: 'site', anchor: 'anchor' }]]),
    [{ id: 'bot-crossing', threads: [task] }]
  )

  assert.equal(wantsMorganAttention(task, 'blocked'), true)
  assert.deepEqual(roster.map(({ id, role, status, stewardSignal }) => ({ id, role, status, stewardSignal })), [
    { id: 'repository:bot-crossing:jynx', role: 'jynx', status: 'requires-morgan', stewardSignal: true },
  ])
})

test('role badges are orthogonal while attention, error, arrival, and departure keep precedence', () => {
  const badgeFor = (agent) => Colony.prototype._badgeFor.call({}, { state: 'at-site', actor: {}, ...agent })
  assert.deepEqual(
    ['builder', 'reviewer', 'drone', 'worker'].map((role) => badgeFor({ role, status: 'working' })),
    [BADGE.working, BADGE.reviewer, BADGE.drone, BADGE.worker]
  )
  assert.equal(badgeFor({ role: 'reviewer', status: 'requires-morgan' }), BADGE.waiting)
  assert.equal(badgeFor({ role: 'reviewer', status: 'blocked' }), BADGE.blocked)
  assert.equal(badgeFor({ role: 'reviewer', status: 'celebrating' }), BADGE.done)
  assert.equal(Colony.prototype._badgeFor.call({}, { state: 'spawning', actor: {}, role: 'reviewer', status: 'working' }), BADGE.spawning)
  assert.equal(Colony.prototype._badgeFor.call({}, { state: 'leaving', actor: {}, role: 'reviewer', status: 'working' }), BADGE.leaving)
})
