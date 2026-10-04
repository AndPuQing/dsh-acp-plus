/**
 * `session/load`: reopen a persisted session and replay its transcript as
 * standard `session/update` notifications.
 *
 * Native behavior is "resume without replay": `session/resume` restores the log
 * but emits nothing. A client that renders history therefore sees an empty
 * transcript. This module produces the missing replay.
 *
 * Mechanism:
 * - `ctx.sessionPersistence.open(id, 'read')` yields the validated contiguous
 *   log without taking write ownership; `replaySession` closes the handle
 *   before returning.
 * - Transcript events are projected with the same `src/updates.ts` functions the
 *   live path uses, in durable sequence order, so a replayed card and a
 *   streamed card are indistinguishable to the client.
 * - `usage_update` is deliberately not replayed: it reports *current* context
 *   pressure, not a transcript fact, and the live measurement is only
 *   meaningful for the folded log. The loader publishes one final reading
 *   after the transcript instead (see `usageUpdate`).
 *
 * Constraints:
 * - Ordering: the loader replays before composing the live Agent, so no live
 *   update can interleave and replay starts nothing that could race. The id is
 *   reserved for the whole handler, and projected updates are awaited in order.
 * - A load for an id owned by another live session must fail, not steal it;
 *   the caller enforces reservation and header/workspace identity.
 * - Image content is re-read from the attachment store and integrity-verified
 *   by the same projection code as the live path.
 *
 * Milestone: M2 in PLAN.md.
 *
 * @module dsh-acp-plus/features/session-load
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from '../updates.ts'

/**
 * Replay-only session stand-in.
 *
 * Projection reads `requestContext()` solely for context pressure. Replay has
 * no live route yet, so the shim reports no capacity and every historical
 * `usage_update` is omitted; the caller publishes the final reading after the
 * resumed Agent exists.
 */
const REPLAY_SESSION = { requestContext: () => undefined } as unknown as Session

/**
 * Read and project one persisted session's transcript, oldest first.
 * @param ctx - plugin context carrying session persistence and attachments.
 * @param sessionId - persisted session to replay.
 * @param notify - ordered `session/update` delivery owned by the bridge.
 * @param signal - optional request cancellation checked between events.
 * @returns a promise settling after every update has been delivered.
 */
export async function replaySession(
  ctx: Context,
  sessionId: SessionId,
  notify: (notification: SessionNotification) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const options = signal === undefined ? undefined : { signal }
  const handle = await ctx.sessionPersistence.open(sessionId, 'read', options)
  let events: readonly SessionEvent[]
  try {
    events = (await handle.read(0, undefined, options)).events
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch {
      // The read failure is the actionable cause; a close failure on the same
      // broken handle adds nothing.
    }
    throw error
  }
  await handle.close()

  for (const event of events) {
    signal?.throwIfAborted()
    if (event.type === 'assistant/message') {
      for (const update of await assistantUpdates(ctx, REPLAY_SESSION, event)) {
        await notify({ sessionId, update })
      }
    } else if (event.type === 'tool/call') {
      await notify({ sessionId, update: toolCallUpdate(event) })
    } else if (event.type === 'tool/result') {
      await notify({ sessionId, update: await toolResultUpdate(ctx, event) })
    }
  }
}
