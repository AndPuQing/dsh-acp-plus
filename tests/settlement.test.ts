/**
 * Prompt settlement over whole-Agent quiescence (PLAN.md M1 tail, dsh 0.2.2).
 *
 * Ported from the native bridge's `turns.spec.ts` and `dispose.spec.ts`: one
 * ACP prompt spans every turn its message starts, including turns woken by a
 * finishing subagent, and teardown releases descendants before the Agent that
 * hosts their runtime.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

/** Concatenated committed assistant text as the client observed it. */
function messageText(harness: BridgeHarness): string {
  return harness.updates
    .filter(update => update.sessionUpdate === 'agent_message_chunk')
    .map(update => update.content.type === 'text' ? update.content.text : '')
    .join('')
}

test('waits for descendants and reports the later summary turn', async () => {
  const harness = await makeBridgeHarness({ script: [textResponse('waiting'), textResponse('summary')] })
  try {
    const waiting = Promise.withResolvers<void>()
    const children = Promise.withResolvers<boolean>()
    let calls = 0
    harness.ctx.provide('subagents', {
      waitForChildren: () => {
        calls += 1
        if (calls > 1) return Promise.resolve(false)
        waiting.resolve()
        return children.promise
      },
      drainDescendants: () => Promise.resolve(),
    } as never)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(brandString<SessionId>(created.sessionId))

    let settled = false
    const prompt = harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'delegate' }],
    }).finally(() => { settled = true })
    await waiting.promise
    // The first turn ended; the prompt must stay open until the child reports.
    assert.equal(settled, false)
    agent?.followup(createUserMessage({
      content: [{ type: 'text', text: 'child result' }],
      source: { kind: 'user' },
    }))
    children.resolve(true)

    await assert.doesNotReject(prompt)
    assert.equal(settled, true)
    assert.equal(messageText(harness), 'waitingsummary')
  } finally {
    await harness.dispose()
  }
})

test('cancels the child wait without closing the session to its next prompt', async () => {
  const harness = await makeBridgeHarness({ script: [textResponse('waiting'), textResponse('next')] })
  try {
    const waiting = Promise.withResolvers<void>()
    const children = Promise.withResolvers<boolean>()
    let calls = 0
    let drains = 0
    harness.ctx.provide('subagents', {
      waitForChildren: () => {
        calls += 1
        if (calls > 1) return Promise.resolve(false)
        waiting.resolve()
        return children.promise
      },
      drainDescendants: () => { drains += 1; return Promise.resolve() },
    } as never)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const first = harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'delegate' }],
    })
    await waiting.promise
    await harness.client.cancel({ sessionId: created.sessionId })
    assert.deepEqual(await first, { stopReason: 'cancelled' })
    assert.equal(drains, 0)

    children.resolve(true)
    const second = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'again' }],
    })
    assert.equal(second.stopReason, 'end_turn')
    assert.equal(messageText(harness), 'waitingnext')
  } finally {
    await harness.dispose()
  }
})

test('drains continuable subagents before disposing its own sessions', async () => {
  const harness = await makeBridgeHarness()
  const order: string[] = []
  let drainedParents: readonly Agent[] = []
  harness.ctx.provide('subagents', {
    waitForChildren: () => Promise.resolve(false),
    drainDescendants: (parents: readonly Agent[]) => {
      drainedParents = parents
      order.push('drained')
      return Promise.resolve()
    },
  } as never)
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(brandString<SessionId>(created.sessionId))
    harness.ctx.on('agent/disposed', () => { order.push('agent disposed') })

    // Disposing the bridge fiber runs its teardown; the root context would tear
    // down the services this ordering depends on first.
    await harness.bridgeFiber.dispose()

    assert.deepEqual(order, ['drained', 'agent disposed'])
    assert.deepEqual(drainedParents, [agent])
    assert.equal(harness.ctx.agents.get(brandString<SessionId>(created.sessionId)), undefined)
  } finally {
    await harness.dispose()
  }
})
