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

test('canonical repository identity keeps branches and sibling worktrees in one zone', () => {
  const catalog = [
    { id: 'p_bot', slug: 'bot-crossing', name: 'Bot Crossing', path: '/work/bot-crossing' },
    { id: 'p_quiet', slug: 'quiet', name: 'Quiet Repository', path: '/work/quiet' },
  ]
  const threads = [
    {
      id: 'root',
      project: 'root-project',
      projectId: 'root-project',
      projectPath: '/work/bot-crossing',
      repositoryId: 'git:/work/bot-crossing/.git',
      repositoryPath: '/work/bot-crossing',
    },
    {
      id: 'first-worktree',
      project: 'first-project',
      projectId: 'first-project',
      projectPath: '/work/bot-crossing/.worktrees/first',
      repositoryId: 'git:/work/bot-crossing/.git',
      repositoryPath: '/work/bot-crossing',
    },
    {
      id: 'second-worktree',
      project: 'second-project',
      projectId: 'second-project',
      projectPath: '/tmp/sibling-worktree',
      repositoryId: 'git:/work/bot-crossing/.git',
      repositoryPath: '/work/bot-crossing',
    },
  ]

  const groups = projectGroups(threads, catalog)

  assert.deepEqual(
    groups.map(({ id, threads: members }) => [id, members.map((thread) => thread.id)]),
    [
      ['bot-crossing', ['root', 'first-worktree', 'second-worktree']],
      ['quiet', []],
    ]
  )
})

test('fallback identities reconcile to a known canonical repository zone', () => {
  const catalog = [
    { id: 'p_bot', slug: 'bot-crossing', name: 'Bot Crossing', path: '/work/bot-crossing' },
  ]
  const threads = [
    {
      id: 'canonical',
      project: 'bot-crossing',
      projectId: 'p_bot',
      projectPath: '/work/bot-crossing',
      repositoryId: 'git:/work/bot-crossing/.git',
      repositoryPath: '/work/bot-crossing',
    },
    {
      id: 'missing-worktree',
      project: 't_missing',
      projectPath: '/work/bot-crossing/.worktrees/t_missing',
      repositoryId: 'workspace:/work/bot-crossing/.worktrees/t_missing',
      repositoryPath: '/work/bot-crossing/.worktrees/t_missing',
    },
    {
      id: 'pathless',
      project: 'p_bot',
      projectId: 'p_bot',
      projectPath: '',
      repositoryId: 'metadata:p_bot',
      repositoryPath: '',
    },
  ]

  const groups = projectGroups(threads, catalog)

  assert.deepEqual(
    groups.map(({ id, threads: members }) => [id, members.map((thread) => thread.id)]),
    [['bot-crossing', ['canonical', 'missing-worktree', 'pathless']]]
  )
})

test('canonical repository identity keeps distinct repositories separate despite shared project metadata', () => {
  const groups = projectGroups([
    {
      id: 'first',
      project: 'shared-project',
      projectId: 'shared-project',
      repositoryId: 'git:/work/first/.git',
      repositoryPath: '/work/first',
    },
    {
      id: 'second',
      project: 'shared-project',
      projectId: 'shared-project',
      repositoryId: 'git:/work/second/.git',
      repositoryPath: '/work/second',
    },
  ])

  assert.deepEqual(
    groups.map(({ id, threads }) => [id, threads.map((thread) => thread.id)]),
    [
      ['git:/work/first/.git', ['first']],
      ['git:/work/second/.git', ['second']],
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
