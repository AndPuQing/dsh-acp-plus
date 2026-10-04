/**
 * Deployment default-model fallback (PLAN.md M6 / D10).
 *
 * The bridge config's `provider`/`model` are optional. When absent, the live
 * `agent-default-model` service — the same default the Web Models page writes
 * — supplies the route, so a profile configures its model once and every
 * entry point follows. An explicit config route still wins.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, textResponse } from './harness.ts'

test('falls back to the deployment default model when config names no route', async () => {
  const harness = await makeBridgeHarness({
    defaultModel: { provider: 'mock', model: 'mock' },
    script: [textResponse('from the default model')],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const model = created.configOptions?.find(option => option.id === 'model')
    assert.equal(model?.currentValue, JSON.stringify(['mock', 'mock']))

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    })
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.adapter.requests[0]?.provider, 'mock')
    assert.equal(harness.adapter.requests[0]?.model, 'mock')
  } finally {
    await harness.dispose()
  }
})

test('advertises image prompts from a capable default route', async () => {
  const harness = await makeBridgeHarness({
    defaultModel: { provider: 'mock', model: 'mock' },
    imageCapable: true,
  })
  try {
    const response = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    assert.equal(response.agentCapabilities?.promptCapabilities?.image, true)
  } finally {
    await harness.dispose()
  }
})

test('an explicit config route wins over the deployment default', async () => {
  const harness = await makeBridgeHarness({
    defaultModel: { provider: 'unlisted', model: 'unlisted' },
    config: { provider: 'mock', model: 'mock' },
    script: [textResponse('explicit route')],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.adapter.requests[0]?.provider, 'mock')
    assert.equal(harness.adapter.requests[0]?.model, 'mock')
  } finally {
    await harness.dispose()
  }
})
