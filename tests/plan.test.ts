/**
 * ACP plan updates driven by the `todos` projection (PLAN.md M9).
 *
 * Two delivery points are covered: live projection changes during a turn, and
 * the initial snapshot published after `session/load` (replay alone starts no
 * projection drive). Values are whole-list, matching both the projection and
 * the ACP `plan` update semantics.
 *
 * The testkit always mounts the real projection registry, so the live path
 * registers a test-only `todos` unit there instead of substituting the
 * service: the unit folds one todo out of each user message, which also makes
 * the post-load fold reproduce the same list from persisted history.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION, type SessionUpdate } from '@agentclientprotocol/sdk'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionPlan, subscribeTodoPlans, todoPlanValue } from '../src/features/plan.ts'
import { makeBridgeHarness, textResponse, waitFor, type BridgeHarness } from './harness.ts'

const CWD = process.cwd()

type PlanUpdate = Extract<SessionUpdate, { sessionUpdate: 'plan' }>

/** One todo entry, as the `todos` projection publishes it. */
interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** The registry surface these tests drive, matching the published contract. */
interface TestProjectionRegistry {
  register(definition: unknown): Promise<unknown>
  onChanged(listener: (session: Session, key: string, value: unknown) => void): () => void
}

/** Every plan update the client received, oldest first. */
function planUpdates(harness: BridgeHarness): PlanUpdate[] {
  return harness.updates.filter((update): update is PlanUpdate => update.sessionUpdate === 'plan')
}

/** The registry the testkit mounts; a deployment without it is covered separately. */
function projectionRegistry(harness: BridgeHarness): TestProjectionRegistry {
  const registry = harness.ctx.get('sessionProjections') as unknown as TestProjectionRegistry | undefined
  assert.ok(registry !== undefined, 'the testkit mounts the projection registry')
  return registry
}

/** Text of one user message; undefined for every other event. */
function userText(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Test-only `todos` unit: one in-progress todo per user message, "clear todos" empties the list. */
const todosUnit = {
  key: 'todos',
  stateSchema: { parse: (value: unknown): unknown => value },
  init: (): TodoItem[] | null => null,
  apply: (state: TodoItem[] | null, event: SessionEvent): TodoItem[] | null => {
    const text = userText(event)
    if (text === undefined) return state
    const open: TodoItem[] = [{ content: text, status: 'in_progress' }]
    return text === 'clear todos' ? [] : open
  },
  wire: {
    viewSchema: { parse: (value: unknown): unknown => value },
    view: (state: TodoItem[] | null): TodoItem[] | null => state,
    summary: false,
  },
  stateVersion: 1,
}

/** Client-visible unit on an unrelated key, proving the bridge filters by key. */
const counterUnit = {
  key: 'scratchCounter',
  stateSchema: { parse: (value: unknown): unknown => value },
  init: (): number => 0,
  apply: (state: number, event: SessionEvent): number => event.type === 'turn/start' ? state + 1 : state,
  wire: {
    viewSchema: { parse: (value: unknown): unknown => value },
    view: (state: number): number => state,
    summary: false,
  },
  stateVersion: 1,
}

test('maps only well-formed todo lists, keeping statuses and defaulting priority', () => {
  assert.equal(todoPlanValue(null), undefined)
  assert.equal(todoPlanValue('todos'), undefined)
  assert.equal(todoPlanValue([{ content: 'x', status: 'blocked' }]), undefined)
  assert.equal(todoPlanValue([{ content: 7, status: 'pending' }]), undefined)
  assert.equal(todoPlanValue([null]), undefined)

  assert.deepEqual(todoPlanValue([
    { content: 'write the test', status: 'in_progress' },
    { content: 'ship it', status: 'pending' },
  ]), {
    sessionUpdate: 'plan',
    entries: [
      { content: 'write the test', priority: 'medium', status: 'in_progress' },
      { content: 'ship it', priority: 'medium', status: 'pending' },
    ],
  })
  assert.deepEqual(todoPlanValue([]), { sessionUpdate: 'plan', entries: [] })
})

test('publishes live todo changes as wholesale plan updates', async () => {
  const harness = await makeBridgeHarness({ script: [textResponse('done'), textResponse('done')] })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    const registry = projectionRegistry(harness)
    await registry.register(todosUnit)
    await registry.register(counterUnit)
    const changedKeys: string[] = []
    registry.onChanged((_session, key) => { changedKeys.push(key) })

    await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'first task' }],
    })
    await waitFor(() => planUpdates(harness).length === 1)
    await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'clear todos' }],
    })
    await waitFor(() => planUpdates(harness).length === 2)

    // The unrelated key really did change; only `todos` reached the plan channel.
    assert.ok(changedKeys.includes('scratchCounter'))
    assert.deepEqual(planUpdates(harness), [
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'first task', priority: 'medium', status: 'in_progress' }],
      },
      { sessionUpdate: 'plan', entries: [] },
    ])
  } finally {
    await harness.dispose()
  }
})

test('publishes the current plan after session/load', async () => {
  const harness = await makeBridgeHarness({
    script: [textResponse('done')],
    config: { enableSessionLoad: true },
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    await projectionRegistry(harness).register(todosUnit)
    await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'restored task' }],
    })
    // Drain the live notification before the replay's update list is isolated.
    await waitFor(() => planUpdates(harness).length === 1)
    await harness.client.closeSession({ sessionId: created.sessionId })
    harness.updates.length = 0

    await harness.client.loadSession({ sessionId: created.sessionId, cwd: CWD, mcpServers: [] })

    assert.deepEqual(planUpdates(harness), [{
      sessionUpdate: 'plan',
      entries: [{ content: 'restored task', priority: 'medium', status: 'in_progress' }],
    }])
  } finally {
    await harness.dispose()
  }
})

test('publishes no plan while no todos projection is registered', async () => {
  const harness = await makeBridgeHarness({ config: { enableSessionLoad: true } })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    await harness.client.closeSession({ sessionId: created.sessionId })
    harness.updates.length = 0
    await harness.client.loadSession({ sessionId: created.sessionId, cwd: CWD, mcpServers: [] })
    assert.deepEqual(planUpdates(harness), [])
  } finally {
    await harness.dispose()
  }
})

test('stays silent when the deployment mounts no projection registry', async () => {
  // No registry service at all: both delivery points return without throwing.
  const ctx = new Context()
  try {
    const session = {} as Session
    assert.equal(sessionPlan(ctx, session), undefined)
    let published = 0
    subscribeTodoPlans(ctx, () => { published += 1 })
    assert.equal(published, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})
