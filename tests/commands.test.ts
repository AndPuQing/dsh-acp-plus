/**
 * Slash commands over ACP (PLAN.md M5): the published command list, prompt
 * interception into the command registry, and `commands/change` refreshes.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, textResponse, waitFor } from './harness.ts'

const CWD = process.cwd()

/** Wait until at least `count` command-list updates have reached the client. */
async function waitForCommandLists(
  harness: Awaited<ReturnType<typeof makeBridgeHarness>>,
  count: number,
): Promise<void> {
  await waitFor(() => harness.updates.filter(update =>
    update.sessionUpdate === 'available_commands_update').length >= count)
}

test('publishes the command list after the session response', async () => {
  const harness = await makeBridgeHarness({ commands: true })
  try {
    harness.ctx.commands.register({
      name: 'echo',
      description: 'Echo the input back.',
      handler: invocation => ({ kind: 'success', text: `echo:${invocation.rawInput}` }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.newSession({ cwd: CWD, mcpServers: [] })

    await waitForCommandLists(harness, 1)
    const list = harness.updates.find(update => update.sessionUpdate === 'available_commands_update')
    assert.deepEqual(list, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'echo', description: 'Echo the input back.' }],
    })
  } finally {
    await harness.dispose()
  }
})

test('runs a registered slash command without a model turn', async () => {
  const harness = await makeBridgeHarness({ commands: true })
  try {
    harness.ctx.commands.register({
      name: 'echo',
      description: 'Echo the input back.',
      handler: invocation => ({ kind: 'success', text: `echo:${invocation.rawInput}` }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/echo hello world' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.adapter.requests.length, 0)
    assert.ok(harness.updates.some(update =>
      update.sessionUpdate === 'user_message_chunk'
      && update.content.type === 'text' && update.content.text === '/echo hello world'))
    assert.ok(harness.updates.some(update =>
      update.sessionUpdate === 'agent_message_chunk'
      && update.content.type === 'text' && update.content.text === 'echo: hello world'))
  } finally {
    await harness.dispose()
  }
})

test('an unknown slash line stays an ordinary model prompt', async () => {
  const harness = await makeBridgeHarness({ commands: true, script: [textResponse('model answered')] })
  try {
    harness.ctx.commands.register({
      name: 'echo',
      description: 'Echo the input back.',
      handler: () => ({ kind: 'success', text: 'echoed' }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/etc/hosts looks wrong' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.adapter.requests.length, 1)
    assert.deepEqual(harness.adapter.requests[0]?.messages.at(-1)?.content, [
      { type: 'text', text: '/etc/hosts looks wrong' },
    ])
  } finally {
    await harness.dispose()
  }
})

test('republishes the command list when the registry changes', async () => {
  const harness = await makeBridgeHarness({ commands: true })
  try {
    harness.ctx.commands.register({
      name: 'first',
      description: 'First command.',
      handler: () => ({ kind: 'success' }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    await waitForCommandLists(harness, 1)

    harness.ctx.commands.register({
      name: 'second',
      description: 'Second command.',
      handler: () => ({ kind: 'success' }),
    })

    await waitFor(() => harness.updates.some(update =>
      update.sessionUpdate === 'available_commands_update'
      && update.availableCommands.some(command => command.name === 'second')))
  } finally {
    await harness.dispose()
  }
})
