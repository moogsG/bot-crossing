import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const {
  Colony,
  actorRosterEntries,
  projectGroups,
  repositoryBuildingsFor,
  repositoryLandmarkFor,
  repositoryPlotDemand,
  visibleTaskCards,
  wantsMorganAttention,
} = await vite.ssrLoadModule('/src/game/colony.js')
const { COMPLETION_GRACE_MS } = await vite.ssrLoadModule('/src/game/actor-lifecycle.js')
const { allocateCells, SLOTS_PER_CELL } = await vite.ssrLoadModule('/src/world/plots.js')
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

test('repository landmarks derive stable identity and silhouette only from Codebase Memory size', () => {
  const project = { id: 'bot-crossing', name: 'Bot Crossing', codebaseSizeTier: 'small' }

  assert.deepEqual(repositoryLandmarkFor(project), {
    id: 'repository:bot-crossing',
    kind: 'habitat',
    project,
  })
  assert.equal(repositoryLandmarkFor({ ...project, codebaseSizeTier: 'medium' }).kind, 'workshop')
  assert.equal(repositoryLandmarkFor({ ...project, codebaseSizeTier: 'large' }).kind, 'tower')
  assert.equal(repositoryLandmarkFor({ ...project, codebaseSizeTier: 'invalid' }).kind, 'habitat')
  assert.equal(repositoryLandmarkFor({ id: project.id }).kind, 'habitat')
  assert.equal(repositoryLandmarkFor({ ...project, threads: Array(20).fill({}) }).kind, 'habitat')
})

test('territory tiers create exact stable repository buildings at every cell center', () => {
  const project = {
    id: 'bot-crossing',
    codebaseSizeTier: 'large',
    codebaseTerritoryTier: 'xxl',
  }

  assert.deepEqual(repositoryBuildingsFor(project), [
    { id: 'repository:bot-crossing', kind: 'tower', type: 'repository', slot: 0 },
    { id: 'repository:bot-crossing:annex:1', kind: 'solar', type: 'repository-annex', slot: 7 },
    { id: 'repository:bot-crossing:annex:2', kind: 'antenna', type: 'repository-annex', slot: 14 },
    { id: 'repository:bot-crossing:annex:3', kind: 'silo', type: 'repository-annex', slot: 21 },
    { id: 'repository:bot-crossing:annex:4', kind: 'greenhouse', type: 'repository-annex', slot: 28 },
    { id: 'repository:bot-crossing:annex:5', kind: 'reactor', type: 'repository-annex', slot: 35 },
    { id: 'repository:bot-crossing:annex:6', kind: 'pad', type: 'repository-annex', slot: 42 },
    { id: 'repository:bot-crossing:annex:7', kind: 'lab', type: 'repository-annex', slot: 49 },
    { id: 'repository:bot-crossing:annex:8', kind: 'habitat', type: 'repository-annex', slot: 56 },
  ])
  assert.deepEqual(
    ['xs', 'small', 'medium', 'large', 'xl', 'xxl'].map((tier) =>
      repositoryBuildingsFor({ ...project, codebaseTerritoryTier: tier }).length
    ),
    [1, 2, 3, 5, 7, 9]
  )
  assert.equal(repositoryBuildingsFor(project).filter(({ type }) => type === 'repository').length, 1)
  assert.deepEqual(repositoryBuildingsFor({ ...project, codebaseTerritoryTier: 'invalid' }), [
    { id: 'repository:bot-crossing', kind: 'tower', type: 'repository', slot: 0 },
  ])
  assert.equal(
    repositoryBuildingsFor({ ...project, codebaseTerritoryTier: 'small' })[0].id,
    repositoryBuildingsFor({ ...project, codebaseTerritoryTier: 'xl' })[0].id
  )
})

test('project groups preserve both optional Codebase Memory tiers from the catalog', () => {
  const groups = projectGroups([], [
    {
      id: 'p_small',
      slug: 'small',
      name: 'Small',
      path: '/work/small',
      codebaseSizeTier: 'small',
      codebaseTerritoryTier: 'xl',
    },
    { id: 'p_unknown', slug: 'unknown', name: 'Unknown', path: '/work/unknown' },
  ])

  assert.equal(groups[0].codebaseSizeTier, 'small')
  assert.equal(groups[0].codebaseTerritoryTier, 'xl')
  assert.equal(Object.hasOwn(groups[1], 'codebaseSizeTier'), false)
  assert.equal(Object.hasOwn(groups[1], 'codebaseTerritoryTier'), false)
})

