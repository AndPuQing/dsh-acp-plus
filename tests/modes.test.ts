/**
 * Session modes over ACP (PLAN.md M5): the plan-mode pair, set_mode, and the
 * `current_mode_update` notification, including persistence across resume and
 * the single-mode wire when plan mode is not mounted.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_MODE_ID, PLAN_MODE_ID } from '../src/features/modes.ts'
import { makeBridgeHarness, waitFor } from './harness.ts'

const CWD = process.cwd()

test('advertises default and plan modes and follows set_mode', async () => {
  const harness = await makeBridgeHarness({ planMode: true })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })

    assert.deepEqual(created.modes, {
      currentModeId: DEFAULT_MODE_ID,
      availableModes: [
        { id: DEFAULT_MODE_ID, name: 'Default', description: 'Carry out the task directly.' },
        { id: PLAN_MODE_ID, name: 'Plan', description: 'Research and present a plan before making changes.' },
      ],
    })

    await harness.client.setSessionMode({ sessionId: created.sessionId, modeId: PLAN_MODE_ID })
    await waitFor(() => harness.updates.some(update =>
      update.sessionUpdate === 'current_mode_update' && update.currentModeId === PLAN_MODE_ID))

    await harness.client.setSessionMode({ sessionId: created.sessionId, modeId: DEFAULT_MODE_ID })
    await waitFor(() => harness.updates.some(update =>
      update.sessionUpdate === 'current_mode_update' && update.currentModeId === DEFAULT_MODE_ID))

    await assert.rejects(Promise.resolve(harness.client.setSessionMode({
      sessionId: created.sessionId,
      modeId: 'turbo',
    })), /unknown session mode/)
  } finally {
    await harness.dispose()
  }
})

test('restores the persisted mode when a session resumes', async () => {
  const harness = await makeBridgeHarness({ planMode: true })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    await harness.client.setSessionMode({ sessionId: created.sessionId, modeId: PLAN_MODE_ID })
    await harness.client.closeSession({ sessionId: created.sessionId })

    const resumed = await harness.client.resumeSession({ sessionId: created.sessionId, cwd: CWD, mcpServers: [] })

    assert.equal(resumed.modes?.currentModeId, PLAN_MODE_ID)
  } finally {
    await harness.dispose()
  }
})

test('offers only the default mode when plan mode is not mounted', async () => {
  const harness = await makeBridgeHarness()
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })

    assert.equal(created.modes, undefined)
    await assert.rejects(Promise.resolve(harness.client.setSessionMode({
      sessionId: created.sessionId,
      modeId: PLAN_MODE_ID,
    })), /unknown session mode/)
  } finally {
    await harness.dispose()
  }
})

test('mode switching never touches the sandbox axis', async () => {
  const harness = await makeBridgeHarness({ planMode: true, sandboxMode: 'workspace-write' })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    const session = harness.ctx.sessions.get(brandString<SessionId>(created.sessionId))
    if (session === undefined) throw new Error('the created session is not live')
    assert.equal(harness.ctx.sandboxPolicy.resolve({ session }).mode, 'workspace-write')

    await harness.client.setSessionMode({ sessionId: created.sessionId, modeId: PLAN_MODE_ID })

    assert.equal(harness.ctx.sandboxPolicy.resolve({ session }).mode, 'workspace-write')
  } finally {
    await harness.dispose()
  }
})
