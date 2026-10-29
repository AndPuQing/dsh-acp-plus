/**
 * `session/fork` (PLAN.md M8).
 *
 * A fork copies the source's latest completed-turn prefix into a fresh
 * session, leaves the source untouched, and yields a child that is itself
 * durable, listable, resumable, and promptable. Tests also pin the refusal
 * cases: no completed turn, subagent-produced sources, a mismatched cwd, and
 * deployments that did not opt in.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { forkPrefix } from '../src/features/fork.ts'
import { makeBridgeHarness, textResponse, waitFor, type BridgeHarness } from './harness.ts'

const CWD = process.cwd()

/** Concatenated committed assistant text as the client observed it. */
function messageText(harness: BridgeHarness): string {
  return harness.updates
    .filter(update => update.sessionUpdate === 'agent_message_chunk')
    .map(update => update.content.type === 'text' ? update.content.text : '')
    .join('')
}

test('forks a completed conversation into a durable, resumable child', async () => {
  const harness = await makeBridgeHarness({
    config: { enableSessionFork: true, enableSessionLoad: true },
    script: [textResponse('hi'), textResponse('child')],
  })
  try {
    const initialized = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    assert.deepEqual(initialized.agentCapabilities?.sessionCapabilities?.fork, {})

    const source = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    const first = await harness.client.prompt({
      sessionId: source.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    })
    assert.equal(first.stopReason, 'end_turn')
    assert.equal(messageText(harness), 'hi')

    const forked = await harness.client.forkSession({ sessionId: source.sessionId, cwd: CWD })
    assert.ok(forked.sessionId.length > 0)
    assert.notEqual(forked.sessionId, source.sessionId)
    assert.ok(Array.isArray(forked.configOptions))

    const child = harness.ctx.sessions.get(brandString<SessionId>(forked.sessionId))
    assert.ok(child !== undefined)
    assert.equal(child.header.isSeeded, true)
    assert.ok(child.inheritedEventCount > 0)
    const inherited = child.snapshotEvents()
    assert.ok(inherited.some(event => event.type === 'session/end-seed'))
    assert.match(JSON.stringify(inherited), /hello/)
    // The source keeps running independently of its child.
    const sourceSession = harness.ctx.sessions.get(brandString<SessionId>(source.sessionId))
    assert.equal(sourceSession?.header.isSeeded, false)

    const continued = await harness.client.prompt({
      sessionId: forked.sessionId,
      prompt: [{ type: 'text', text: 'continue' }],
    })
    assert.equal(continued.stopReason, 'end_turn')
    assert.equal(messageText(harness), 'hichild')

    // The seeded log is durable: the child reopens with both turns replayed.
    await harness.client.closeSession({ sessionId: forked.sessionId })
    harness.updates.length = 0
    await harness.client.loadSession({ sessionId: forked.sessionId, cwd: CWD, mcpServers: [] })
    assert.equal(messageText(harness), 'hichild')
  } finally {
    await harness.dispose()
  }
})

test('forks a live session mid-turn from its latest completed prefix', async () => {
  const harness = await makeBridgeHarness({
    config: { enableSessionFork: true },
    script: [textResponse('first'), 'hang'],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const source = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    await harness.client.prompt({
      sessionId: source.sessionId,
      prompt: [{ type: 'text', text: 'one' }],
    })

    const hanging = harness.client.prompt({
      sessionId: source.sessionId,
      prompt: [{ type: 'text', text: 'two' }],
    })
    // The second turn is streaming when the fork arrives.
    await waitFor(() => harness.adapter.requests.length === 2)

    const forked = await harness.client.forkSession({ sessionId: source.sessionId, cwd: CWD })
    const child = harness.ctx.sessions.get(brandString<SessionId>(forked.sessionId))
    assert.ok(child !== undefined)
    const inherited = JSON.stringify(child.snapshotEvents())
    assert.match(inherited, /first/)
    // The unfinished turn, including its admitted user message, stays out.
    assert.doesNotMatch(inherited, /two/)

    await harness.client.cancel({ sessionId: source.sessionId })
    assert.deepEqual(await hanging, { stopReason: 'cancelled' })
  } finally {
    await harness.dispose()
  }
})

test('refuses a source with no completed turn', async () => {
  const harness = await makeBridgeHarness({ config: { enableSessionFork: true } })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const source = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    await assert.rejects(
      harness.client.forkSession({ sessionId: source.sessionId, cwd: CWD }),
      /no completed turn to fork from/,
    )
  } finally {
    await harness.dispose()
  }
})

test('refuses a subagent-produced source and a mismatched cwd', async () => {
  const harness = await makeBridgeHarness({
    config: { enableSessionFork: true },
    script: [textResponse('hi')],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const source = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    await harness.client.prompt({
      sessionId: source.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    })

    await assert.rejects(
      harness.client.forkSession({ sessionId: source.sessionId, cwd: harness.persistenceRoot }),
      /cwd does not match/,
    )

    const subagentId = brandString<SessionId>(randomUUID())
    const subagent = await harness.ctx.agents.create({
      sessionId: subagentId,
      meta: { cwd: CWD, origin: 'subagent' },
    })
    await harness.ctx.sessions.flush(subagent.agent.session)
    await subagent.dispose()
    await assert.rejects(
      harness.client.forkSession({ sessionId: subagentId, cwd: CWD }),
      /not forkable/,
    )
  } finally {
    await harness.dispose()
  }
})

test('accepts a historical session that only carries parentSession lineage', async () => {
  const harness = await makeBridgeHarness({
    config: { enableSessionFork: true },
    script: [textResponse('hi')],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const source = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    await harness.client.prompt({
      sessionId: source.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    })

    // Reconstruct the shape a Web-UI fork leaves on disk: seeded history plus
    // parent lineage, but no `origin: 'subagent'`.
    const sourceSession = harness.ctx.sessions.get(brandString<SessionId>(source.sessionId))
    assert.ok(sourceSession !== undefined)
    const prefix = forkPrefix(sourceSession.snapshotEvents())
    assert.ok(prefix !== undefined)
    const historicalId = brandString<SessionId>(randomUUID())
    const historical = await harness.ctx.agents.create({
      sessionId: historicalId,
      seed: prefix.seed,
      inheritedEventCount: prefix.inheritedEventCount,
      meta: {
        cwd: CWD,
        isSeeded: true,
        parentSession: brandString<SessionId>(source.sessionId),
      },
    })
    await harness.ctx.sessions.flush(historical.agent.session)
    await historical.dispose()

    const forked = await harness.client.forkSession({ sessionId: historicalId, cwd: CWD })
    assert.ok(forked.sessionId.length > 0)
    assert.notEqual(forked.sessionId, historicalId)
  } finally {
    await harness.dispose()
  }
})

test('is neither advertised nor served unless the deployment enables it', async () => {
  const harness = await makeBridgeHarness()
  try {
    const initialized = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    assert.equal(initialized.agentCapabilities?.sessionCapabilities?.fork, undefined)
    const source = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    await assert.rejects(
      harness.client.forkSession({ sessionId: source.sessionId, cwd: CWD }),
      /not enabled/,
    )
  } finally {
    await harness.dispose()
  }
})
