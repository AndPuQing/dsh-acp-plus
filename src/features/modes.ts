/**
 * Session modes over ACP: expose DSH's plan mode as the ACP mode pair and wire
 * `session/set_mode` to the plan-mode controller.
 *
 * Plan mode is a prompt-guidance axis, independent of the approval and sandbox
 * axes, so switching it never widens permissions. When no `ctx.planMode` is
 * mounted the session advertises a single `default` mode and rejects every
 * other switch — the wire never offers a mode the deployment cannot enter.
 *
 * Milestone: M5 in PLAN.md.
 *
 * @module dsh-acp-plus/features/modes
 */

import type { SessionMode, SessionModeState } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: declaration-merges `ctx.planMode` and the `plan` projection key.
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: declaration-merges `ctx.sessionProjections`.
import type {} from '@deepseek-ai/dsh-session-projection'

/** ACP mode id for ordinary execution. */
export const DEFAULT_MODE_ID = 'default'
/** ACP mode id for plan mode. */
export const PLAN_MODE_ID = 'plan'

const DEFAULT_MODE: SessionMode = {
  id: DEFAULT_MODE_ID,
  name: 'Default',
  description: 'Carry out the task directly.',
}

const PLAN_MODE: SessionMode = {
  id: PLAN_MODE_ID,
  name: 'Plan',
  description: 'Research and present a plan before making changes.',
}

/** Caller-correctable mode failure. */
export class AcpPlusSessionModeError extends Error {
  /** @param message - detail preserved on the wire as invalid params. */
  constructor(message: string) {
    super(message)
    this.name = 'AcpPlusSessionModeError'
  }
}

/**
 * The modes this deployment can actually enter.
 * @param ctx - plugin context carrying the optional plan-mode controller.
 * @returns `default` alone, or `default` plus `plan`.
 */
export function availableSessionModes(ctx: Context): readonly SessionMode[] {
  return ctx.get('planMode') === undefined ? [DEFAULT_MODE] : [DEFAULT_MODE, PLAN_MODE]
}

/**
 * Read the session's committed plan-mode state from the plan projection.
 * @param ctx - plugin context carrying the projection registry.
 * @param session - durable session whose history is folded.
 * @returns whether plan mode is active.
 */
export function planModeActive(ctx: Context, session: Session): boolean {
  return ctx.get('sessionProjections')?.stateOf(session, 'plan')?.active === true
}

/**
 * Build the complete ACP mode state for one session.
 *
 * `undefined` when no plan-mode controller is mounted: the response then omits
 * `modes` entirely, keeping the wire identical to the native bridge until a
 * deployment opts into the plan-mode feature.
 * @param ctx - plugin context carrying the optional plan-mode controller.
 * @param session - durable session whose committed mode is read.
 * @returns current mode id plus every available mode, or undefined.
 */
export function sessionModeState(ctx: Context, session: Session): SessionModeState | undefined {
  if (ctx.get('planMode') === undefined) return undefined
  return {
    currentModeId: planModeActive(ctx, session) ? PLAN_MODE_ID : DEFAULT_MODE_ID,
    availableModes: [...availableSessionModes(ctx)],
  }
}

/**
 * Apply one requested ACP mode to the session's agent.
 * @param ctx - plugin context carrying the optional plan-mode controller.
 * @param agent - exact live agent whose mode switches.
 * @param modeId - requested ACP mode id.
 * @throws {AcpPlusSessionModeError} for an id this deployment does not offer.
 */
export function setSessionMode(ctx: Context, agent: Agent, modeId: string): void {
  const planMode = ctx.get('planMode')
  if (modeId === DEFAULT_MODE_ID) {
    planMode?.set(agent, false)
    return
  }
  if (modeId === PLAN_MODE_ID && planMode !== undefined) {
    planMode.set(agent, true)
    return
  }
  throw new AcpPlusSessionModeError(`unknown session mode: ${modeId}`)
}
