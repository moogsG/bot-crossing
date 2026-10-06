import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../hermes-plugin/', import.meta.url)
const read = (relative) => readFile(new URL(relative, root), 'utf8')

test('unified plugin package declares the dashboard API and desktop half', async () => {
  const [pluginYaml, manifest] = await Promise.all([
    read('plugin.yaml'),
    read('dashboard/manifest.json').then(JSON.parse),
  ])

  assert.match(pluginYaml, /^name: bot-crossing$/m)
  assert.match(pluginYaml, /^manifest_version: 2$/m)
  assert.match(pluginYaml, /^capabilities: \[\]$/m)
  assert.equal(manifest.name, 'bot-crossing')
  assert.equal(manifest.api, 'plugin_api.py')
  assert.equal(manifest.tab.hidden, true)
  assert.equal(manifest.tab.path, '/bot-crossing-dashboard')

  await assert.doesNotReject(read('desktop/plugin.js'))
})
