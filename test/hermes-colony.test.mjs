import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createServer } from 'vite'

import { actorRosterEntries, projectGroups } from '../src/game/actor-lifecycle.js'

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { plotPresentationFor, projectLegendEntries } = await vite.ssrLoadModule('/src/game/colony.js')
await vite.close()

const task = (overrides = {}) => ({
  id: 'hermes-kanban:t_build',
  title: 'Build the colony',
  project: 'worktree-name',
  projectId: 'p_bot',
  projectPath: '/repos/bot-crossing/.worktrees/build',
  repositoryId: 'git:/repos/bot-crossing/.git',
  repositoryPath: '/repos/bot-crossing',
  source: 'native-kanban',
  ref: { taskId: 't_build' },
  createdAt: 100,
  ...overrides,
})

test('canonical repositories group sibling worktrees into one stable catalog zone and retain quiet repositories', () => {
  const catalog = [
    { id: 'p_bot', slug: 'bot-crossing', name: 'Bot Crossing', path: '/repos/bot-crossing' },
    { id: 'p_quiet', slug: 'quiet-repo', name: 'Quiet Repository', path: '/repos/quiet' },
  ]
  const groups = projectGroups([
    task(),
    task({
      id: 'hermes-kanban:t_review',
      ref: { taskId: 't_review' },
      projectPath: '/repos/bot-crossing/.worktrees/review',
      gitBranch: 'review',
    }),
  ], catalog)

  assert.deepEqual(groups.map(({ id, name, path, threads }) => ({
    id,
    name,
    path,
    taskIds: threads.map((entry) => entry.ref.taskId),
    worksiteIds: threads.map((entry) => entry.id),
  })), [
    {
      id: 'bot-crossing',
      name: 'Bot Crossing',
      path: '/repos/bot-crossing',
      taskIds: ['t_build', 't_review'],
      worksiteIds: ['hermes-kanban:t_build', 'hermes-kanban:t_review'],
    },
    { id: 'quiet-repo', name: 'Quiet Repository', path: '/repos/quiet', taskIds: [], worksiteIds: [] },
  ])
})

test('native task worksites host only authoritative current-run bots and suppress duplicate actors', () => {
  const tasks = new Map([
    ['hermes-kanban:t_build', task()],
    ['claude:session', task({ id: 'claude:session', source: 'claude-code', ref: {}, project: 'other' })],
  ])
  const sites = new Map([
    ['hermes-kanban:t_build', { site: { key: 'task-site' }, anchor: { key: 'task-anchor' }, known: true }],
    ['claude:session', { site: { key: 'session-site' }, anchor: { key: 'session-anchor' }, known: true }],
  ])
  const actors = [
    { id: 'actor:41', taskId: 't_build', runId: 41, profile: 'builder', lifecycleState: 'working' },
    { id: 'actor:41', taskId: 't_build', runId: 41, profile: 'builder', lifecycleState: 'working' },
    { id: 'attention', taskId: 't_build', runId: null, profile: 'jynx', lifecycleState: 'waiting' },
  ]

  assert.deepEqual(actorRosterEntries(actors, tasks, sites).map((entry) => ({
    id: entry.id,
    task: entry.thread.ref.taskId,
    status: entry.status,
    site: entry.site.key,
  })), [
    { id: 'actor:41', task: 't_build', status: 'working', site: 'task-site' },
  ])
})

test('canonical projection keeps human repository presentation and drives legend counts from visible worksites', () => {
  const project = {
    id: 'git:/repos/bot-crossing/.git',
    name: 'Bot Crossing',
    path: '/repos/bot-crossing',
    threads: [task()],
  }
  const plot = { id: project.id, name: project.name, accent: 0x4f9a63 }
  const visible = new Map([[task().id, { ...task(), project: project.id }]])

  assert.deepEqual(plotPresentationFor(project), {
    id: 'git:/repos/bot-crossing/.git',
    name: 'Bot Crossing',
    path: '/repos/bot-crossing',
  })
  assert.deepEqual(projectLegendEntries([plot], visible, new Set()), [{
    id: 'git:/repos/bot-crossing/.git',
    name: 'Bot Crossing',
    accent: 0x4f9a63,
    count: 1,
    urgent: false,
  }])
})

test('first-run and help copy describe native Kanban cards and authoritative workers', async () => {
  const [main, hud] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/hud.js', import.meta.url), 'utf8'),
  ])

  assert.match(main, /Loading native Hermes Kanban cards/)
  assert.doesNotMatch(main, /Scanning for agent threads/)
  assert.match(hud, /native Hermes Kanban card/)
  assert.match(hud, /authoritative current runs/)
  assert.doesNotMatch(hud, /Every coding-agent thread/)
})
