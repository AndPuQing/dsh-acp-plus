/**
 * `additionalDirectories` trust model (PLAN.md M3).
 *
 * Two layers are covered: pure authorization/containment, and the bridge
 * behavior — capability advertisement, acceptance, and the reuse of the
 * harness's existing one-shot escalation: a verified write inside a declared
 * root is pre-approved, everything else still asks the client.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  AcpPlusAdditionalDirectoriesError,
  authorizeAdditionalDirectories,
  MAX_ADDITIONAL_DIRECTORIES,
  preApprovedEscalation,
} from '../src/features/additional-directories.ts'
import { makeBridgeHarness, textResponse, toolCallResponse } from './harness.ts'

const CWD = process.cwd()

/** Create one scratch root containing a named directory. */
async function scratch(): Promise<{ root: string; make: (name: string) => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-plus-dirs-'))
  return {
    root,
    make: async (name) => {
      const path = join(root, name)
      await mkdir(path, { recursive: true })
      return path
    },
  }
}

/** Context stub whose fs resolves physically and whose policy reports `mode`. */
function escalationCtx(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Context {
  return {
    get(name: string) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) }
      if (name === 'fs') return {
        resolve: async (path: string) => ({ targetKey: await realpath(path).catch(() => resolve(path)) }),
      }
      return undefined
    },
  } as unknown as Context
}

const SESSION = { header: { cwd: CWD } } as unknown as Session

