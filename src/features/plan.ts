/**
 * ACP plan updates from the harness's `todos` projection (PLAN.md M9).
 *
 * The todo tool (an optional companion package, deliberately not a dependency
 * of this bridge) registers a client-visible `todos` projection whose value is
 * the latest whole-list write: `TodoItem[]`, or `null` before the first write.
 * This module maps that value onto the standard ACP `plan` update, which the
 * client replaces wholesale — the same whole-value semantics, so no diffing is
 * needed.
 *
 * The projection table is merge-extensible and owned by the companion package,
 * so this module reads it through the same structural contract the registry
 * publishes (`onChanged` + `snapshot`) instead of redeclaring its types.
 *
 * Milestone: M9 in PLAN.md.
 *
 * @module dsh-acp-plus/features/plan
 */

import type { PlanEntry, SessionUpdate } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: declaration-merges `ctx.sessionProjections`.
import type {} from '@deepseek-ai/dsh-session-projection'

/** One todo entry as the `todos` projection publishes it. */
export interface TodoEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * The subset of the projection registry this bridge consumes. The real
 * registry satisfies it structurally; keeping it local avoids depending on
 * the todo package that owns the `todos` key.
 */
export interface TodoProjectionSource {
  onChanged(listener: (session: Session, key: string, value: unknown) => void): () => void
  snapshot(session: Session): { values: Partial<Record<string, unknown>> }
}

/**
 * Map one todo list onto a wholesale ACP plan update.
 * @param todos - complete current list.
 * @returns the standard plan update.
 */
export function todoPlan(todos: readonly TodoEntry[]): SessionUpdate {
  return {
    sessionUpdate: 'plan',
    // Todo entries carry no importance axis; every entry is routine work.
    entries: todos.map((todo): PlanEntry => ({
      content: todo.content,
      priority: 'medium',
      status: todo.status,
    })),
  }
}

/**
 * Validate one projection value and map it, or return undefined for values
 * this bridge must not publish: `null` (the projection's pre-first-write
 * state) and anything that is not a well-formed todo list.
 * @param value - raw `todos` projection value.
 * @returns the plan update, or undefined.
 */
export function todoPlanValue(value: unknown): SessionUpdate | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: TodoEntry[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined
    const { content, status } = item as { content?: unknown; status?: unknown }
    if (typeof content !== 'string') return undefined
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return undefined
    entries.push({ content, status })
  }
  return todoPlan(entries)
}

/** Read the registry through its published contract, when the deployment mounts it. */
function projectionSource(ctx: Context): TodoProjectionSource | undefined {
  return ctx.get('sessionProjections') as unknown as TodoProjectionSource | undefined
}

/**
 * Read one live session's current plan, for the initial publish after
 * `session/load` (replay starts no projection drive of its own).
 * @param ctx - plugin context carrying the optional projection registry.
 * @param session - restored session to read.
 * @returns the plan update, or undefined without a registry or a todo list.
 */
export function sessionPlan(ctx: Context, session: Session): SessionUpdate | undefined {
  const projections = projectionSource(ctx)
  if (projections === undefined) return undefined
  return todoPlanValue(projections.snapshot(session).values['todos'])
}

/**
 * Subscribe to `todos` projection changes so live turns publish plan updates.
 * @param ctx - plugin context; the subscription lives on its fiber.
 * @param publish - receives only validated todo plans, with the exact session.
 * @returns nothing.
 */
export function subscribeTodoPlans(
  ctx: Context,
  publish: (session: Session, update: SessionUpdate) => void,
): void {
  ctx.inject(['sessionProjections'], (injected) => {
    const projections = injected.sessionProjections as unknown as TodoProjectionSource
    const off = projections.onChanged((session, key, value) => {
      if (key !== 'todos') return
      const update = todoPlanValue(value)
      if (update !== undefined) publish(session, update)
    })
    return off
  })
}
