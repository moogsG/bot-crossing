import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
  },
})

/** Keep standalone URLs unchanged while allowing the packaged opaque-origin runtime to inject
 * data URLs for binary models. The transformed fallback is still Vite's normal BASE_URL. */
const embeddedAssets = () => ({
  name: 'bot-crossing-embedded-assets',
  enforce: 'pre',
  transform(code, id) {
    if (id.endsWith('/src/agents/crew.js')) {
      return code.replace(
        '`${import.meta.env.BASE_URL}assets/crew.glb`',
        "(globalThis.__BOT_CROSSING_ASSETS__?.['crew.glb'] || `${import.meta.env.BASE_URL}assets/crew.glb`)"
      )
    }
    if (id.endsWith('/src/world/kit.js')) {
      return code.replace(
        'loader.loadAsync(`${import.meta.env.BASE_URL}assets/${kit.file}`)',
        "loader.loadAsync(globalThis.__BOT_CROSSING_ASSETS__?.[kit.file] || `${import.meta.env.BASE_URL}assets/${kit.file}`)"
      )
    }
    return null
  },
})

export default defineConfig({
  plugins: [embeddedAssets(), api()],
  // PORT lets a second copy run alongside the first without a flag on the command line.
  server: { port: Number(process.env.PORT) || 5274, strictPort: false },
  build: { target: 'esnext' },
})
