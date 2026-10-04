/**
 * Pure translation between the harness lifecycle and the ACP wire.
 *
 * Ported from `packages/acp/acp/src/codec.ts`; kept free of Context and I/O so
 * the turn-ending rules can be diffed and unit-tested in isolation.
 *
 * @module dsh-acp-plus/codec
 */

import type { StopReason } from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * Map a harness turn ending to ACP's terminal reason vocabulary.
 * @param reason - harness turn outcome.
 * @returns the closest legal ACP stop reason.
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // `cancelled` is reserved for explicit client cancellation (`session/cancel`)
    // and disposal, both settled out of band; a turn aborted by a hook or
    // another owner is ordinary quiescence and reports `end_turn`.
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    // TurnEndReason is merge-extensible; seed-only variants (`forked`) never
    // end an ACP prompt turn, so every remaining member is ordinary quiescence.
    default:
      return 'end_turn'
  }
}