test('territory tiers set exact mixed repository floors with legacy fallback and precedence', () => {
  const projects = [
    { id: 'missing', threads: [] },
    { id: 'invalid', codebaseTerritoryTier: 'enormous', threads: [] },
    { id: 'legacy-medium', codebaseSizeTier: 'medium', threads: [] },
    { id: 'legacy-large', codebaseSizeTier: 'large', threads: [] },
    { id: 'xs', codebaseTerritoryTier: 'xs', codebaseSizeTier: 'large', threads: [] },
    { id: 'small', codebaseTerritoryTier: 'small', threads: [] },
    { id: 'medium', codebaseTerritoryTier: 'medium', threads: [] },
    { id: 'large', codebaseTerritoryTier: 'large', threads: [] },
    { id: 'xl', codebaseTerritoryTier: 'xl', threads: [] },
    { id: 'xxl', codebaseTerritoryTier: 'xxl', threads: [] },
  ]
  const layout = allocateCells(
    projects.map((project) => ({ id: project.id, size: repositoryPlotDemand(project) }))
  )

  assert.deepEqual(
    projects.map(({ id }) => [id, layout.get(id).length]),
    [
      ['missing', 1],
      ['invalid', 1],
      ['legacy-medium', 2],
      ['legacy-large', 3],
      ['xs', 1],
      ['small', 2],
      ['medium', 3],
      ['large', 5],
      ['xl', 7],
      ['xxl', 9],
    ]
  )

  const occupied = new Set()
  const neighbours = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ]
  for (const cells of layout.values()) {
    const reachable = new Set([`${cells[0].q},${cells[0].r}`])
    while (true) {
      const before = reachable.size
      for (const cell of cells) {
        if (neighbours.some(([dq, dr]) => reachable.has(`${cell.q + dq},${cell.r + dr}`))) {
          reachable.add(`${cell.q},${cell.r}`)
        }
      }
      if (reachable.size === before) break
    }
    assert.equal(reachable.size, cells.length)
    for (const cell of cells) {
      const key = `${cell.q},${cell.r}`
      assert.equal(occupied.has(key), false)
      assert.notEqual(key, '-2,1')
      occupied.add(key)
    }
  }

  const remembered = layout.get('medium')
  assert.equal(repositoryPlotDemand({ codebaseTerritoryTier: 'small', threads: [] }, remembered), 3 * SLOTS_PER_CELL)
  assert.equal(repositoryPlotDemand({ threads: [] }, remembered), 3 * SLOTS_PER_CELL)
  assert.equal(
    repositoryPlotDemand({ codebaseTerritoryTier: 'small', threads: Array(13).fill({}) }),
    2 * SLOTS_PER_CELL + 1
  )
})

test('native completed worksites remain for exactly the shared grace interval', () => {
  const completedAt = 10_000
  const completed = {
    id: 'hermes-kanban:t_recent',
    source: 'native-kanban',
    completedAt,
    ref: { status: 'done', taskId: 't_recent' },
  }

  assert.equal(COMPLETION_GRACE_MS, 2000)
  assert.deepEqual(visibleTaskCards([completed], completedAt + COMPLETION_GRACE_MS - 1), [completed])
  assert.deepEqual(visibleTaskCards([completed], completedAt + COMPLETION_GRACE_MS), [])
})

test('historical and malformed native completions leave no worksite, fallback zone, or panel card', () => {
  const now = 20_000
  const active = {
    id: 'hermes-kanban:t_active',
    project: 'known',
    source: 'native-kanban',
    ref: { status: 'running', taskId: 't_active' },
  }
  const legacy = { id: 'legacy-complete', project: 'legacy', source: 'desktop', prState: 'MERGED' }
  const rejected = [
    { id: 'old', project: 'old', completedAt: now - COMPLETION_GRACE_MS, ref: { status: 'done' } },
    { id: 'missing', project: 'missing', completedAt: 0, ref: { status: 'done' } },
    { id: 'text', project: 'text', completedAt: 'recent', ref: { status: 'done' } },
    { id: 'future', project: 'future', completedAt: now + 1, ref: { status: 'done' } },
  ].map((thread) => ({ ...thread, source: 'native-kanban' }))

  const visible = visibleTaskCards([active, legacy, ...rejected], now)
  const groups = projectGroups(visible, [{ id: 'p_known', slug: 'known', name: 'Known', path: '/work/known' }])

  assert.deepEqual(visible, [active, legacy])
  assert.deepEqual(groups.map(({ id, threads }) => [id, threads.map((thread) => thread.id)]), [
    ['known', ['hermes-kanban:t_active']],
    ['legacy', ['legacy-complete']],
  ])
})

