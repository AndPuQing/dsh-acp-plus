/**
 * `additionalDirectories`: accept extra absolute workspaces on session
 * lifecycle requests.
 *
 * Native behavior is a flat rejection. Accepting directories is not a wire
 * change — it is a **trust decision**, because every directory the agent can
 * reach extends the workspace policy of the session.
 *
 * Mechanism in this repository reuses the harness's existing permission
 * machinery instead of widening the sandbox:
 * - Entries are authorized exactly like `cwd`: absolute path spelling plus
 *   physical identity (canonical directory), deduplicated; the primary
 *   workspace is dropped rather than double-listed.
 * - The sandbox stays at its standing mode. A write/edit under a declared root
 *   is reachable through the existing `sandbox_permissions` escalation: the
 *   tool asks `ctx.approval`, and this bridge answers that ask itself when the
 *   call's physically resolved target is inside the declared set (the client
 *   already granted the directory at session level). Every other ask — bash
 *   commands, paths outside the set, a `read-only` standing policy — is
 *   forwarded to the client unchanged, so the human remains the authority
 *   wherever the target cannot be verified.
 * - `load`/`resume` re-declare and re-validate the same way; a dropped or
 *   changed set only narrows what is auto-approved, never widens it.
 *
 * Open question D1 resolved as **session-level**: the ACP client is the trusted
 * automation peer and declares the roots once per lifecycle request, exactly as
 * it already declares `cwd`. Per-call approval remains for everything the
 * bridge cannot verify.
 *
 * Milestone: M3 in PLAN.md.
 *
 * @module dsh-acp-plus/features/additional-directories
 */

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Upper bound on declared roots; keeps one session's grant reviewable. */
export const MAX_ADDITIONAL_DIRECTORIES = 16

/** Tools whose single mutation target the bridge can verify before approving. */
const SINGLE_TARGET_TOOLS: ReadonlySet<string> = new Set(['write', 'edit'])

/** Runtime-context name for the declared-root hint. */
export const ADDITIONAL_DIRECTORIES_CONTEXT = 'acp-plus:additional-directories'

/** Caller-correctable additional-directories failure. */
export class AcpPlusAdditionalDirectoriesError extends Error {
  /** @param message - detail preserved on the wire as invalid params. */
  constructor(message: string) {
    super(message)
    this.name = 'AcpPlusAdditionalDirectoriesError'
  }
}

/** Canonical physical identity of an existing directory, or undefined otherwise. */
async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const [canonical, info] = await Promise.all([realpath(path), stat(path)])
    return info.isDirectory() ? canonical : undefined
  } catch (_unresolvablePath) {
    return undefined
  }
}

/**
 * Whether `path` is `root` or a descendant of it, using canonical spellings.
 * The identity fallback fs-sandbox applies for exotic aliases is deliberately
 * omitted: a miss only forwards the ask to the client, never over-approves.
 * @param path - canonical target key from the filesystem provider.
 * @param root - canonical declared root.
 * @returns whether the target is contained.
 */
export function isPathUnder(path: string, root: string): boolean {
  if (path === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return process.platform === 'win32'
    ? path.toLowerCase().startsWith(prefix.toLowerCase())
    : path.startsWith(prefix)
}

/**
 * Authorize requested additional workspaces for one session.
 * @param cwd - primary workspace already validated as absolute.
 * @param directories - additional absolute workspaces from the request.
 * @returns canonical authorized roots, primary workspace and duplicates removed.
 * @throws {AcpPlusAdditionalDirectoriesError} on an unusable entry or too many entries.
 */
export async function authorizeAdditionalDirectories(
  cwd: string,
  directories: readonly string[],
): Promise<readonly string[]> {
  if (directories.length === 0) return []
  if (directories.length > MAX_ADDITIONAL_DIRECTORIES) {
    throw new AcpPlusAdditionalDirectoriesError(
      `additionalDirectories accepts at most ${MAX_ADDITIONAL_DIRECTORIES} entries`,
    )
  }
  const canonicalCwd = await canonicalDirectory(cwd) ?? resolve(cwd)
  const roots: string[] = []
  const seen = new Set<string>()
  for (const entry of directories) {
    if (!isAbsolute(entry)) {
      throw new AcpPlusAdditionalDirectoriesError(`additionalDirectories entries must be absolute paths: ${entry}`)
    }
    const canonical = await canonicalDirectory(entry)
    if (canonical === undefined) {
      throw new AcpPlusAdditionalDirectoriesError(`additionalDirectories entry is not an existing directory: ${entry}`)
    }
    if (canonical === canonicalCwd || seen.has(canonical)) continue
    seen.add(canonical)
    roots.push(canonical)
  }
  return roots
}

/**
 * Decide whether one tool escalation is already covered by the session's
 * declared roots. Only a path-verifiable single-target tool under a
 * `workspace-write` standing policy qualifies; everything else returns false so
 * the ask reaches the client.
 * @param ctx - plugin context carrying the optional filesystem and policy services.
 * @param session - exact session the ask belongs to.
 * @param roots - canonical declared roots for that session.
 * @param toolName - tool the escalation belongs to.
 * @param filePath - the call's single target path, when one was recorded.
 * @returns whether the bridge may answer `allowed-once` without the client.
 */
export async function preApprovedEscalation(
  ctx: Context,
  session: Session,
  roots: readonly string[],
  toolName: string,
  filePath: string | undefined,
): Promise<boolean> {
  if (roots.length === 0 || filePath === undefined || !SINGLE_TARGET_TOOLS.has(toolName)) return false
  // Only the workspace-write posture extends into declared roots; a read-only
  // session keeps every widening a human decision.
  const policy = ctx.get('sandboxPolicy')
  if (policy !== undefined && policy.resolve({ session }).mode !== 'workspace-write') return false
  const fs = ctx.get('fs')
  if (fs === undefined) return false
  let target: Awaited<ReturnType<typeof fs.resolve>>
  try {
    target = await fs.resolve(filePath, {
      ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
    })
  } catch (_unresolvableTarget) {
    return false
  }
  return roots.some(root => isPathUnder(String(target.targetKey), root))
}

/**
 * Publish the declared roots to the model as runtime context.
 *
 * The sandbox denial/hint already teaches the retry loop, but the hint does not
 * know which directories the client pre-approved. This context does, so the
 * model escalates the exact operation once instead of rediscovering it.
 * @param agentCtx - unpublished Agent scope that owns the context contribution.
 * @param roots - canonical declared roots for this session.
 */
export function registerAdditionalDirectoriesContext(agentCtx: Context, roots: readonly string[]): void {
  if (roots.length === 0) return
  const systemPrompt = agentCtx.get('systemPrompt')
  if (systemPrompt === undefined) return
  systemPrompt.context({
    name: ADDITIONAL_DIRECTORIES_CONTEXT,
    order: systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
    text: () => `Additional workspace roots pre-authorized by the client: ${roots.map(root => JSON.stringify(root)).join(', ')}. `
      + 'A write or edit whose path lies inside one of these roots is pre-approved: include '
      + 'sandbox_permissions="danger-full-access" and a one-sentence justification on that call. '
      + 'Anything outside them keeps the standing sandbox policy and its approval flow.',
  })
}
