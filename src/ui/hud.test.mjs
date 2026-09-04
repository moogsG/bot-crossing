import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { Hud, morganAttentionCount, taskDetailsFor } = await vite.ssrLoadModule('/src/ui/hud.js')
await vite.close()

function fakeElement() {
  return {
    classList: { add() {}, remove() {} },
    style: {},
    innerHTML: '',
    textContent: '',
    title: '',
    disabled: false,
    scrollTop: 0,
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
  }
}

function projectPanelHud() {
  const elements = new Map()
  const hud = Object.create(Hud.prototype)
  hud._last = {}
  hud.actions = {}
  hud.$ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, fakeElement())
    return elements.get(selector)
  }
  return { hud, elements }
}

test('Hermes task detail rows expose operational fields and an honest never heartbeat', () => {
  const thread = {
    source: 'native-kanban',
    preview: 'Useful task summary',
    attentionLabel: 'Requires Morgan',
    worktree: 't_details',
    details: {
      taskId: 't_details',
      body: 'Useful task summary',
      kanbanStatus: 'blocked',
      projectId: 'p_product',
      tenant: '',
      workspace: '/work/product/.worktrees/t_details',
      workspaceKind: 'worktree',
      branch: 'product/t_details',
      steward: 'Jynx',
      assignee: 'reviewer',
      runProfile: 'builder',
      runStatus: 'blocked',
      lastHeartbeatAt: 0,
    },
  }

  assert.deepEqual(taskDetailsFor(thread, () => 'never'), {
    summary: 'Useful task summary',
    rows: [
      ['Task', 't_details'],
      ['Kanban', 'blocked'],
      ['Attention', 'Requires Morgan'],
      ['Project', 'p_product'],
      ['Workspace', '/work/product/.worktrees/t_details'],
      ['Worktree', 't_details'],
      ['Branch', 'product/t_details'],
      ['Steward', 'Jynx'],
      ['Assignee', 'reviewer'],
      ['Run profile', 'builder'],
      ['Run state', 'blocked'],
      ['Heartbeat', 'never'],
    ],
  })
})

test('non-Hermes cards keep their preview without task-only rows', () => {
  assert.deepEqual(taskDetailsFor({ source: 'desktop', preview: 'Existing preview' }), {
    summary: 'Existing preview',
    rows: [],
  })
})

test('project summary counts only explicit Morgan attention and preserves legacy waiting cards', () => {
  assert.equal(
    morganAttentionCount([
      { status: 'blocked', requiresMorgan: true },
      { status: 'blocked', requiresMorgan: true },
      { status: 'blocked', requiresMorgan: false },
      { status: 'blocked', requiresMorgan: false },
      { status: 'blocked', requiresMorgan: false },
      { status: 'idle', requiresMorgan: false },
      { status: 'waiting' },
    ]),
    3
  )
})

test('open project panel refreshes Morgan attention when blocked status does not change', () => {
  const previousDocument = globalThis.document
  globalThis.document = { createElement: fakeElement }
  try {
    const { hud, elements } = projectPanelHud()
    const project = {
      name: 'Product',
      path: '/work/product',
      accent: 0x123456,
      selectedId: null,
      threads: [
        {
          id: 't_attention',
          status: 'blocked',
          title: 'Waiting task',
          lastActivityAt: 100,
          requiresMorgan: true,
        },
      ],
    }

    hud.setProject(project)
    assert.match(elements.get('.side .threads-head').innerHTML, /1 need you/)

    hud.setProject({
      ...project,
      threads: [{ ...project.threads[0], requiresMorgan: false }],
    })
    assert.doesNotMatch(elements.get('.side .threads-head').innerHTML, /need you/)
  } finally {
    globalThis.document = previousDocument
  }
})
