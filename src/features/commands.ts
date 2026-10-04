/**
 * Slash commands over ACP: publish the registry as
 * `available_commands_update`, and route a client prompt that exactly names a
 * registered command into `ctx.commands` instead of the model.
 *
 * ACP has no dedicated command-invocation method: the client receives the
 * command list and sends the command as prompt text. This module owns that
 * convention plus the durable projections of the registry's own
 * `command/run` / `command/done` lifecycle events, so a replayed transcript
 * shows the same command cards a live session did.
 *
 * Milestone: M5 in PLAN.md.
 *
 * @module dsh-acp-plus/features/commands
 */

import type { AvailableCommand, ContentBlock as AcpContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: declaration-merges `ctx.commands` and the `command/*` session events.
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Cached `parseCommand` from the command registry, loaded on first use. */
let parseCommand: ((line: string) => { name: string; rawInput: string } | undefined) | undefined

/**
 * The registry's advertised commands for one agent, or an empty list when no
 * command registry is mounted.
 * @param ctx - plugin context carrying the optional command registry.
 * @param agent - exact receiving agent whose scoped command view is read.
 * @returns ACP command descriptors in registry order.
 */
export function availableCommands(ctx: Context, agent: Agent): AvailableCommand[] {
  const commands = ctx.get('commands')
  if (commands === undefined) return []
  return commands.list(agent).map(descriptor => ({
    name: descriptor.name,
    description: descriptor.description,
    ...descriptor.input === undefined ? {} : { input: { hint: descriptor.input.hint } },
  }))
}

/**
 * Extract a candidate slash-command line from a prompt.
 *
 * Only an all-text prompt that starts with `/` can be a command; a prompt with
 * images or resources stays a model turn.
 * @param prompt - untrusted ACP prompt blocks in wire order.
 * @returns the trimmed candidate line, or undefined when this is not one.
 */
export function promptCommandLine(prompt: readonly AcpContentBlock[]): string | undefined {
  if (prompt.length === 0) return undefined
  let text = ''
  for (const block of prompt) {
    if (block.type !== 'text') return undefined
    text += block.text
  }
  const line = text.trimStart()
  return line.startsWith('/') ? line : undefined
}

/**
 * Parse one candidate line with the registry's own grammar.
 * @param line - complete candidate command line.
 * @returns the parsed name and original line, or undefined when it is not a command.
 */
export async function parseSlashCommand(line: string): Promise<{ name: string; line: string } | undefined> {
  if (parseCommand === undefined) {
    // Optional capability: load the registry package only when a prompt looks
    // like a command, so a composition without it is unaffected.
    parseCommand = (await import('@deepseek-ai/dsh-commands')).parseCommand
  }
  const parsed = parseCommand(line)
  return parsed === undefined ? undefined : { name: parsed.name, line }
}

/**
 * Project one committed `command/run` record as the user's command line.
 * @param event - committed command lifecycle opener.
 * @returns the ACP user-message update.
 */
export function commandRunUpdate(event: SessionEvent<'command/run'>): SessionUpdate {
  return {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: `/${event.data.name}${event.data.args ?? ''}` },
  }
}

/**
 * Project one committed `command/done` record as the UI-facing result text.
 * @param event - committed command lifecycle closer.
 * @returns the ACP agent-message update, or undefined without result text.
 */
export function commandDoneUpdate(event: SessionEvent<'command/done'>): SessionUpdate | undefined {
  const text = event.data.text
  if (text === undefined || text.length === 0) return undefined
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}
