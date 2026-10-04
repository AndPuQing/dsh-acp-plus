/**
 * Turn ending → ACP `StopReason` mapping (PLAN.md M0).
 *
 * Behavior ported from `packages/acp/acp/tests/codec.spec.ts`; the mapping is a
 * pure function, so the test needs no Context or transport.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { turnEndToStopReason } from '../src/codec.ts'

const CASES: ReadonlyArray<readonly [TurnEndReason, string]> = [
  [{ kind: 'completed' }, 'end_turn'],
  [{ kind: 'max-tokens' }, 'max_tokens'],
  [{ kind: 'aborted', reason: { kind: 'user' } }, 'end_turn'],
  [{ kind: 'interrupted' }, 'cancelled'],
  [{ kind: 'blocked' }, 'end_turn'],
  [{ kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } }, 'end_turn'],
]

test('maps every live-turn ending to its wire stop reason', () => {
  for (const [reason, expected] of CASES) {
    assert.equal(turnEndToStopReason(reason), expected, JSON.stringify(reason))
  }
})
