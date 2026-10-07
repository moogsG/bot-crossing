import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'
import * as THREE from 'three'

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const {
  Colony,
  assignTaskSlots,
  repositoryBuildingsFor,
  repositoryPlotDemand,
  projectGroups,
} = await vite.ssrLoadModule('/src/game/colony.js')
const { allocateCells, SLOTS_PER_CELL } = await vite.ssrLoadModule('/src/world/plots.js')
await vite.close()

const denseThreads = (count) => Array.from({ length: count }, (_, index) => ({
  id: `dense-${index}`,
  project: 'dense-campus',
  createdAt: index,
  lastActivityAt: Date.now(),
}))

function runDenseCampusAllocation(threads, previous = new Map()) {
  const calls = []
  const colony = {
    settings: { get: () => false },
    plotCells: new Map(),
    plots: new Map(),
    buildings: new Map(),
    _syncPlots(projects) {
      this.plots = new Map(projects.map((project) => [project.id, {
        id: project.id, cells: Array(9), slotOf: new Map(previous), slots: Array(63),
      }]))
    },
    _syncBuilding(id, plot, slot, options) {
      calls.push({ id, slot, type: options?.type || 'task' })
      const entry = { plot: plot.id, slot, mesh: { position: { clone: () => ({}) } } }
      this.buildings.set(id, entry)
      return entry
    },
    _removeBuilding() {},
    _rebuildNavigation() {},
    _workSite() { return {} },
    _syncFaunaSites() {},
    _world() { return {} },
    astronauts: { agents: [], setRoster(roster) { this.roster = roster } },
  }
  const stats = Colony.prototype.setThreads.call(colony, threads)
  const plot = colony.plots.get('dense-campus')
  return { calls, colony, plot, stats }
}

test('repository territory floors match the accepted pre-density checkpoint', () => {
  const tiers = ['xs', 'small', 'medium', 'large', 'xl', 'xxl']
  const expected = [1, 2, 3, 5, 7, 9]
  const projects = [
    { id: 'unenriched', threads: [] },
    ...tiers.map((tier) => ({ id: tier, codebaseSizeTier: 'large', codebaseTerritoryTier: tier, threads: [] })),
  ]
  const layout = allocateCells(projects.map((project) => ({ id: project.id, size: repositoryPlotDemand(project) })))

  assert.deepEqual(projects.map(({ id }) => layout.get(id).length), [1, ...expected])
  projects.forEach((project, index) => {
    const buildings = repositoryBuildingsFor(project)
    assert.equal(buildings.filter(({ type }) => type === 'repository').length, 1)
    assert.equal(new Set(buildings.map(({ slot }) => slot)).size, buildings.length)
    assert.equal(buildings.length, index === 0 ? 1 : expected[index - 1])
  })
})

test('accepted permanent campus composition uses one center structure per explicit tier cell', () => {
  const project = { id: 'quiet-campus', codebaseTerritoryTier: 'xxl', threads: [] }
  const first = repositoryBuildingsFor(project)
  const second = repositoryBuildingsFor({ ...project })

  assert.deepEqual(first, second)
  assert.deepEqual(first.map(({ slot }) => slot), [0, 7, 14, 21, 28, 35, 42, 49, 56])
  assert.ok(first.every((building) => building.scale === undefined && building.rotation === undefined))
})

test('new permanent structures evict remembered worksites from their reserved slots', () => {
  const threads = [{ id: 'oldest' }, { id: 'newest' }]
  const remembered = new Map([['oldest', 1], ['newest', 2]])
  const reserved = new Set(repositoryBuildingsFor({ id: 'campus', threads }).map(({ slot }) => slot))

  assignTaskSlots(threads, remembered, reserved)

  assert.equal(new Set(remembered.values()).size, threads.length)
  assert.equal([...remembered.values()].some((slot) => reserved.has(slot)), false)
})

test('production allocation keeps accepted composition while bounding physical overflow deterministically', () => {
  const first = runDenseCampusAllocation(denseThreads(63))
  const taskCalls = first.calls.filter(({ type }) => type === 'task')

  assert.equal(first.stats.agents, 63)
  assert.equal(first.colony.threads.size, 63)
  assert.equal(taskCalls.length, 62)
  assert.ok(taskCalls.every(({ slot }) => slot >= 0 && slot < first.plot.slots.length))
  assert.equal(new Set(taskCalls.map(({ slot }) => slot)).size, taskCalls.length)
  assert.deepEqual([...first.plot.overflowTaskIds], ['dense-62'])

  const seventy = runDenseCampusAllocation(denseThreads(70), first.plot.slotOf)
  const seventyTasks = seventy.calls.filter(({ type }) => type === 'task')
  const permanentSlots = new Set(seventy.calls.filter(({ type }) => type !== 'task').map(({ slot }) => slot))
  assert.equal(seventy.stats.agents, 70)
  assert.equal(seventy.colony.threads.size, 70)
  assert.equal(seventyTasks.length, 62)
  assert.equal(new Set(seventyTasks.map(({ slot }) => slot)).size, seventyTasks.length)
  assert.equal(seventyTasks.some(({ slot }) => permanentSlots.has(slot)), false)
  assert.deepEqual([...seventy.plot.overflowTaskIds], denseThreads(8).map(({ id }, index) => `dense-${index + 62}`))

  const repeat = runDenseCampusAllocation(denseThreads(70), seventy.plot.slotOf)
  assert.deepEqual([...repeat.plot.slotOf], [...seventy.plot.slotOf])
  assert.deepEqual([...repeat.plot.overflowTaskIds], [...seventy.plot.overflowTaskIds])

  const retired = runDenseCampusAllocation(denseThreads(70).slice(1), seventy.plot.slotOf)
  const retiredTasks = retired.calls.filter(({ type }) => type === 'task')
  assert.equal(retiredTasks.length, 62)
  assert.ok(retired.plot.slotOf.has('dense-62'))
  assert.ok(retiredTasks.some(({ id }) => id === 'dense-62'))
  assert.equal(retired.plot.overflowTaskIds.has('dense-62'), false)
})

