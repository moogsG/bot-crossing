import assert from 'node:assert/strict'
import { test } from 'node:test'

import { standingClipFor } from '../game/actor-lifecycle.js'

test('worker roles select semantically quiet existing clips', () => {
  assert.equal(standingClipFor({ status: 'working' }), 'work')
  assert.equal(standingClipFor({ status: 'reviewing' }), 'interact')
  assert.equal(standingClipFor({ status: 'internal-wait' }), 'idle')
  assert.equal(standingClipFor({ status: 'requires-morgan', role: 'jynx', stewardSignal: true }), 'wave')
  assert.equal(standingClipFor({ status: 'requires-morgan', role: 'builder', stewardSignal: false }), 'idle')
  assert.equal(standingClipFor({ status: 'celebrating' }), 'cheer')
})
