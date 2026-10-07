import test from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../src/core/engine.js'

function fixture() {
  const calls = []
  const values = { renderScale: 1, autoQuality: true }
  const engine = Object.create(Engine.prototype)
  engine.settings = { get: (key) => values[key] }
  engine._targetScale = () => values.renderScale
  engine.canvas = { width: 640, height: 400, parentElement: { clientWidth: 640, clientHeight: 400 } }
  engine.camera = { updateProjectionMatrix() {}, layers: { enableAll() {} } }
  engine.renderer = {
    setSize(w, h) { calls.push('resize'); engine.canvas.width = w; engine.canvas.height = h },
    render() { calls.push('draw') },
  }
  engine.resize()
  engine._draw(0)
  calls.length = 0
  return { engine, values, calls }
}

test('window resize cannot clear the last frame between animation frames', () => {
  const { engine, calls } = fixture()
  engine.canvas.parentElement.clientWidth = 800
  engine.resize()
  assert.deepEqual(calls, [])
  assert.equal(engine.canvas.width, 640)
  engine._draw(0)
  assert.deepEqual(calls, ['resize', 'draw'])
  assert.equal(engine.canvas.width, 800)
})

test('focus/unchanged resize keeps the buffer and adaptive resolution', () => {
  const { engine, calls } = fixture()
  engine.viewport.scale = 0.7
  engine.resize()
  engine._draw(0)
  assert.equal(engine.viewport.scale, 0.7)
  assert.equal(engine.canvas.width, 448)
  calls.length = 0
  engine.resize()
  engine._draw(0)
  assert.deepEqual(calls, ['draw'])
})

test('disabling adaptive quality restores the requested resolution', () => {
  const { engine, values } = fixture()
  engine.viewport.scale = 0.7
  engine.resize()
  values.autoQuality = false
  engine.resize()
  assert.equal(engine.viewport.scale, 1)
  assert.equal(engine.autoScaled, false)
})

test('changing the resolution ceiling resizes on the next draw', () => {
  const { engine, values, calls } = fixture()
  values.renderScale = 0.5
  engine.resize()
  assert.deepEqual(calls, [])
  engine._draw(0)
  assert.equal(engine.canvas.width, 320)
  assert.equal(engine.viewport.scale, 0.5)
  assert.deepEqual(calls, ['resize', 'draw'])
})

test('a newly enabled composer gets sized even when the canvas already has that size', () => {
  const { engine, calls } = fixture()
  engine.composer = {
    renderTarget1: { width: 1, height: 1 },
    setSize(w, h) { calls.push(['composer', w, h]) },
  }
  engine.resize()
  engine._resizeBuffers()
  assert.deepEqual(calls, [['composer', 640, 400]])
})

test('adaptive quality reacts to sustained frames outside the 20ms performance budget', () => {
  const oldWindow = globalThis.window
  globalThis.window = { devicePixelRatio: 1 }
  try {
    const { engine } = fixture()
    engine.perf = { fps: 47 }
    for (let i = 0; i < 3; i++) {
      engine._lastGovern = -Infinity
      engine._governQuality()
    }
    assert.equal(engine.viewport.scale, 0.85)
    assert.equal(engine._resizePending, true)
  } finally {
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
  }
})

test('adaptive quality reacts to repeated tail-latency failures even when average fps is high', () => {
  const oldWindow = globalThis.window
  globalThis.window = { devicePixelRatio: 2 }
  try {
    const { engine } = fixture()
    engine.viewport.scale = 2
    engine.perf = { fps: 60, windowP95: 25, windowP99: 45, windowMax: 120 }
    for (let i = 0; i < 3; i++) {
      engine._lastGovern = -Infinity
      engine._governQuality()
    }
    assert.equal(engine.viewport.scale, 1.7)
    assert.equal(engine._resizePending, true)
  } finally {
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
  }
})
