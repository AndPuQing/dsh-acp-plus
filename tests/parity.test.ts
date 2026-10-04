/**
 * Native-parity lock (PLAN.md M1 tail).
 *
 * The same input must produce the same observable `session/update` sequence and
 * the same outcome through the native `@deepseek-ai/dsh-acp` bridge and this
 * repository's bridge. Random per-run message ids are normalized to positional
 * tokens; everything else is compared verbatim. If a wire-visible divergence is
 * intentional (an M2+ feature), it belongs in its own feature test, not here.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  errorResponse,
  makeBridgeHarness,
  maxTokensResponse,
  textResponse,
  waitFor,
  type BridgeHarness,
  type CapturedUpdate,
} from './harness.ts'

/** One bridge run's observable outcome. */
interface RunOutcome {
  stopReason?: string
  error?: { code: number; message: string }
  configOptions?: unknown
}

/** Scripted reasoning + echo tool call + usage, ending in a tool-calls stop. */
function reasoningToolCallScript(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'inspect first' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'inspect first' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: ToolCallId('call-1'), name: 'echo', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'echo', arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Replace random per-run message ids with stable positional tokens. */
function normalize(updates: readonly CapturedUpdate[]): unknown[] {
  const ids = new Map<string, string>()
  const token = (value: string): string => {
    const existing = ids.get(value)
    if (existing !== undefined) return existing
    const mapped = `message-${ids.size + 1}`
    ids.set(value, mapped)
    return mapped
  }
  return updates.map((update) => {
    if (update.sessionUpdate !== 'agent_message_chunk' && update.sessionUpdate !== 'agent_thought_chunk') {
      return update
    }
    const { messageId, ...rest } = update
    return { ...rest, messageId: messageId == null ? null : token(messageId) }
  })
}

/** Drive one bridge through a scenario and collect its normalized output. */
async function run(
  bridge: 'ext' | 'native',
  script: (StreamChunk[] | 'hang')[],
  drive: (harness: BridgeHarness) => Promise<RunOutcome>,
): Promise<{ updates: unknown[]; outcome: RunOutcome }> {
  const harness = await makeBridgeHarness({ bridge, script: [...script] })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const outcome = await drive(harness)
    return { updates: normalize(harness.updates), outcome }
  } finally {
    await harness.dispose()
  }
}

/** Run one identical scenario against both bridges and require equal output. */
async function compare(
  script: (StreamChunk[] | 'hang')[],
  drive: (harness: BridgeHarness) => Promise<RunOutcome>,
): Promise<void> {
  const extended = await run('ext', script, drive)
  const native = await run('native', script, drive)
  assert.deepEqual(extended, native)
}

test('advertises the same standard capabilities as the native bridge', async () => {
  const extended = await makeBridgeHarness({ bridge: 'ext' })
  const native = await makeBridgeHarness({ bridge: 'native' })
  try {
    const [ours, theirs] = await Promise.all([
      extended.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      native.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
    ])
    assert.equal(ours.protocolVersion, theirs.protocolVersion)
    assert.deepEqual(ours.agentCapabilities, theirs.agentCapabilities)
    assert.deepEqual(ours.authMethods, theirs.authMethods)
  } finally {
    await extended.dispose()
    await native.dispose()
  }
})

test('text exchange matches update for update and settles identically', async () => {
  await compare([textResponse('hello there')], async (harness) => {
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'say hello' }],
    })
    return { stopReason: result.stopReason, configOptions: created.configOptions }
  })
})

test('output-token ceiling maps to the same stop reason', async () => {
  await compare([maxTokensResponse('cut short')], async (harness) => {
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'keep going' }],
    })
    return { stopReason: result.stopReason }
  })
})

test('reasoning, tool lifecycle, usage, and final text match in order', async () => {
  await compare([reasoningToolCallScript(), textResponse('done')], async (harness) => {
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Return a deterministic result.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'tool result' }]),
    }))
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    })
    return { stopReason: result.stopReason }
  })
})

test('cancel mid-stream settles the same committed prefix and stop reason', async () => {
  await compare(['hang'], async (harness) => {
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hang' }],
    })
    await waitFor(() => harness.ctx.agents.get(brandString<SessionId>(created.sessionId))?.status === 'running')
    await harness.client.cancel({ sessionId: created.sessionId })
    const result = await prompt
    return { stopReason: result.stopReason }
  })
})

test('a provider failure surfaces the same committed prefix and error', async () => {
  await compare([errorResponse('provider blew up')], async (harness) => {
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    try {
      const result = await harness.client.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'boom' }],
      })
      return { stopReason: result.stopReason }
    } catch (error: unknown) {
      const candidate = error as { code?: unknown; message?: unknown }
      return { error: { code: Number(candidate.code), message: String(candidate.message) } }
    }
  })
})
