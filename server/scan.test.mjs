import assert from 'node:assert/strict'
import { test } from 'node:test'

import { scanActorSnapshotsFrom, scanProjectCatalogFrom } from './scan.mjs'

test('project catalog aggregation is stable, deduplicated, and fault isolated', async () => {
  const warnings = []
  const harnesses = [
    {
      id: 'good',
      scanProjects: async () => [
        { id: 'p_two', slug: 'two', name: 'Two', path: '/work/two' },
        { id: 'p_one', slug: 'one', name: 'One', path: '/work/one' },
      ],
    },
    {
      id: 'duplicate',
      scanProjects: async () => [{ id: 'p_other', slug: 'one', name: 'Duplicate', path: '/other' }],
    },
    { id: 'threads-only' },
    { id: 'broken', scanProjects: async () => Promise.reject(new Error('broken registry')) },
  ]

  const projects = await scanProjectCatalogFrom(harnesses, (message) => warnings.push(message))

  assert.deepEqual(projects, [
    { id: 'p_one', slug: 'one', name: 'One', path: '/work/one' },
    { id: 'p_two', slug: 'two', name: 'Two', path: '/work/two' },
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /broken registry/)
})

test('actor aggregation is stable, deduplicated, and fault isolated', async () => {
  const warnings = []
  const actor = { id: 'hermes-kanban:actor:t_one:1', taskId: 't_one', runId: 1 }
  const actors = await scanActorSnapshotsFrom(
    [
      {
        id: 'first',
        scanActors: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return [actor]
        },
      },
      { id: 'duplicate', scanActors: async () => [{ ...actor }] },
      { id: 'threads-only' },
      { id: 'broken', scanActors: async () => Promise.reject(new Error('broken actor scan')) },
    ],
    (message) => warnings.push(message)
  )

  assert.deepEqual(actors, [{ ...actor, harness: 'first' }])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /broken actor scan/)
})
