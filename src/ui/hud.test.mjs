import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { morganAttentionCount, taskDetailsFor } = await vite.ssrLoadModule('/src/ui/hud.js')
await vite.close()

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
