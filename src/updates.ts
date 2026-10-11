/**
 * Committed DSH session events → standard ACP `session/update` projections.
 *
 * Ported from `packages/acp/acp/src/updates.ts`: the bridge projects the
 * committed assistant message (not the raw stream) so a replayed transcript and
 * a live one are byte-identical, and tool results reuse the same content
 * conversion as assistant output.
 *
 * @module dsh-acp-plus/updates
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import { assistantBlockToAcp } from './content.ts'

/**
 * Convert one committed assistant message and its context usage in block order.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: block.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  const usage = event.data.usage === undefined ? undefined : usageUpdate(ctx, session)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/** ACP tool-call category, taken from the protocol's own update shape. */
type ToolCallKind = NonNullable<Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>['kind']>

/**
 * Start one generic ACP tool lifecycle from the durable call fact.
 * @param event - committed DSH tool-call event.
 * @returns the standard generic tool-call update.
 */
export function toolCallUpdate(event: SessionEvent<'tool/call'>): SessionUpdate {
  const rawInput = parseToolArguments(event.data.arguments)
  const { title, kind } = toolPresentation(event.data.name, rawInput)
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title,
    kind,
    status: 'in_progress',
    rawInput,
  }
}

/**
 * Human title and ACP category for one DSH tool call. Clients pick their card
 * from `kind` plus `rawInput` — a terminal card needs `execute` and `command` —
 * so the bare tool name is only the fallback for a tool this bridge does not
 * know.
 * @param name - DSH tool name.
 * @param rawInput - Parsed tool arguments, or the raw string when unparsable.
 * @returns the ACP title and kind for the call.
 */
function toolPresentation(name: string, rawInput: unknown): { title: string; kind: ToolCallKind } {
  const args = typeof rawInput === 'object' && rawInput !== null
    ? rawInput as Record<string, unknown>
    : {}
  const text = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    return undefined
  }
  switch (name) {
    case 'bash':
    case 'pwsh':
      return { title: text('command') ?? name, kind: 'execute' }
    case 'read':
    case 'read_image':
      return { title: text('path', 'file_path') ?? name, kind: 'read' }
    case 'write':
    case 'edit':
      return { title: text('path', 'file_path') ?? name, kind: 'edit' }
    case 'glob':
    case 'grep':
      return { title: text('pattern', 'query') ?? name, kind: 'search' }
    case 'web_fetch':
      return { title: text('url') ?? name, kind: 'fetch' }
    case 'web_search':
      return { title: text('query') ?? name, kind: 'fetch' }
    default:
      return { title: name, kind: 'other' }
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @returns the standard completed or failed tool-call update.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<SessionUpdate> {
  const message = event.data.message
  const content: ToolCallContent[] = []
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    status: message.isError === true ? 'failed' : 'completed',
    content,
  }
}

/**
 * Report current context occupancy for a session with both usage and capacity facts.
 * Exported so replay can publish one final reading after the transcript; the live
 * path only publishes it when the message that triggered it carried provider usage.
 * @param ctx - bridge context carrying the optional token-meter service.
 * @param session - durable session to measure.
 * @returns the standard usage update, or undefined without meter or capacity.
 */
export function usageUpdate(ctx: Context, session: Session): SessionUpdate | undefined {
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return value
  }
}
