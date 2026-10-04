/**
 * `_session/steering` extension acceptance (PLAN.md M7 / D11).
 *
 * The extension is defined by the agentclientprotocol org adapters and spoken
 * by zeron's ACP driver: a live turn consumes text at its next step boundary,
 * while an idle session hands it back for normal prompt admission.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, waitFor } from './harness.ts'

test('advertises the steering extension in initialize metadata', async () => {
  const harness = await makeBridgeHarness()
  try {
    const response = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    assert.deepEqual(response._meta, { steering: { supported: true } })
  } finally {
    await harness.dispose()
  }
})

test('hands a steer back when no turn is running', async () => {
  const harness = await makeBridgeHarness()
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const response = await harness.client.steer({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'steer me' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    })

    assert.deepEqual(response, { outcome: 'promptRequired', reason: 'noRunningTurn' })
    // Handing the steer back must not start an untracked turn.
    assert.equal(harness.adapter.requests.length, 0)
  } finally {
    await harness.dispose()
  }
})

test('injects a steer into a live turn at its next step', async () => {
  const harness = await makeBridgeHarness({ script: ['hang'] })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const sessionId = brandString<SessionId>(created.sessionId)
    const prompt = harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'start' }],
    })
    await waitFor(() => harness.ctx.agents.get(sessionId)?.status === 'running')

    const response = await harness.client.steer({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'injected steer' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    })
    assert.deepEqual(response, { outcome: 'injected' })

    // The steer is durable core work, not just a wire acknowledgement.
    const session = harness.ctx.sessions.get(sessionId)
    const spliced = session?.snapshotEvents().find(event =>
      event.type === 'agent/inbox/spliced'
      && event.data.target === 'next-step'
      && event.data.inserted.some(message => message.content.some(block =>
        block.type === 'text' && block.text === 'injected steer')))
    assert.ok(spliced, 'the steer message must be durable in the agent inbox')

    await harness.client.cancel({ sessionId: created.sessionId })
    assert.deepEqual(await prompt, { stopReason: 'cancelled' })
  } finally {
    await harness.dispose()
  }
})

test('rejects a steer for an unknown session', async () => {
  const harness = await makeBridgeHarness()
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await assert.rejects(harness.client.steer({
      sessionId: 'missing',
      prompt: [{ type: 'text', text: 'steer' }],
    }), /unknown session/)
  } finally {
    await harness.dispose()
  }
})
