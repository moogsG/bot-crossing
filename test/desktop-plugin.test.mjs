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

  const context = {
    console,
    Promise,
    ROUTES_AREA: 'routes',
    SIDEBAR_NAV_AREA: 'sidebar',
    PALETTE_AREA: 'palette',
    host: { navigate: (path) => navigations.push(path) },
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
  }

  const source = (await readFile(pluginPath, 'utf8'))
    .replace(/^import .*$/gm, '')
    .replace('export default plugin', 'globalThis.__plugin = plugin')
  vm.runInNewContext(source, context, { filename: pluginPath.pathname })
  context.__plugin.register({ rest, register: (entry) => contributions.push(entry) })

  return {
    plugin: context.__plugin,
    contributions,
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

test('diagnostic page renders loading and healthy states from the scoped REST client', async () => {
  const calls = []
  const loaded = await loadPlugin({
    rest: async (...args) => {
      calls.push(args)
      return { status: 'healthy', plugin: 'bot-crossing', profile: 'builder' }
    },
  })

  assert.match(text(loaded.render()), /Checking plugin health/)
  await loaded.flushEffect()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '/health')
  assert.equal(calls[0][1].method, 'GET')
  assert.match(text(loaded.render()), /Bot Crossing is ready/)
  assert.match(text(loaded.render()), /builder/)
})

test('diagnostic page renders an explicit unavailable state', async () => {
  const loaded = await loadPlugin({ rest: async () => { throw new Error('offline') } })

  loaded.render()
  await loaded.flushEffect()
  assert.match(text(loaded.render()), /Bot Crossing is unavailable/)
})
