/**
 * Extended ACP bridge acceptance over in-memory streams (PLAN.md M0).
 *
 * Keyless: the shared harness drives the official SDK `ClientSideConnection`
 * against the real Agent loop and a temp-directory JSONL log.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, waitFor } from './harness.ts'

test('advertises the standard automation controls and exact bridge identity', async () => {
  const harness = await makeBridgeHarness()
  try {
    const response = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })

    assert.equal(response.protocolVersion, PROTOCOL_VERSION)
    assert.deepEqual(response.agentInfo, { name: 'dsh-acp-plus', version: '0.1.0' })
    assert.deepEqual(response.agentCapabilities, {
      mcpCapabilities: { http: true },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    })
    assert.deepEqual(response.authMethods, [])
  } finally {
    await harness.dispose()
  }
})

test('advertises image prompts only for a capable route and mounted store', async () => {
  const capable = await makeBridgeHarness({ imageCapable: true })
  try {
    const response = await capable.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    assert.equal(response.agentCapabilities?.promptCapabilities?.image, true)
  } finally {
    await capable.dispose()
  }

  const noStore = await makeBridgeHarness({ imageCapable: true, attachments: false })
  try {
    const response = await noStore.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    assert.equal(response.agentCapabilities?.promptCapabilities?.image, false)
  } finally {
    await noStore.dispose()
  }
})

test('creates a session, emits committed output, and settles the prompt', async () => {
  const harness = await makeBridgeHarness({ script: [textResponse('hello there')] })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId, configOptions } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    assert.ok(Array.isArray(configOptions))
    assert.equal(configOptions?.find(option => option.id === 'model')?.currentValue, '["mock","mock"]')

    const result = await harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'say hello' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    const message = harness.updates.find(update => update.sessionUpdate === 'agent_message_chunk')
    assert.equal(message?.sessionUpdate, 'agent_message_chunk')
    assert.deepEqual((message as { content: unknown }).content, { type: 'text', text: 'hello there' })
    assert.equal(typeof (message as { messageId?: unknown }).messageId, 'string')
    assert.ok(harness.updates.some(update => update.sessionUpdate === 'usage_update'))
    assert.deepEqual(harness.adapter.requests[0]?.messages.at(-1)?.content, [{ type: 'text', text: 'say hello' }])
  } finally {
    await harness.dispose()
  }
})

test('cancels a running prompt and reports the wire stop reason', async () => {
  const harness = await makeBridgeHarness({ script: ['hang'] })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hang' }],
    })
    await waitFor(() => harness.ctx.agents.get(brandString<SessionId>(created.sessionId))?.status === 'running')

    await harness.client.cancel({ sessionId: created.sessionId })

    assert.deepEqual(await prompt, { stopReason: 'cancelled' })
  } finally {
    await harness.dispose()
  }
})

test('rejects rich prompt content this connection did not advertise', async () => {
  const harness = await makeBridgeHarness()
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await assert.rejects(Promise.resolve(harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })), /not advertised/)
    await assert.rejects(Promise.resolve(harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'audio', data: 'AQ==', mimeType: 'audio/wav' }],
    })), /audio prompt/)
    await assert.rejects(Promise.resolve(harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '   ' }],
    })), /empty prompt/)
  } finally {
    await harness.dispose()
  }
})

test('closes one session without affecting its neighbor', async () => {
  const harness = await makeBridgeHarness()
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const first = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const second = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.client.closeSession({ sessionId: first.sessionId })

    assert.equal(harness.ctx.agents.get(brandString<SessionId>(first.sessionId)), undefined)
    assert.notEqual(harness.ctx.agents.get(brandString<SessionId>(second.sessionId)), undefined)
    await assert.rejects(Promise.resolve(harness.client.prompt({
      sessionId: first.sessionId,
      prompt: [{ type: 'text', text: 'closed' }],
    })), /unknown session/)
  } finally {
    await harness.dispose()
  }
})

test('lists persisted sessions through an opaque keyset cursor', async () => {
  const harness = await makeBridgeHarness({ config: { sessionListPageSize: 1 } })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const first = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.closeSession({ sessionId: first.sessionId })
    const second = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.closeSession({ sessionId: second.sessionId })

    const pageOne = await harness.client.listSessions({})
    assert.equal(pageOne.sessions.length, 1)
    assert.ok(typeof pageOne.nextCursor === 'string' && pageOne.nextCursor.length > 0)
    const pageTwo = await harness.client.listSessions({ cursor: pageOne.nextCursor ?? '' })

    const listed = [...pageOne.sessions, ...pageTwo.sessions].map(session => session.sessionId).sort()
    assert.deepEqual(listed, [first.sessionId, second.sessionId].sort())
    assert.equal(pageTwo.nextCursor, undefined)

    await assert.rejects(Promise.resolve(harness.client.listSessions({ cursor: 'not a cursor!' })), /cursor is invalid/)
  } finally {
    await harness.dispose()
  }
})
