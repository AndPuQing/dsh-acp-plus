#!/usr/bin/env node
/**
 * End-to-end smoke client for the `acp-plus` profile.
 *
 * Spawns the installed dsh with `--profile acp-plus` and drives the official
 * SDK ClientSideConnection over its stdio:
 *   initialize -> session/new -> session/list -> [optional prompt] -> session/close
 * then closes stdin and waits for the bounded teardown.
 *
 * Usage:
 *   node scripts/smoke-client.mjs
 *   node scripts/smoke-client.mjs --prompt "say hi"        # needs model credentials
 *   DSH_BIN="pnpm dsh" node scripts/smoke-client.mjs       # source checkout launcher
 *
 * stdout/stdin of the child belong to ACP; the child's stderr is forwarded.
 */

import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const promptIndex = process.argv.indexOf('--prompt')
const promptText = promptIndex === -1 ? undefined : process.argv[promptIndex + 1]
if (promptIndex !== -1 && promptText === undefined) {
  console.error('smoke-client: --prompt needs a text argument')
  process.exit(2)
}

const [bin, ...binArgs] = (process.env.DSH_BIN ?? 'dsh').split(/\s+/).filter(Boolean)
const child = spawn(bin, [...binArgs, '--profile', 'acp-plus'], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.pipe(process.stderr)
child.on('error', (error) => {
  console.error(`smoke-client: failed to spawn ${bin}: ${error.message}`)
  process.exit(1)
})

const app = createAcpClientApp({ name: 'acp-plus-smoke' })
  .onNotification(methods.client.session.update, ({ params }) => {
    const update = params.update
    const detail = update.sessionUpdate === 'agent_message_chunk'
      ? JSON.stringify(update.content)
      : update.sessionUpdate === 'available_commands_update'
        ? `${update.availableCommands.length} command(s): ${update.availableCommands.map(command => command.name).join(', ')}`
        : update.sessionUpdate === 'current_mode_update'
          ? update.currentModeId
          : ''
    console.log(`  <= ${update.sessionUpdate}${detail === '' ? '' : ` ${detail}`}`)
    return Promise.resolve()
  })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    console.log(`  <= requestPermission ${params.toolCall?.toolCallId ?? ''}`)
    return Promise.resolve({ outcome: { outcome: 'cancelled' } })
  })
  .onRequest(methods.client.elicitation.create, ({ params }) => {
    console.log(`  <= elicitation/create ${params.message}`)
    return Promise.resolve({ action: 'decline' })
  })

const connection = app.connect(ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
))
const agent = connection.agent

const timeout = setTimeout(() => {
  console.error('smoke-client: timed out waiting for the server')
  child.kill('SIGKILL')
  process.exit(1)
}, 300_000)

try {
  console.log('== initialize')
  const initialized = await agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  console.log(`  agent: ${initialized.agentInfo?.name} ${initialized.agentInfo?.version}`)
  console.log(`  protocolVersion: ${initialized.protocolVersion}`)
  console.log(`  sessionCapabilities: ${JSON.stringify(initialized.agentCapabilities?.sessionCapabilities ?? {})}`)

  console.log('== session/new')
  const created = await agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })
  console.log(`  sessionId: ${created.sessionId}`)
  console.log(`  modes: ${JSON.stringify(created.modes ?? null)}`)
  console.log(`  model: ${created.configOptions?.find(option => option.id === 'model')?.currentValue ?? '(none)'}`)

  // available_commands_update is published right after the response.
  await new Promise(resolve => setTimeout(resolve, 200))

  console.log('== session/list')
  const listed = await agent.request(methods.agent.session.list, {})
  console.log(`  ${listed.sessions.length} stored session(s) visible`)

  if (promptText !== undefined) {
    console.log(`== session/prompt ${JSON.stringify(promptText)}`)
    const result = await agent.request(methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: promptText }],
    })
    console.log(`  stopReason: ${result.stopReason}`)
  }

  console.log('== session/close')
  await agent.request(methods.agent.session.close, { sessionId: created.sessionId })
  console.log('smoke-client: OK')
} catch (error) {
  console.error(`smoke-client: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  child.stdin.end()
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve('exited'))),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000)),
  ])
  if (exited === 'timeout') {
    console.error('smoke-client: server did not exit after stdin EOF; killing')
    child.kill('SIGKILL')
  }
}
