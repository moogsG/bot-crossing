import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'

const ROUTE = '/bot-crossing'

function DiagnosticPage({ rest }) {
  const [diagnostic, setDiagnostic] = useState({ state: 'loading' })

  useEffect(() => {
    let active = true
    rest('/health', { method: 'GET' })
      .then((health) => {
        if (!active) return
        if (health?.status !== 'healthy') throw new Error('The health endpoint returned an unhealthy response.')
        setDiagnostic({ state: 'healthy', health })
      })
      .catch((error) => {
        if (active) setDiagnostic({ state: 'unavailable', message: error?.message || 'Health check failed.' })
      })
    return () => { active = false }
  }, [rest])

  const frame = {
    maxWidth: '720px',
    margin: '0 auto',
    padding: '48px 32px',
    color: 'var(--ui-text-primary)',
  }
  const secondary = { color: 'var(--ui-text-secondary)' }

  if (diagnostic.state === 'loading') {
    return jsxs('main', {
      style: frame,
      children: [jsx('h1', { children: 'Bot Crossing' }), jsx('p', { role: 'status', style: secondary, children: 'Checking plugin health…' })],
    })
  }

  if (diagnostic.state === 'unavailable') {
    return jsxs('main', {
      style: frame,
      children: [
        jsx('h1', { children: 'Bot Crossing is unavailable' }),
        jsx('p', { role: 'alert', style: secondary, children: diagnostic.message }),
      ],
    })
  }

  return jsxs('main', {
    style: frame,
    children: [
      jsx('h1', { children: 'Bot Crossing is ready' }),
      jsx('p', { style: secondary, children: `Connected to the ${diagnostic.health.profile} profile.` }),
    ],
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
      render: () => jsx(DiagnosticPage, { rest: ctx.rest }),
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
