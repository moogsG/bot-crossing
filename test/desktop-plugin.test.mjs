import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const pluginPath = new URL('../hermes-plugin/desktop/plugin.js', import.meta.url)

async function loadPlugin({ rest }) {
  let hookIndex = 0
  let states = []
  let effects = []
  const contributions = []
  const navigations = []
  const listeners = new Map()
  const frameMessages = []
  const frameWindow = { postMessage: (message) => frameMessages.push(message) }

  const context = {
    console,
    Promise,
    ROUTES_AREA: 'routes',
    SIDEBAR_NAV_AREA: 'sidebar',
    PALETTE_AREA: 'palette',
    host: { navigate: (path) => navigations.push(path) },
    window: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type, listener) => {
        if (listeners.get(type) === listener) listeners.delete(type)
      },
    },
    URL,
    SandboxedFrame: (props) => {
      props.ref.current = { contentWindow: frameWindow }
      return { type: 'SandboxedFrame', props }
    },
    jsx: (type, props = {}) => typeof type === 'function' ? type(props) : ({ type, props }),
    jsxs: (type, props = {}) => typeof type === 'function' ? type(props) : ({ type, props }),
    useState(initial) {
      const index = hookIndex++
      if (!(index in states)) states[index] = initial
      return [states[index], (value) => {
        states[index] = typeof value === 'function' ? value(states[index]) : value
      }]
    },
    useEffect(effect) {
      effects.push(effect)
    },
    useRef(initial) {
      const index = hookIndex++
      if (!(index in states)) states[index] = { current: initial }
      return states[index]
    },
  }

  const source = (await readFile(pluginPath, 'utf8'))
    .replace(/^import .*$/gm, '')
    .replace('export default plugin', 'globalThis.__plugin = plugin')
  vm.runInNewContext(source, context, { filename: pluginPath.pathname })
  context.__plugin.register({ rest, register: (entry) => contributions.push(entry) })

  return {
    plugin: context.__plugin,
    contributions,
    frameMessages,
    frameWindow,
    listeners,
    navigations,
    render() {
      hookIndex = 0
      effects = []
      const route = contributions.find(({ area }) => area === 'routes')
      return route.render()
    },
    async flushEffect() {
      const effect = effects[0]
      assert.equal(typeof effect, 'function')
      effect()
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

const text = (tree) => JSON.stringify(tree)

test('desktop plugin registers one route, sidebar item, and palette command', async () => {
  const loaded = await loadPlugin({ rest: async () => ({ status: 'healthy', profile: 'builder' }) })
  assert.equal(loaded.plugin.id, 'bot-crossing')
  assert.deepEqual(loaded.contributions.map(({ area }) => area), ['routes', 'sidebar', 'palette'])
  assert.equal(loaded.contributions[0].data.path, '/bot-crossing')
  assert.equal(loaded.contributions[1].data.path, '/bot-crossing')

  loaded.contributions[2].data.run()
  assert.deepEqual(loaded.navigations, ['/bot-crossing'])
})

test('colony page loads a sandboxed prebuilt runtime from the scoped REST client', async () => {
  const calls = []
  const loaded = await loadPlugin({
    rest: async (...args) => {
      calls.push(args)
      return { src: 'data:text/html;base64,PGgxPkJvdCBDcm9zc2luZzwvaDE+', bootstrapToken: 'bootstrap-token', assets: { 'crew.glb': 'data:model/gltf-binary;base64,YQ==' } }
    },
  })

  assert.match(text(loaded.render()), /Loading the colony/)
  await loaded.flushEffect()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '/runtime')
  assert.equal(calls[0][1].method, 'GET')
  const frame = loaded.render()
  assert.equal(frame.type, 'SandboxedFrame')
  assert.equal(frame.props.title, 'Bot Crossing colony')
  assert.equal(frame.props.sandbox, 'allow-scripts allow-pointer-lock')
  assert.ok(!frame.props.sandbox.includes('allow-same-origin'))
})

test('colony page renders explicit unavailable and retry controls', async () => {
  const loaded = await loadPlugin({ rest: async () => { throw new Error('offline') } })

  loaded.render()
  await loaded.flushEffect()
  const unavailable = loaded.render()
  assert.match(text(unavailable), /Bot Crossing is unavailable/)
  assert.match(text(unavailable), /Retry/)
})

test('opaque frame requests are token-checked, allowlisted, and brokered through ctx.rest', async () => {
  const calls = []
  const loaded = await loadPlugin({
    rest: async (path, options) => {
      calls.push([path, options])
      if (path === '/runtime') {
        return { src: 'data:text/html;base64,PGgxPkJvdCBDcm9zc2luZzwvaDE+', bootstrapToken: 'bootstrap-token', assets: { 'crew.glb': 'data:model/gltf-binary;base64,YQ==' } }
      }
      return { status: 200, body: { threads: [] } }
    },
  })

  loaded.render()
  await loaded.flushEffect()
  loaded.render()
  const listener = loaded.listeners.get('message')
  listener({
    source: loaded.frameWindow,
    data: { kind: 'bot-crossing:request', token: 'bootstrap-token', id: 'assets', url: '/__bot-crossing/assets', method: 'GET' },
  })
  assert.equal(loaded.frameMessages[0].body.assets['crew.glb'], 'data:model/gltf-binary;base64,YQ==')
  listener({
    source: loaded.frameWindow,
    data: { kind: 'bot-crossing:request', token: 'bootstrap-token', id: '1', url: '/api/threads?source=native-kanban', method: 'GET' },
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls[1][0], '/transport')
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1][1].body)), {
    path: '/api/threads?source=native-kanban', method: 'GET', body: null,
  })
  assert.equal(loaded.frameMessages[1].status, 200)

  listener({
    source: loaded.frameWindow,
    data: { kind: 'bot-crossing:request', token: 'wrong', id: '2', url: '/api/state', method: 'PUT', body: '{}' },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2, 'a message without the bootstrap token must not reach the backend')
})
