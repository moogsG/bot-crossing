import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { projectGroups, wantsMorganAttention } = await vite.ssrLoadModule('/src/game/colony.js')
await vite.close()

test('known projects persist without agents and matching tasks share their stable zone', () => {
  const catalog = [
    { id: 'p_fleet', slug: 'fleet-pilot', name: 'Hermes Fleet Pilot', path: '/work/fleet-pilot' },
    { id: 'p_perch', slug: 'perch', name: 'Perch', path: '/work/perch' },
  ]
  const threads = [
    { id: 'by-id', project: 'p_fleet', projectId: 'p_fleet', projectPath: '/tmp/one' },
    { id: 'by-tenant', project: 'fleet-pilot', tenant: 'fleet-pilot', projectPath: '/tmp/two' },
    { id: 'by-worktree', project: 't_worktree', projectPath: '/work/fleet-pilot/.worktrees/t_worktree' },
    { id: 'fallback', project: 'unregistered', projectPath: '/work/unregistered' },
  ]

  const groups = projectGroups(threads, catalog)

  assert.deepEqual(
    groups.map(({ id, name, path, threads: members }) => ({
      id,
      name,
      path,
      threadIds: members.map((thread) => thread.id),
      threadProjects: members.map((thread) => thread.project),
    })),
    [
      {
        id: 'fleet-pilot',
        name: 'Hermes Fleet Pilot',
        path: '/work/fleet-pilot',
        threadIds: ['by-id', 'by-tenant', 'by-worktree'],
        threadProjects: ['fleet-pilot', 'fleet-pilot', 'fleet-pilot'],
      },
      { id: 'perch', name: 'Perch', path: '/work/perch', threadIds: [], threadProjects: [] },
      {
        id: 'unregistered',
        name: 'unregistered',
        path: '/work/unregistered',
        threadIds: ['fallback'],
        threadProjects: ['unregistered'],
      },
    ]
  )
})

test('archived tasks do not create agents or fallback zones', () => {
  const groups = projectGroups(
    [
      { id: 'archived-known', project: 'perch', projectId: 'p_perch' },
      { id: 'archived-fallback', project: 'gone' },
    ],
    [{ id: 'p_perch', slug: 'perch', name: 'Perch', path: '/work/perch' }],
    new Set(['archived-known', 'archived-fallback'])
  )

  assert.deepEqual(groups, [{ id: 'perch', name: 'Perch', path: '/work/perch', threads: [] }])
})

test('only explicit Hermes attention makes a task Morgan-facing while legacy waits stay compatible', () => {
  const attentionClasses = [
    ['needs_input', { source: 'native-kanban', requiresMorgan: true }, 'blocked', true],
    ['capability', { source: 'native-kanban', requiresMorgan: true }, 'blocked', true],
    ['dependency', { source: 'native-kanban', requiresMorgan: false }, 'blocked', false],
    ['transient', { source: 'native-kanban', requiresMorgan: false }, 'blocked', false],
    ['generic blocked', { source: 'native-kanban', requiresMorgan: false }, 'blocked', false],
    ['review', { source: 'native-kanban', requiresMorgan: false }, 'idle', false],
    ['legacy waiting', { source: 'desktop' }, 'waiting', true],
    ['legacy blocked', { source: 'desktop' }, 'blocked', true],
  ]

  assert.deepEqual(
    attentionClasses.map(([label, thread, status]) => [label, wantsMorganAttention(thread, status)]),
    attentionClasses.map(([label, , , expected]) => [label, expected])
  )
})
