import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Real-browser release journey. This stays outside the node:test glob because the project does
 * not launch the application server itself. Run it against a live candidate:
 *
 *   npm run test:browser -- http://localhost:5287/
 *   FRAMED=1 npm run test:browser -- http://localhost:5287/
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
const framed = process.env.FRAMED === '1'
const browser = await chromium.launch({ headless: process.env.HEADLESS === '1' })
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor })
const page = await context.newPage()
const consoleErrors = []
const pageErrors = []
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', error => pageErrors.push(String(error)))
page.addInitScript(() => {
  window.__journeyEvents = []
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) {
    addEventListener(type, event => window.__journeyEvents.push({
      type,
      target: event.target?.className || event.target?.id || event.target?.tagName,
      buttons: event.buttons,
    }), true)
  }
})

const mime = file => ({
  '.glb': 'model/gltf-binary',
  '.hdr': 'image/vnd.radiance',
})[path.extname(file).toLowerCase()] || 'application/octet-stream'

async function embeddedRuntime() {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url))
  const index = await readFile(path.join(dist, 'index.html'), 'utf8')
  const scriptPath = index.match(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/)?.[1]
  const stylePath = index.match(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/)?.[1]
  assert.ok(scriptPath && stylePath, 'production index must reference Vite JS and CSS')
  const [script, style, names] = await Promise.all([
    readFile(path.join(dist, scriptPath.replace(/^\//, '')), 'utf8'),
    readFile(path.join(dist, stylePath.replace(/^\//, '')), 'utf8'),
    readdir(path.join(dist, 'assets'), { recursive: true }),
  ])
  const assets = {}
  for (const name of names.sort()) {
    if (!/\.(?:glb|hdr)$/i.test(name)) continue
    const bytes = await readFile(path.join(dist, 'assets', name))
    assets[name.replaceAll(path.sep, '/')] = `data:${mime(name)};base64,${bytes.toString('base64')}`
  }
  const token = 'framed-journey-bootstrap-token'
  const bootstrap = `
    const TOKEN=${JSON.stringify(token)}, pending=new Map(); let sequence=0;
    try { void localStorage.length } catch {
      const values=new Map(); Object.defineProperty(globalThis,'localStorage',{value:{
        getItem:key=>values.has(String(key))?values.get(String(key)):null,
        setItem:(key,value)=>values.set(String(key),String(value)), removeItem:key=>values.delete(String(key)),
        clear:()=>values.clear(), key:index=>[...values.keys()][index]??null,
        get length(){return values.size}
      }});
    }
    globalThis.__BOT_CROSSING_TRANSPORT__=(url,options={})=>new Promise(resolve=>{
      const id=String(++sequence); pending.set(id,{resolve});
      parent.postMessage({kind:'bot-crossing:request',token:TOKEN,id,url:String(url),method:String(options.method||'GET').toUpperCase(),body:options.body??null},'*');
    });
    addEventListener('message',event=>{const message=event.data,entry=pending.get(message?.id);
      if(event.source!==parent||message?.kind!=='bot-crossing:response'||message.token!==TOKEN||!entry)return;
      pending.delete(message.id); entry.resolve(new Response(JSON.stringify(message.body??{}),{status:message.status||500,headers:{'Content-Type':'application/json'}}));
    });
    (async()=>{const response=await globalThis.__BOT_CROSSING_TRANSPORT__('/__bot-crossing/assets');
      globalThis.__BOT_CROSSING_ASSETS__=(await response.json()).assets||{};
      const source=document.querySelector('#bot-crossing-application');
      const application=document.createElement('script'); application.type='module';
      application.textContent=source.textContent; source.remove(); document.body.append(application);
      setTimeout(()=>{globalThis.__BOT_CROSSING_ASSETS__={}},5000);
    })().catch(console.error);`
  const application = script.replaceAll('</script', '<\\/script')
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head><body><div id="app"></div><script id="bot-crossing-application" type="text/plain">${application}</script><script>${bootstrap.replaceAll('</script', '<\\/script')}</script></body></html>`
  return { src: `data:text/html;base64,${Buffer.from(document).toString('base64')}`, token, assets }
}

let world = page
const state = () => world.evaluate(() => {
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
const frames = milliseconds => world.evaluate(ms => new Promise(resolve => {
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
const cameraState = ({ target, distance, azimuth, polar }) => ({ target, distance, azimuth, polar })

try {
  if (framed) {
    await page.route(url, route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body></body></html>',
    }))
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.unroute(url)
    const runtime = await embeddedRuntime()
    await page.evaluate(({ src, token, assets }) => {
      document.body.innerHTML = '<iframe id="colony" title="Bot Crossing colony" sandbox="allow-scripts allow-pointer-lock" style="width:100%;height:100vh;border:0"></iframe>'
      const frame = document.querySelector('#colony')
      let assetPayload = assets
      addEventListener('message', async event => {
        const message = event.data
        if (event.source !== frame.contentWindow || message?.kind !== 'bot-crossing:request' || message.token !== token) return
        if (message.method === 'GET' && message.url === '/__bot-crossing/assets') {
          event.source.postMessage({ kind: 'bot-crossing:response', token, id: message.id, status: 200, body: { assets: assetPayload } }, '*')
          assetPayload = null
          return
        }
        try {
          const response = await fetch(new URL(message.url, location.origin), {
            method: message.method,
            headers: message.body == null ? undefined : { 'Content-Type': 'application/json' },
            body: message.body,
          })
          const body = await response.json().catch(() => ({}))
          event.source.postMessage({ kind: 'bot-crossing:response', token, id: message.id, status: response.status, body }, '*')
        } catch (error) {
          event.source.postMessage({ kind: 'bot-crossing:response', token, id: message.id, status: 503, body: { error: String(error) } }, '*')
        }
      })
      frame.src = src
    }, runtime)
    world = page.frames().find(frame => frame !== page.mainFrame())
    assert.ok(world, 'sandboxed colony frame must mount')
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
  }
  try {
    await world.waitForFunction(() => document.querySelector('.boot')?.classList.contains('gone'), null, { timeout: 30000 })
  } catch (error) {
    console.error(JSON.stringify({ consoleErrors, pageErrors, body: await world.locator('body').innerText().catch(() => '') }, null, 2))
    throw error
  }
  await world.evaluate(() => {
    if (Array.isArray(window.__journeyEvents)) return
    window.__journeyEvents = []
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) {
      addEventListener(type, event => window.__journeyEvents.push({
        type,
        target: event.target?.className || event.target?.id || event.target?.tagName,
        buttons: event.buttons,
      }), true)
    }
  })
  assert.equal(await world.locator('.help').getAttribute('aria-hidden'), 'false')
  assert.match(await world.locator('.help .sub').innerText(), /controls are paused/i)

  const blocked = await state()
  await page.mouse.move(width * 0.48, height * 0.45)
  await page.mouse.down()
  await page.mouse.move(width * 0.55, height * 0.52, { steps: 4 })
  await page.mouse.up()
  await page.mouse.wheel(0, 120)
  await page.waitForTimeout(100)
  assert.deepEqual(cameraState(await state()), cameraState(blocked), 'the visible modal must clearly and completely pause world input')

  await world.locator('#btn-help-close').click()
  assert.equal(await world.locator('.help').getAttribute('aria-hidden'), 'true')
  const canvas = world.locator('canvas.bot-crossing-canvas')
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
  const capturedMoves = await world.evaluate(() => window.__journeyEvents.filter(event => event.type === 'pointermove' && event.buttons === 1))
  assert.ok(capturedMoves.slice(-8).every(event => event.target === 'bot-crossing-canvas'), 'captured drag must stay canvas-owned across the HUD')

  if (framed) {
    const beforeResize = await state()
    await page.locator('#colony').evaluate(element => { element.style.width = '72%'; element.style.height = '70vh' })
    await world.waitForFunction(([w, h]) => window.botCrossing.engine.canvas.width !== w || window.botCrossing.engine.canvas.height !== h, beforeResize.buffer)
    assert.notDeepEqual((await state()).buffer, beforeResize.buffer, 'sandboxed runtime must follow sash/container resize')
    await canvas.click({ position: { x: 8, y: 8 } })
    assert.equal(await world.evaluate(() => document.hasFocus()), true)
  }

  // Let one-time shader/material work finish, then keep measuring across the 15-second
  // snapshot poll boundary. A short sample can miss the exact recurring stalls this gate owns.
  await frames(10000)
  const steady = await frames(20000)
  const p95 = percentile(steady, 0.95)
  const p99 = percentile(steady, 0.99)
  const p95Budget = framed ? 34 : 21.5
  const p99Budget = framed ? 99 : 33
  assert.ok(p95 <= p95Budget, `steady p95 ${p95.toFixed(1)}ms exceeded the ${p95Budget}ms framed/direct budget`)
  assert.ok(p99 <= p99Budget, `steady p99 ${p99.toFixed(1)}ms exceeded the ${p99Budget}ms framed/direct budget`)
  const longFrames = steady.filter(value => value >= 100).length
  assert.ok(longFrames <= (framed ? 6 : 0), `warm steady state contained ${longFrames} recurring 100ms stalls`)

  if (framed) {
    await page.locator('#colony').evaluate(element => { element.style.display = 'none' })
    await page.waitForTimeout(100)
    await page.locator('#colony').evaluate(element => { element.style.display = 'block' })
    await world.waitForFunction(() => window.botCrossing?.engine?.canvas?.width > 0)
    const recovered = await world.evaluate(async () => {
      const canvas = window.botCrossing.engine.canvas
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      const extension = gl?.getExtension('WEBGL_lose_context')
      if (!extension) return 'unsupported'
      extension.loseContext()
      await new Promise(resolve => setTimeout(resolve, 100))
      extension.restoreContext()
      await new Promise(resolve => setTimeout(resolve, 500))
      return gl.isContextLost() ? 'lost' : 'restored'
    })
    assert.notEqual(recovered, 'lost', 'WebGL context must recover when the browser exposes WEBGL_lose_context')
  }
  assert.deepEqual(consoleErrors, [])
  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({ viewport: { width, height, deviceScaleFactor }, framed, before, zoomed, p95, p99 }, null, 2))
} finally {
  await browser.close()
}