test('saved repository plots remain quiet landmarks when the catalog is empty without restoring task history', () => {
  const now = 30_000
  const repositoryId = 'git:/work/bot-crossing/.git'
  const savedPlots = new Map([
    [repositoryId, [{ q: 0, r: 0 }]],
    ['workspace:/work/perch-review', [{ q: -1, r: 1 }]],
  ])
  const completedHistory = {
    id: 'hermes-kanban:t_history',
    project: 'bot-crossing',
    repositoryId,
    repositoryPath: '/work/bot-crossing',
    source: 'native-kanban',
    completedAt: now - COMPLETION_GRACE_MS,
    ref: { status: 'done', taskId: 't_history' },
  }

  const visible = visibleTaskCards([completedHistory], now)
  const groups = projectGroups(visible, [], new Set(), savedPlots)

  assert.deepEqual(visible, [])
  assert.deepEqual(
    groups.map(({ id, name, path, threads }) => ({ id, name, path, threadIds: threads.map((thread) => thread.id) })),
    [
      { id: repositoryId, name: 'bot-crossing', path: '/work/bot-crossing', threadIds: [] },
      {
        id: 'workspace:/work/perch-review',
        name: 'perch-review',
        path: '/work/perch-review',
        threadIds: [],
      },
    ]
  )
})

