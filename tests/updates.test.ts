/**
 * Committed event → `session/update` projection (PLAN.md M0).
 *
 * Behavior ported from `packages/acp/acp/tests/updates.spec.ts`: empty reasoning
 * stays off the wire, unlisted assistant blocks are dropped, usage needs both a
 * measurement and a declared capacity, and tool results reuse the content codec.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from '../src/updates.ts'

/** Minimal committed assistant event for pure update projection tests. */
function assistantEvent(
  content: SessionEvent<'assistant/message'>['data']['message']['content'],
  usage?: SessionEvent<'assistant/message'>['data']['usage'],
): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    seq: SessionSeq(0),
    time: 0,
    data: {
      stream: [],
      turn: 1,
      step: 1,
      message: {
        id: MessageId('message-1'),
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content,
      },
      ...usage === undefined ? {} : { usage },
    },
  }
}

const EMPTY_CTX = { get: () => undefined } as unknown as Context
const NO_CONTEXT = { requestContext: () => undefined } as unknown as Session

test('projects reasoning and output blocks in committed order', async () => {
  const event = assistantEvent([
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'hello' },
    { type: 'reasoning', text: '' },
  ])

  assert.deepEqual(await assistantUpdates(EMPTY_CTX, NO_CONTEXT, event), [
    { sessionUpdate: 'agent_thought_chunk', messageId: 'message-1', content: { type: 'text', text: 'thinking' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'hello' } },
  ])
})

test('omits empty reasoning, unsupported assistant blocks, and absent usage', async () => {
  const event = assistantEvent([
    { type: 'reasoning', text: '' },
    { type: 'tool-call', id: ToolCallId('call-hidden'), name: 'hidden', arguments: '{}' },
  ])

  assert.deepEqual(await assistantUpdates(EMPTY_CTX, NO_CONTEXT, event), [])
})

test('requires both measured usage and context capacity', async () => {
  let measured = 0
  const meter = { measure: () => { measured += 1; return { totalTokens: 7 } } }
  const withMeter = { get: (name: string) => name === 'tokenMeter' ? meter : undefined } as unknown as Context
  const withCapacity = { requestContext: () => ({ contextWindow: 100 }) } as unknown as Session
  const event = assistantEvent([{ type: 'text', text: 'done' }], { inputTokens: 1, outputTokens: 1 })

  assert.deepEqual(
    (await assistantUpdates(withMeter, NO_CONTEXT, event)).map(update => update.sessionUpdate),
    ['agent_message_chunk'],
  )
  assert.deepEqual(
    (await assistantUpdates(EMPTY_CTX, withCapacity, event)).map(update => update.sessionUpdate),
    ['agent_message_chunk'],
  )
  assert.equal(measured, 0)
  assert.deepEqual(await assistantUpdates(withMeter, withCapacity, event), [
    { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'done' } },
    { sessionUpdate: 'usage_update', used: 7, size: 100 },
  ])
})

test('preserves malformed tool input and projects a failed result without hidden content', async () => {
  const call = toolCallUpdate({
    type: 'tool/call',
    seq: SessionSeq(0),
    time: 0,
    data: { turn: 1, step: 1, callId: ToolCallId('call-bad'), name: 'broken', arguments: '{' },
  })
  const result = await toolResultUpdate(EMPTY_CTX, {
    type: 'tool/result',
    surfaceOp: 'append',
    seq: SessionSeq(0),
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('tool-message'),
        role: 'tool',
        toolCallId: ToolCallId('call-bad'),
        isError: true,
        source: { kind: 'tool', callId: ToolCallId('call-bad') },
        content: [{ type: 'reasoning', text: 'hidden' }],
      },
    },
  })

  assert.match(call.sessionUpdate, /^tool_call$/)
  assert.deepEqual(call, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-bad',
    title: 'broken',
    kind: 'other',
    status: 'in_progress',
    rawInput: '{',
  })
  assert.deepEqual(result, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-bad',
    status: 'failed',
    content: [],
  })
})
