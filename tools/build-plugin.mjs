import { access, cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = path.join(root, 'hermes-plugin')
const runtime = path.join(root, 'dist')
const output = path.resolve(process.env.BOT_CROSSING_PLUGIN_OUT || path.join(root, 'release', 'bot-crossing'))
const app = path.join(output, 'dashboard', 'bot_crossing', 'app')

async function requireFile(relative) {
  const target = path.join(source, relative)
  await access(target)
  return target
}

await Promise.all([
  requireFile('plugin.yaml'),
  requireFile('dashboard/manifest.json'),
  requireFile('dashboard/plugin_api.py'),
  requireFile('desktop/plugin.js'),
  stat(runtime),
])

await rm(output, { recursive: true, force: true })
await mkdir(path.dirname(output), { recursive: true })
await cp(source, output, { recursive: true, filter: entry => !entry.includes('__pycache__') })
await rm(app, { recursive: true, force: true })
await cp(runtime, app, { recursive: true })

const manifest = JSON.parse(await readFile(path.join(output, 'dashboard', 'manifest.json'), 'utf8'))
if (manifest.api !== 'plugin_api.py') throw new Error('dashboard manifest must expose plugin_api.py')
await access(path.join(app, 'index.html'))

console.log(`Built Bot Crossing Hermes plugin: ${output}`)
