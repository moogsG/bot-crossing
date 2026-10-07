import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { host, PALETTE_AREA, ROUTES_AREA, SandboxedFrame, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'

const ROUTE = '/bot-crossing'
const ALLOWED_REQUESTS = new Map([
  ['GET /api/health', true],
  ['GET /api/bootstrap', true],
  ['GET /api/projects', true],
  ['GET /api/threads', true],
  ['GET /api/actors', true],
  ['GET /api/events', true],
  ['GET /api/state', true],
  ['PUT /api/state', true],
])

function parseBody(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return value
  return JSON.parse(value)
}

function ColonyPage({ rest }) {
  const frameRef = useRef(null)
  const [attempt, setAttempt] = useState(0)
  const [runtime, setRuntime] = useState({ state: 'loading' })

  useEffect(() => {
    let active = true
    let bootstrapToken = null
    let runtimeAssets = {}
    setRuntime({ state: 'loading' })

    const respond = (source, token, id, response) => {
      source.postMessage({ kind: 'bot-crossing:response', token, id, ...response }, '*')
    }
    const onMessage = (event) => {
      const message = event.data
      if (
        !active ||
        !bootstrapToken ||
        event.source !== frameRef.current?.contentWindow ||
        message?.kind !== 'bot-crossing:request' ||
        message.token !== bootstrapToken
      ) return

      let parsed
      try {
        parsed = new URL(message.url, 'https://bot-crossing.invalid')
      } catch {
        respond(event.source, message.token, message.id, { status: 400, body: { error: 'Invalid Bot Crossing request URL' } })
        return
      }
      const method = String(message.method || 'GET').toUpperCase()
      if (method === 'GET' && parsed.pathname === '/__bot-crossing/assets') {
        respond(event.source, message.token, message.id, { status: 200, body: { assets: runtimeAssets } })
        runtimeAssets = {}
        return
      }
      if (!ALLOWED_REQUESTS.has(`${method} ${parsed.pathname}`)) {
        respond(event.source, message.token, message.id, { status: 403, body: { error: 'Bot Crossing request is not allowed' } })
        return
      }

      let body
      try {
        body = parseBody(message.body)
      } catch {
        respond(event.source, message.token, message.id, { status: 400, body: { error: 'Invalid JSON request body' } })
        return
      }
      rest('/transport', {
        method: 'POST',
        body: { path: `${parsed.pathname}${parsed.search}`, method, body },
      }).then(
        (packet) => respond(event.source, message.token, message.id, packet),
        (error) => respond(event.source, message.token, message.id, {
          status: 503,
          body: { error: error?.message || 'Hermes plugin request failed.' },
        })
      )
    }
    window.addEventListener('message', onMessage)
    rest('/runtime', { method: 'GET', timeoutMs: 30000 })
      .then((payload) => {
        if (!active) return
        if (!payload?.src?.startsWith('data:text/html;base64,') || !payload?.bootstrapToken) {
          throw new Error('The Bot Crossing runtime returned an invalid bootstrap payload.')
        }
        bootstrapToken = payload.bootstrapToken
        runtimeAssets = payload.assets && typeof payload.assets === 'object' ? payload.assets : {}
        setRuntime({ state: 'ready', src: payload.src, bootstrapToken: payload.bootstrapToken })
      })
      .catch((error) => {
        if (active) setRuntime({ state: 'unavailable', message: error?.message || 'Runtime bootstrap failed.' })
      })

    return () => {
      active = false
      window.removeEventListener('message', onMessage)
    }
  }, [rest, attempt])

  const frame = {
    width: '100%',
    height: '100%',
    minHeight: '320px',
    border: 0,
    display: 'block',
  }
  const fallback = {
    maxWidth: '720px',
    margin: '0 auto',
    padding: '48px 32px',
    color: 'var(--ui-text-primary)',
  }

  if (runtime.state === 'loading') {
    return jsxs('main', {
      style: fallback,
      children: [
        jsx('h1', { children: 'Bot Crossing' }),
        jsx('p', { role: 'status', style: { color: 'var(--ui-text-secondary)' }, children: 'Loading the colony…' }),
      ],
    })
  }

  if (runtime.state === 'unavailable') {
    return jsxs('main', {
      style: fallback,
      children: [
        jsx('h1', { children: 'Bot Crossing is unavailable' }),
        jsx('p', { role: 'alert', style: { color: 'var(--ui-text-secondary)' }, children: runtime.message }),
        jsx('button', { type: 'button', onClick: () => setAttempt((value) => value + 1), children: 'Retry' }),
      ],
    })
  }

  return jsx(SandboxedFrame, {
    ref: frameRef,
    sandbox: 'allow-scripts allow-pointer-lock',
    src: runtime.src,
    style: frame,
    title: 'Bot Crossing colony',
  })
}

const plugin = {
  id: 'bot-crossing',
  name: 'Bot Crossing',
  description: 'View the active profile’s native Kanban colony.',
  defaultEnabled: false,

  register(ctx) {
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: ROUTE },
      render: () => jsx(ColonyPage, { rest: ctx.rest }),
    })
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: ROUTE, label: 'Bot Crossing', codicon: 'organization' },
    })
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'bot-crossing.open',
        label: 'Bot Crossing: Open colony',
        keywords: ['kanban', 'colony', 'agents'],
        run: () => host.navigate(ROUTE),
      },
    })
  },
}

export default plugin
