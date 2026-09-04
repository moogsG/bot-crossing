import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { projectGroups } = await vite.ssrLoadModule('/src/game/colony.js')
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