test('overflow waits for a retiring physical task slot before it materializes', () => {
  const colony = {
    settings: { get: () => false },
    plotCells: new Map(),
    plots: new Map(),
    buildings: new Map(),
    worldGroup: new THREE.Group(),
    astronauts: { agents: [], setRoster() {} },
    _syncPlots(projects) {
      this.plots = new Map(projects.map((project) => [project.id, {
        id: project.id,
        accent: 0xffffff,
        cells: Array(9),
        slotOf: this.plots.get(project.id)?.slotOf || new Map(),
        slots: Array(63),
        worldSlot(slot, target = new THREE.Vector3()) { return target.set(slot, 0, 0) },
      }]))
    },
    _syncBuilding(id, plot, slot, { type = 'task' } = {}) {
      let entry = this.buildings.get(id)
      if (!entry) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
        mesh.userData.setProgress = () => {}
        this.worldGroup.add(mesh)
        entry = { mesh, plot: plot.id, slot, type, progress: 0, target: 1, retiring: false, kind: null, scale: 1 }
        this.buildings.set(id, entry)
      }
      entry.plot = plot.id
      entry.slot = slot
      entry.type = type
      entry.target = 1
      entry.retiring = false
      entry.mesh.position.copy(plot.worldSlot(slot))
      return entry
    },
    _rebuildNavigation() {},
    _workSite() { return {} },
    _syncFaunaSites() {},
    _world() { return {} },
  }
  Object.setPrototypeOf(colony, Colony.prototype)

  colony.setThreads(denseThreads(63))
  for (const entry of colony.buildings.values()) entry.progress = 1

  colony.setThreads(denseThreads(63).slice(1))
  const plot = colony.plots.get('dense-campus')
  const retiring = colony.buildings.get('dense-0')

  assert.equal(retiring.retiring, true)
  assert.equal(colony.buildings.has('dense-62'), false)
  assert.deepEqual([...plot.overflowTaskIds], ['dense-62'])
  const taskSlots = [...colony.buildings.values()].filter(({ type }) => type === 'task')
  assert.equal(new Set(taskSlots.map(({ slot }) => slot)).size, taskSlots.length)

  colony._growBuildings(10)
  assert.equal(colony.buildings.has('dense-0'), false)

  colony.setThreads(denseThreads(63).slice(1))
  assert.equal(colony.buildings.get('dense-62')?.slot, retiring.slot)
  assert.equal(colony.plots.get('dense-campus').overflowTaskIds.has('dense-62'), false)
})

test('territory never shrinks below remembered capacity and visible tasks grow without annex collisions', () => {
  const remembered = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 1 }]
  assert.equal(repositoryPlotDemand({ codebaseTerritoryTier: 'small', threads: [] }, remembered), 3 * SLOTS_PER_CELL)

  const rememberedLarge = [...remembered, { q: -1, r: 1 }, { q: -1, r: 0 }]
  const quiet = { id: 'remembered-campus', threads: [] }
  assert.equal(repositoryBuildingsFor(quiet, rememberedLarge.length).length, 1)
  assert.equal(repositoryPlotDemand(quiet, rememberedLarge), rememberedLarge.length * SLOTS_PER_CELL)

  const project = { id: 'campus', codebaseTerritoryTier: 'medium', codebaseSizeTier: 'medium', threads: Array(20).fill({}) }
  const reserved = new Set(repositoryBuildingsFor(project).map(({ slot }) => slot))
  const taskSlots = []
  for (let task = 0; task < project.threads.length; task += 1) {
    let slot = task
    for (const center of reserved) if (slot >= center) slot += 1
    taskSlots.push(slot)
  }
  assert.equal(taskSlots.some((slot) => reserved.has(slot)), false)
  assert.deepEqual([...reserved], [0, 7, 14])
  assert.equal(repositoryPlotDemand(project), 23)
})

test('saved repository identities recover as quiet catalog groups without fabricating tasks', () => {
  const saved = new Map([
    ['git:/work/bot-crossing/.git', [{ q: 0, r: 0 }]],
    ['workspace:/work/perch-review', [{ q: 1, r: 0 }]],
  ])
  const groups = projectGroups([], [], new Set(), saved)
  assert.deepEqual(groups.map(({ id, name, path, threads }) => ({ id, name, path, threads })), [
    { id: 'git:/work/bot-crossing/.git', name: 'bot-crossing', path: '/work/bot-crossing', threads: [] },
    { id: 'workspace:/work/perch-review', name: 'perch-review', path: '/work/perch-review', threads: [] },
  ])
})
