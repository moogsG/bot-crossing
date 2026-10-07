import assert from 'node:assert/strict'
import { access, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
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

  await Promise.all([
    read('__init__.py'),
    read('desktop/plugin.js'),
  ])
})

test('plugin assembler emits one self-contained runtime payload', async () => {
  const output = path.join(tmpdir(), `bot-crossing-plugin-test-${process.pid}`)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['tools/build-plugin.mjs'], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, BOT_CROSSING_PLUGIN_OUT: output },
        stdio: 'inherit',
      })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`plugin assembler exited ${code}`)))
    })

    await Promise.all([
      access(path.join(output, 'plugin.yaml')),
      access(path.join(output, '__init__.py')),
      access(path.join(output, 'desktop', 'plugin.js')),
      access(path.join(output, 'dashboard', 'plugin_api.py')),
      access(path.join(output, 'dashboard', 'bot_crossing', 'app', 'index.html')),
    ])
    const manifest = JSON.parse(await readFile(path.join(output, 'dashboard', 'manifest.json'), 'utf8'))
    assert.equal(manifest.api, 'plugin_api.py')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})
