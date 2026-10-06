import assert from 'node:assert/strict'

/**
 * Real-browser release journey. This stays outside the node:test glob because the project does
 * not launch the application server itself. Run it against a live candidate:
 *
 *   npm run test:browser -- http://localhost:5287/
 *
 * It is headed by default so DOM hit-testing, pointer capture, WebGL and the compositor all take
 * the same route as the user-facing app. Set HEADLESS=1 only for CI environments without a display.
 */
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const { chromium } = await import(modulePath)
const url = process.argv[2] || 'http://localhost:5285/'
const width = Number(process.env.VIEWPORT_WIDTH || 1440)
const height = Number(process.env.VIEWPORT_HEIGHT || 900)
const deviceScaleFactor = Number(process.env.DEVICE_SCALE_FACTOR || 2)
const browser = await chromium.launch({ headless: process.env.HEADLESS === '1' })
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor })
const page = await context.newPage()
const consoleErrors = []
const pageErrors = []
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', error => pageErrors.push(String(error)))
await page.addInitScript(() => {
  window.__journeyEvents = []
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) {
    addEventListener(type, event => window.__journeyEvents.push({
      type,
      target: event.target?.className || event.target?.id || event.target?.tagName,
      buttons: event.buttons,
    }), true)
  }
})

const state = () => page.evaluate(() => {
  const { rig, engine } = window.botCrossing
  return {
    target: rig.target.toArray(),
    distance: rig.desiredDistance,
    azimuth: rig.desiredAzimuth,
    polar: rig.desiredPolar,
    buffer: [engine.canvas.width, engine.canvas.height],
    scale: engine.viewport.scale,
  }
})
const frames = milliseconds => page.evaluate(ms => new Promise(resolve => {
  const samples = []
  let previous = performance.now()
  const started = previous
  const tick = now => {
    samples.push(now - previous)
    previous = now
    if (now - started >= ms) resolve(samples)
    else requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}), milliseconds)
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor(values.length * fraction)]

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('.boot')?.classList.contains('gone'), null, { timeout: 30000 })
  assert.equal(await page.locator('.help').getAttribute('aria-hidden'), 'false')
  assert.match(await page.locator('.help .sub').innerText(), /controls are paused/i)

  const blocked = await state()
  await page.mouse.move(width * 0.48, height * 0.45)
  await page.mouse.down()
  await page.mouse.move(width * 0.55, height * 0.52, { steps: 4 })
  await page.mouse.up()
  await page.mouse.wheel(0, 120)
  await page.waitForTimeout(100)
  assert.deepEqual(await state(), blocked, 'the visible modal must clearly and completely pause world input')

  await page.locator('#btn-help-close').click()
  assert.equal(await page.locator('.help').getAttribute('aria-hidden'), 'true')
  const canvas = page.locator('canvas.bot-crossing-canvas')
  const box = await canvas.boundingBox()
  const x = box.x + box.width * 0.35
  const y = box.y + box.height * 0.55
  const before = await state()

  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 180, y + 50, { steps: 8 })
  await page.mouse.move(box.x + box.width - 30, y + 50, { steps: 8 })
  await page.mouse.up()
  const panned = await state()
  assert.notDeepEqual(panned.target, before.target, 'left drag must pan')

  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(x + 80, y + 35, { steps: 8 })
  await page.mouse.up({ button: 'right' })
  const orbited = await state()
  assert.notEqual(orbited.azimuth, panned.azimuth, 'right drag must orbit')
  assert.notEqual(orbited.polar, panned.polar, 'vertical right drag must tilt')

  await page.mouse.move(x, y)
  await page.mouse.wheel(0, 120)
  const zoomed = await state()
  assert.notEqual(zoomed.distance, orbited.distance, 'wheel/trackpad input must zoom')
  const capturedMoves = await page.evaluate(() => window.__journeyEvents.filter(event => event.type === 'pointermove' && event.buttons === 1))
  assert.ok(capturedMoves.slice(-8).every(event => event.target === 'bot-crossing-canvas'), 'captured drag must stay canvas-owned across the HUD')

  // Let one-time shader/material work finish, then keep measuring across the 15-second
  // snapshot poll boundary. A short sample can miss the exact recurring stalls this gate owns.
  await frames(10000)
  const steady = await frames(20000)
  const p95 = percentile(steady, 0.95)
  const p99 = percentile(steady, 0.99)
  assert.ok(p95 <= 21.5, `steady p95 ${p95.toFixed(1)}ms exceeded the 20ms budget plus timer precision`)
  assert.ok(p99 <= 33, `steady p99 ${p99.toFixed(1)}ms exceeded budget`)
  assert.equal(steady.filter(value => value >= 100).length, 0, 'warm steady state must not contain recurring 100ms stalls')
  assert.deepEqual(consoleErrors, [])
  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({ viewport: { width, height, deviceScaleFactor }, before, zoomed, p95, p99 }, null, 2))
} finally {
  await browser.close()
}
