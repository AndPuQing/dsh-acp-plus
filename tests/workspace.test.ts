/**
 * Workspace attachment (grouping): every ACP session joins the Workspace that
 * owns its cwd, so dsh's workspace-grouped surfaces (the Web sidebar) list it
 * under the project instead of the "ungrouped" bucket.
 */

import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness } from './harness.ts'

test('attaches a new session to the workspace owning its cwd', async () => {
  const harness = await makeBridgeHarness({ workspaces: true })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const registry = harness.ctx.get('workspaceRegistry')
    assert.ok(registry !== undefined, 'workspace registry is mounted')
    const workspace = registry.list().find(entry => entry.sessionIds.some(id => id === sessionId))
    assert.ok(workspace !== undefined, 'the session joined a workspace')
    assert.equal(workspace.title, basename(process.cwd()))
  } finally {
    await harness.dispose()
  }
})

test('creates a session when the deployment has no workspace registry', async () => {
  const harness = await makeBridgeHarness()
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    assert.equal(typeof sessionId, 'string')
  } finally {
    await harness.dispose()
  }
})
