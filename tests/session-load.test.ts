/**
 * Session lifecycle: `session/load` replay and `session/resume` (PLAN.md M2).
 *
 * The acceptance shape is a process restart: one harness runs a prompt and
 * disposes (the writer releases its lease), a second harness mounts the same
 * persistence root and loads the id. Replay must reproduce the committed
 * transcript in order, and the loaded session must accept a new prompt with its
 * history intact.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PROTOCOL_VERSION, type SessionUpdate } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { replaySession } from '../src/features/session-load.ts'
import { makeBridgeHarness, textResponse } from './harness.ts'

/** Flatten a request's message contents for a substring search. */
function messageTexts(messages: readonly { content: unknown }[]): string {
  return JSON.stringify(messages.map(message => message.content))
}

test('replays a persisted transcript and continues it after a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-plus-load-'))
  try {
    // Process A: run one exchange, then release the persistence lease.
    const first = await makeBridgeHarness({ script: [textResponse('first answer')], persistenceRoot: root })
    await first.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await first.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await first.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'first prompt' }],
    })
    const liveUpdates = [...first.updates]
    assert.ok(liveUpdates.length > 0)
    await first.dispose()

    // Process B: same root, session/load must reproduce the transcript and
    // then accept a new turn with the restored history.
    const second = await makeBridgeHarness({
      script: [textResponse('second answer')],
      persistenceRoot: root,
      config: { enableSessionLoad: true },
    })
    await second.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const loaded = await second.client.loadSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })

    assert.ok(Array.isArray(loaded.configOptions))
    // Replay restores the user's prompt too, which the live path never echoes
    // back; the assistant transcript around it must match byte for byte.
    const replayedUsers = second.updates.filter(update => update.sessionUpdate === 'user_message_chunk')
    assert.deepEqual(replayedUsers.map(update => update.content), [{ type: 'text', text: 'first prompt' }])
    assert.deepEqual(
      second.updates.filter(update => update.sessionUpdate !== 'user_message_chunk'),
      liveUpdates,
    )

    const continued = await second.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'second prompt' }],
    })
    assert.equal(continued.stopReason, 'end_turn')
    assert.match(messageTexts(second.adapter.requests.at(-1)?.messages ?? []), /first prompt/)
    assert.match(messageTexts(second.adapter.requests.at(-1)?.messages ?? []), /first answer/)
    assert.match(messageTexts(second.adapter.requests.at(-1)?.messages ?? []), /second prompt/)
    await second.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Fabricate one user-message event with its required surface intent. */
function userEvent(
  seq: number,
  text: string,
  surfaceOp: SessionEvent['surfaceOp'],
): { event: SessionEvent; message: UserMessage } {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  return {
    message,
    event: {
      type: 'user/message',
      seq: SessionSeq(seq),
      time: seq,
      data: message,
      surfaceOp,
      ...typeof surfaceOp === 'object' ? { sourceEventSeqs: [SessionSeq(0), SessionSeq(1)] } : {},
    } as unknown as SessionEvent,
  }
}

/** Replay a fabricated event log through a persistence stub. */
async function replayEvents(events: readonly SessionEvent[]): Promise<SessionUpdate[]> {
  const ctx = {
    sessionPersistence: {
      open: () => Promise.resolve({
        read: () => Promise.resolve({ events }),
        close: () => Promise.resolve(),
      }),
    },
    get: () => undefined,
  } as unknown as Context
  const updates: SessionUpdate[] = []
  await replaySession(ctx, brandString<SessionId>('session-replay'), ({ update }) => {
    updates.push(update)
    return Promise.resolve()
  })
  return updates
}

test('replays user messages in order and skips surface nodes a replacement hid', async () => {
  const first = userEvent(0, 'first prompt', 'append')
  const second = userEvent(1, 'second prompt', 'append')
  const summary = userEvent(2, 'condensed prompt', { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(1) })

  assert.deepEqual(await replayEvents([first.event, second.event]), [
    { sessionUpdate: 'user_message_chunk', messageId: first.message.id, content: { type: 'text', text: 'first prompt' } },
    { sessionUpdate: 'user_message_chunk', messageId: second.message.id, content: { type: 'text', text: 'second prompt' } },
  ])
  assert.deepEqual(await replayEvents([first.event, second.event, summary.event]), [
    { sessionUpdate: 'user_message_chunk', messageId: summary.message.id, content: { type: 'text', text: 'condensed prompt' } },
  ])
})

test('does not advertise or serve session/load unless enabled', async () => {
  const harness = await makeBridgeHarness()
  try {
    const response = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    assert.equal(response.agentCapabilities?.loadSession, undefined)

    await assert.rejects(Promise.resolve(harness.client.loadSession({
      sessionId: 'missing-session',
      cwd: process.cwd(),
      mcpServers: [],
    })), /not enabled/)
  } finally {
    await harness.dispose()
  }
})

test('advertises session/load when enabled and rejects unusable ids', async () => {
  const harness = await makeBridgeHarness({ config: { enableSessionLoad: true } })
  try {
    const response = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    assert.equal(response.agentCapabilities?.loadSession, true)

    await assert.rejects(Promise.resolve(harness.client.loadSession({
      sessionId: 'missing-session',
      cwd: process.cwd(),
      mcpServers: [],
    })), /not loadable/)

    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await assert.rejects(Promise.resolve(harness.client.loadSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })), /already active/)
  } finally {
    await harness.dispose()
  }
})

test('refuses to load another process while it still owns the session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-plus-load-'))
  try {
    const first = await makeBridgeHarness({ persistenceRoot: root })
    await first.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await first.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    // The id is not live in this process, so the reservation guard passes;
    // storage must refuse the stolen write lease.
    const second = await makeBridgeHarness({
      persistenceRoot: root,
      config: { enableSessionLoad: true },
    })
    await second.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await assert.rejects(Promise.resolve(second.client.loadSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })))

    await second.dispose()
    await first.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resumes a closed persisted session without replaying its history', async () => {
  const harness = await makeBridgeHarness({
    script: [textResponse('first answer'), textResponse('second answer')],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'first prompt' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })
    const updatesBeforeResume = harness.updates.length

    const resumed = await harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })

    assert.ok(Array.isArray(resumed.configOptions))
    assert.equal(harness.updates.length, updatesBeforeResume)
    const continued = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'second prompt' }],
    })
    assert.equal(continued.stopReason, 'end_turn')
    assert.match(messageTexts(harness.adapter.requests.at(-1)?.messages ?? []), /first prompt/)
    assert.match(messageTexts(harness.adapter.requests.at(-1)?.messages ?? []), /second prompt/)
  } finally {
    await harness.dispose()
  }
})

test('load rejects a cwd that does not match the persisted workspace', async () => {
  const harness = await makeBridgeHarness({ config: { enableSessionLoad: true } })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.closeSession({ sessionId: created.sessionId })

    await assert.rejects(Promise.resolve(harness.client.loadSession({
      sessionId: created.sessionId,
      cwd: '/',
      mcpServers: [],
    })), /cwd does not match/)
  } finally {
    await harness.dispose()
  }
})
