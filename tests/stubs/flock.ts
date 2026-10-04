/**
 * Test-only stand-in for `@deepseek-ai/node-addon-system/flock`.
 *
 * The JSONL persistence layer takes a real kernel write lease through this
 * entry. Bridge tests need cross-harness ("another process") exclusion, so the
 * stub emulates advisory locking in-process: a lock is keyed by the open
 * descriptor's device+inode identity, and stale descriptors are pruned by an
 * `fstat` probe. A real descriptor's `close()` is what releases a kernel lock;
 * here the next acquisition observes the closed descriptor.
 */

import { fstatSync } from 'node:fs'

/** Live holders keyed by open descriptor, valued by their file identity. */
const held = new Map<number, string>()

/** Stable device+inode identity of an open descriptor. */
function identity(fd: number): string {
  const stats = fstatSync(fd)
  return `${stats.dev}:${stats.ino}`
}

/**
 * Acquire an exclusive lock for the caller's descriptor, emulating flock(2).
 * @param fd - open file descriptor owned by the caller.
 * @returns after acquisition; rejects with EAGAIN when another live descriptor holds the same inode.
 */
export async function tryLockExclusive(fd: number): Promise<void> {
  const key = identity(fd)
  for (const [holder, holderKey] of held) {
    if (holder === fd) continue
    let live = false
    try {
      live = identity(holder) === holderKey
    } catch {
      live = false
    }
    if (!live) {
      held.delete(holder)
      continue
    }
    if (holderKey === key) {
      throw Object.assign(new Error('EAGAIN: flock failed'), {
        code: 'EAGAIN',
        errno: 11,
        syscall: 'flock',
      })
    }
  }
  held.set(fd, key)
}