test('authorizes canonical directories, dropping the workspace and duplicates', async () => {
  const { root, make } = await scratch()
  try {
    const first = await make('first')
    const second = await make('second')
    const link = join(root, 'first-link')
    await symlink(first, link)

    const resolved = await authorizeAdditionalDirectories(CWD, [first, link, first, second, CWD])
    assert.deepEqual(resolved, [await realpath(first), await realpath(second)])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects unusable entries and an oversized grant', async () => {
  const { root, make } = await scratch()
  try {
    const dir = await make('dir')
    const file = join(root, 'file.txt')
    await writeFile(file, 'x')

    await assert.rejects(
      authorizeAdditionalDirectories(CWD, ['relative/dir']),
      (error: unknown) => error instanceof AcpPlusAdditionalDirectoriesError && /must be absolute/.test(error.message),
    )
    await assert.rejects(authorizeAdditionalDirectories(CWD, [join(root, 'missing')]), /not an existing directory/)
    await assert.rejects(authorizeAdditionalDirectories(CWD, [file]), /not an existing directory/)
    await assert.rejects(
      authorizeAdditionalDirectories(CWD, Array.from({ length: MAX_ADDITIONAL_DIRECTORIES + 1 }, () => dir)),
      /at most 16 entries/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-approves only verified single-target writes inside a declared root', async () => {
  const { root, make } = await scratch()
  try {
    const inside = await make('inside')
    const outside = await make('outside')
    const roots = [await realpath(inside)]
    const target = join(inside, 'nested', 'file.txt')

    assert.equal(await preApprovedEscalation(escalationCtx('workspace-write'), SESSION, roots, 'write', target), true)
    assert.equal(await preApprovedEscalation(escalationCtx('workspace-write'), SESSION, roots, 'edit', target), true)
    assert.equal(await preApprovedEscalation(escalationCtx('workspace-write'), SESSION, roots, 'write', join(outside, 'x.txt')), false)
    assert.equal(await preApprovedEscalation(escalationCtx('read-only'), SESSION, roots, 'write', target), false)
    assert.equal(await preApprovedEscalation(escalationCtx('workspace-write'), SESSION, roots, 'bash', `cat ${target}`), false)
    assert.equal(await preApprovedEscalation(escalationCtx('workspace-write'), SESSION, roots, 'write', undefined), false)
    assert.equal(await preApprovedEscalation(escalationCtx('workspace-write'), SESSION, [], 'write', target), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects additionalDirectories unless the deployment enables them', async () => {
  const { root, make } = await scratch()
  const harness = await makeBridgeHarness()
  try {
    const dir = await make('extra')
    const response = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    assert.equal(response.agentCapabilities?.sessionCapabilities?.additionalDirectories, undefined)

    await assert.rejects(Promise.resolve(harness.client.newSession({
      cwd: CWD,
      mcpServers: [],
      additionalDirectories: [dir],
    })), /not supported/)
  } finally {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('advertises and accepts authorized roots under the standing sandbox', async () => {
  const { root, make } = await scratch()
  const harness = await makeBridgeHarness({
    sandboxMode: 'workspace-write',
    config: { enableAdditionalDirectories: true },
  })
  try {
    const dir = await make('extra')
    const response = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.additionalDirectories, {})

    const created = await harness.client.newSession({
      cwd: CWD,
      mcpServers: [],
      additionalDirectories: [dir],
    })
    assert.ok(created.sessionId.length > 0)
  } finally {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('resume and load re-validate declared roots', async () => {
  const { root, make } = await scratch()
  const harness = await makeBridgeHarness({
    sandboxMode: 'workspace-write',
    config: { enableAdditionalDirectories: true, enableSessionLoad: true },
  })
  try {
    const dir = await make('extra')
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    await harness.client.closeSession({ sessionId: created.sessionId })

    await assert.rejects(Promise.resolve(harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: CWD,
      mcpServers: [],
      additionalDirectories: ['relative'],
    })), /must be absolute/)
    await assert.rejects(Promise.resolve(harness.client.loadSession({
      sessionId: created.sessionId,
      cwd: CWD,
      mcpServers: [],
      additionalDirectories: [join(root, 'missing')],
    })), /not an existing directory/)

    const resumed = await harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: CWD,
      mcpServers: [],
      additionalDirectories: [dir],
    })
    assert.ok(Array.isArray(resumed.configOptions))
    await harness.client.closeSession({ sessionId: created.sessionId })
    const loaded = await harness.client.loadSession({
      sessionId: created.sessionId,
      cwd: CWD,
      mcpServers: [],
      additionalDirectories: [dir],
    })
    assert.ok(Array.isArray(loaded.configOptions))
  } finally {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-approves a verified write inside a declared root without asking the client', async () => {
  const { root, make } = await scratch()
  const extra = await make('extra')
  const harness = await makeBridgeHarness({
    sandboxMode: 'workspace-write',
    filesystemTools: true,
    config: { enableAdditionalDirectories: true },
    script: [
      toolCallResponse('write', 'call-inside', {
        file_path: join(extra, 'agent.txt'),
        content: 'written under the declared root',
        sandbox_permissions: 'danger-full-access',
        justification: 'The client pre-authorized this directory for the session.',
      }),
      textResponse('done'),
    ],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({
      cwd: CWD,
      mcpServers: [],
      additionalDirectories: [extra],
    })

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'write a file' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(await readFile(join(extra, 'agent.txt'), 'utf8'), 'written under the declared root')
    assert.equal(harness.permissionRequests.length, 0)
    assert.ok(harness.updates.some(update =>
      update.sessionUpdate === 'tool_call_update' && update.status === 'completed'))
  } finally {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('still asks the client for a write outside the declared roots', async () => {
  const { root, make } = await scratch()
  const extra = await make('extra')
  const outside = await make('outside')
  const harness = await makeBridgeHarness({
    sandboxMode: 'workspace-write',
    filesystemTools: true,
    config: { enableAdditionalDirectories: true },
    script: [
      toolCallResponse('write', 'call-outside', {
        file_path: join(outside, 'nope.txt'),
        content: 'not allowed',
        sandbox_permissions: 'danger-full-access',
        justification: 'Try to escape the declared roots.',
      }),
      textResponse('not written'),
    ],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({
      cwd: CWD,
      mcpServers: [],
      additionalDirectories: [extra],
    })

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'write outside' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.permissionRequests.length, 1)
    await assert.rejects(readFile(join(outside, 'nope.txt'), 'utf8'), /ENOENT/)
  } finally {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps a read-only session a human decision even inside a declared root', async () => {
  const { root, make } = await scratch()
  const extra = await make('extra')
  const harness = await makeBridgeHarness({
    sandboxMode: 'read-only',
    filesystemTools: true,
    config: { enableAdditionalDirectories: true },
    script: [
      toolCallResponse('write', 'call-readonly', {
        file_path: join(extra, 'agent.txt'),
        content: 'read-only refuses',
        sandbox_permissions: 'danger-full-access',
        justification: 'Requested even though the session is read-only.',
      }),
      textResponse('not written'),
    ],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({
      cwd: CWD,
      mcpServers: [],
      additionalDirectories: [extra],
    })

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'write anyway' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.permissionRequests.length, 1)
    await assert.rejects(readFile(join(extra, 'agent.txt'), 'utf8'), /ENOENT/)
  } finally {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
