import assert from 'node:assert/strict'
import { test } from 'node:test'

import { scanProjectCatalogFrom } from './scan.mjs'

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
