/**
 * `session/fork`: derive a child session's seed from a persisted transcript
 * prefix.
 *
 * Ported from the harness's own fork command
 * (`packages/api/session-controller/src/commands.ts`): the boundary defaults to
 * the latest completed-turn prefix, so a client that forks a session which is
 * still mid-turn inherits only settled history. `buildForkSeed` copies that
 * inclusive prefix, appends the inherited-cut marker, and closes any open tail
 * with `forked` results so the child never resumes half a tool call.
 *
 * This module is transport- and storage-agnostic: the caller reads the events
 * and creates the Agent.
 *
 * Milestone: M8 in PLAN.md.
 *
 * @module dsh-acp-plus/features/fork
 */

import { SessionLogOffset, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'

/** A child session's copied history and the exact inherited prefix length. */
export interface ForkPrefix {
  /** Inclusive source event the child inherits through. */
  boundary: SessionSeq
  /** Source prefix, inherited-cut marker, and synthetic closers for an open tail. */
  seed: readonly SessionEvent[]
  /** Number of events copied from the source, excluding synthetic closers. */
  inheritedEventCount: ReturnType<typeof SessionLogOffset>
}

/**
 * Resolve the omitted-cut default: the latest completed-turn prefix, including
 * standalone events committed after that turn ended but before the next turn
 * (or queued user message) begins.
 * @param events - source log with contiguous seqs from zero.
 * @returns the inclusive boundary, or undefined when no turn ever completed.
 */
export function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): SessionSeq | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (
      next.type === 'turn/start'
      || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced'
    ) break
    boundary = next.seq
  }
  return boundary
}

/**
 * Build the fork seed for one source log.
 * @param events - source log with contiguous seqs from zero.
 * @returns the seed and inherited prefix length, or undefined when the source
 *   has no completed turn to fork from.
 */
export function forkPrefix(events: readonly SessionEvent[]): ForkPrefix | undefined {
  const boundary = latestCompletedPrefixBoundary(events)
  if (boundary === undefined) return undefined
  // The boundary always names an existing event: it starts at a committed
  // `turn/end` and only advances over committed neighbours.
  return {
    boundary,
    seed: buildForkSeed(events, boundary),
    inheritedEventCount: SessionLogOffset(boundary + 1),
  }
}