test('repository territory grows for visible worksites, remembers capacity, and stays capped without restoring history', () => {
  const oneCell = [{ q: 0, r: 0 }]
  const threeCells = [oneCell[0], { q: 1, r: 0 }, { q: 0, r: 1 }]
  const nineCells = Array.from({ length: 9 }, (_, q) => ({ q, r: 0 }))

  assert.equal(SLOTS_PER_CELL, 7)
  assert.equal(repositoryPlotDemand({ threads: [] }, []), 1)
  assert.equal(repositoryPlotDemand({ threads: Array(6).fill({}) }, oneCell), SLOTS_PER_CELL)
  assert.equal(repositoryPlotDemand({ threads: Array(7).fill({}) }, oneCell), SLOTS_PER_CELL + 1)
  assert.equal(repositoryPlotDemand({ threads: [] }, threeCells), 3 * SLOTS_PER_CELL)

  const capped = allocateCells(
    [{ id: 'repository', size: repositoryPlotDemand({ threads: Array(100).fill({}) }, nineCells) }],
    new Map([['repository', nineCells]])
  )
  assert.equal(capped.get('repository').length, 9)

  const completed = {
    id: 'hermes-kanban:t_history',
    source: 'native-kanban',
    completedAt: 10_000,
    ref: { status: 'done', taskId: 't_history' },
  }
  const visible = visibleTaskCards([completed], 10_000 + COMPLETION_GRACE_MS)
  assert.deepEqual(visible, [])
  assert.equal(repositoryPlotDemand({ threads: visible }, threeCells), 3 * SLOTS_PER_CELL)
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

test('task buildings and temporary run actors keep separate stable identities', () => {
  const threads = new Map([
    ['hermes-kanban:t_live', { id: 'hermes-kanban:t_live', ref: { taskId: 't_live' } }],
    ['hermes-kanban:t_done', { id: 'hermes-kanban:t_done', ref: { taskId: 't_done' } }],
  ])
  const sites = new Map([
    ['hermes-kanban:t_live', { site: 'site-live', anchor: 'anchor-live' }],
    ['hermes-kanban:t_done', { site: 'site-done', anchor: 'anchor-done' }],
  ])
  const actor = {
    id: 'hermes-kanban:actor:t_live:7',
    taskId: 't_live',
    profile: 'reviewer',
    lifecycleState: 'reviewing',
    requiresMorgan: false,
  }

  assert.deepEqual(actorRosterEntries([actor], threads, sites), [
    {
      id: 'hermes-kanban:actor:t_live:7',
      thread: threads.get('hermes-kanban:t_live'),
      actor,
      status: 'reviewing',
      role: 'reviewer',
      stewardSignal: false,
      site: 'site-live',
      anchor: 'anchor-live',
    },
  ])
})

test('a visible native task keeps its building, repository Jynx, and current worker together', () => {
  const thread = {
    id: 'hermes-kanban:t_live',
    project: 'bot-crossing',
    source: 'native-kanban',
    createdAt: 1,
    ref: { taskId: 't_live', status: 'running' },
  }
  const plot = { id: 'bot-crossing' }
  const quietPlot = { id: 'quiet' }
  const buildings = []
  let roster = []
  const colony = {
    plotCells: new Map(),
    plots: new Map([
      ['bot-crossing', plot],
      ['quiet', quietPlot],
    ]),
    buildings: new Map(),
    _syncPlots() {},
    _syncBuilding(id) {
      buildings.push(id)
      return { mesh: { position: { clone: () => 'anchor' } } }
    },
    _workSite() {
      return 'task-site'
    },
    _world() {
      return {}
    },
    _rebuildNavigation() {},
    astronauts: { setRoster(entries) { roster = entries } },
  }

  Colony.prototype.setThreads.call(colony, [thread], new Set(), [
    { id: 'p_bot', slug: 'bot-crossing', name: 'Bot Crossing', path: '/work/bot-crossing' },
    { id: 'p_quiet', slug: 'quiet', name: 'Quiet', path: '/work/quiet' },
  ], [
    {
      id: 'hermes-kanban:actor:t_live:7',
      taskId: 't_live',
      runId: 7,
      profile: 'builder',
      lifecycleState: 'working',
      requiresMorgan: false,
    },
  ])

  assert.deepEqual(buildings, ['repository:bot-crossing', 'hermes-kanban:t_live', 'repository:quiet'])
  assert.deepEqual(
    roster.map(({ id, role, status, site }) => ({ id, role, status, site })),
    [
      {
        id: 'hermes-kanban:actor:t_live:7',
        role: 'builder',
        status: 'working',
        site: 'task-site',
      },
      {
        id: 'repository:bot-crossing:jynx',
        role: 'jynx',
        status: 'idle',
        site: 'task-site',
      },
    ]
  )
})

test('repository annex centers stay reserved while task slots overflow into earned cells', () => {
  const threads = Array.from({ length: 20 }, (_, index) => ({
    id: `task:${index}`,
    project: 'campus',
    createdAt: index,
  }))
  const synced = []
  const plot = { id: 'campus' }
  const colony = {
    plotCells: new Map(),
    plots: new Map([['campus', plot]]),
    buildings: new Map(),
    _syncPlots(projects) {
      assert.equal(
        allocateCells(projects.map((project) => ({ id: project.id, size: repositoryPlotDemand(project) }))).get(
          'campus'
        ).length,
        4
      )
    },
    _syncBuilding(id, _plot, slot, options) {
      synced.push({ id, slot, ...options })
      return { mesh: { position: { clone: () => `anchor:${slot}` } } }
    },
    _workSite(_plot, _building, slot) {
      return `site:${slot}`
    },
    _world() {
      return {}
    },
    _rebuildNavigation() {},
    astronauts: { setRoster() {} },
  }

  Colony.prototype.setThreads.call(colony, threads, new Set(), [
    {
      id: 'p_campus',
      slug: 'campus',
      name: 'Campus',
      path: '/work/campus',
      codebaseSizeTier: 'medium',
      codebaseTerritoryTier: 'medium',
    },
  ])

  assert.deepEqual(
    synced.slice(0, 3),
    repositoryBuildingsFor({
      id: 'campus',
      codebaseSizeTier: 'medium',
      codebaseTerritoryTier: 'medium',
    })
  )
  const taskSlots = synced.filter(({ type }) => type === 'task').map(({ slot }) => slot)
  assert.deepEqual(taskSlots, [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22])
  assert.equal(new Set(synced.map(({ slot }) => slot)).size, synced.length)
})

test('tier changes keep the primary campus while archived tasks and workers are reconciled away', () => {
  const thread = {
    id: 'hermes-kanban:t_archived',
    project: 'campus',
    source: 'native-kanban',
    createdAt: 1,
    ref: { taskId: 't_archived', status: 'running' },
  }
  const actor = {
    id: 'hermes-kanban:actor:t_archived:12',
    taskId: 't_archived',
    runId: 12,
    profile: 'builder',
    lifecycleState: 'working',
    requiresMorgan: false,
  }
  const plot = { id: 'campus' }
  let roster = []
  const removed = []
  const colony = {
    plotCells: new Map(),
    plots: new Map([['campus', plot]]),
    buildings: new Map(),
    _syncPlots() {},
    _syncBuilding(id, _plot, slot, options) {
      let entry = this.buildings.get(id)
      if (!entry) {
        entry = { id, slot, ...options, mesh: { position: { clone: () => `anchor:${slot}` } } }
        this.buildings.set(id, entry)
      }
      return entry
    },
    _removeBuilding(id) {
      removed.push(id)
      this.buildings.delete(id)
    },
    _workSite(_plot, _building, slot) {
      return `site:${slot}`
    },
    _world() {
      return {}
    },
    _rebuildNavigation() {},
    astronauts: { setRoster(entries) { roster = entries } },
  }
  const catalog = (territoryTier) => [
    {
      id: 'p_campus',
      slug: 'campus',
      name: 'Campus',
      path: '/work/campus',
      codebaseSizeTier: 'large',
      codebaseTerritoryTier: territoryTier,
    },
  ]

  Colony.prototype.setThreads.call(colony, [thread], new Set(), catalog('medium'), [actor])
  const primary = colony.buildings.get('repository:campus')
  assert.ok(primary)
  assert.ok(colony.buildings.has(thread.id))
  assert.deepEqual(roster.map(({ id }) => id), [actor.id, 'repository:campus:jynx'])

  Colony.prototype.setThreads.call(colony, [thread], new Set([thread.id]), catalog('xl'), [actor])

  assert.equal(colony.buildings.get('repository:campus'), primary)
  assert.deepEqual(
    [...colony.buildings.keys()],
    [
      'repository:campus',
      'repository:campus:annex:1',
      'repository:campus:annex:2',
      'repository:campus:annex:3',
      'repository:campus:annex:4',
      'repository:campus:annex:5',
      'repository:campus:annex:6',
    ]
  )
  assert.deepEqual(removed, [thread.id])
  assert.equal(colony.threads.has(thread.id), false)
  assert.deepEqual(roster, [])
})

test('several repository tasks reuse one Jynx for runless Morgan attention without a stale worker', () => {
  const working = {
    id: 'hermes-kanban:t_working',
    project: 'bot-crossing',
    ref: { taskId: 't_working', status: 'running' },
  }
  const blocked = {
    id: 'hermes-kanban:t_blocked',
    project: 'bot-crossing',
    ref: { taskId: 't_blocked', status: 'blocked' },
  }
  const threads = new Map([
    [working.id, working],
    [blocked.id, blocked],
  ])
  const sites = new Map([
    [working.id, { site: 'working-site', anchor: 'working-anchor' }],
    [blocked.id, { site: 'blocked-site', anchor: 'blocked-anchor' }],
  ])
  const actors = [
    {
      id: 'hermes-kanban:actor:t_working:8',
      taskId: 't_working',
      runId: 8,
      profile: 'reviewer',
      lifecycleState: 'reviewing',
      requiresMorgan: false,
    },
    {
      id: 'hermes-kanban:actor:t_blocked:attention',
      taskId: 't_blocked',
      runId: null,
      profile: 'jynx',
      lifecycleState: 'waiting',
      requiresMorgan: true,
    },
  ]
  const projects = [{ id: 'bot-crossing', threads: [working, blocked] }]

  const roster = actorRosterEntries(actors, threads, sites, projects)

  assert.deepEqual(
    roster.map(({ id, role, status, site, stewardSignal }) => ({ id, role, status, site, stewardSignal })),
    [
      {
        id: 'hermes-kanban:actor:t_working:8',
        role: 'reviewer',
        status: 'reviewing',
        site: 'working-site',
        stewardSignal: false,
      },
      {
        id: 'repository:bot-crossing:jynx',
        role: 'jynx',
        status: 'requires-morgan',
        site: 'blocked-site',
        stewardSignal: true,
      },
    ]
  )
  assert.equal(roster.filter(({ role }) => role === 'jynx').length, 1)
  assert.equal(roster.some(({ role }) => role === 'drone'), false)
})

test('Morgan attention on a current run signals repository Jynx and still renders its worker', () => {
  const thread = {
    id: 'hermes-kanban:t_active_attention',
    project: 'bot-crossing',
    ref: { taskId: 't_active_attention', status: 'blocked' },
  }
  const actor = {
    id: 'hermes-kanban:actor:t_active_attention:9',
    taskId: 't_active_attention',
    runId: 9,
    profile: 'drone',
    lifecycleState: 'waiting',
    requiresMorgan: true,
  }

  const roster = actorRosterEntries(
    [actor],
    new Map([[thread.id, thread]]),
    new Map([[thread.id, { site: 'attention-site', anchor: 'attention-anchor' }]]),
    [{ id: 'bot-crossing', threads: [thread] }]
  )

  assert.deepEqual(
    roster.map(({ id, role, status, stewardSignal }) => ({ id, role, status, stewardSignal })),
    [
      {
        id: 'hermes-kanban:actor:t_active_attention:9',
        role: 'drone',
        status: 'internal-wait',
        stewardSignal: false,
      },
      {
        id: 'repository:bot-crossing:jynx',
        role: 'jynx',
        status: 'requires-morgan',
        stewardSignal: true,
      },
    ]
  )
})
