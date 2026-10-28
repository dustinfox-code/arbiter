import { open, unlink, stat, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LastStopRecord, StopPayload } from './types.js'

const POLL_MS = 100
const STALE_LOCK_MS = 10 * 60 * 1000

export interface StopLock {
  release(): Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Acquire an exclusive lock for stop-hook evaluation.
 *
 * Agents run every hook registered for an event in parallel. A project with
 * both the plugin hook and an `init`-wired hook therefore runs two
 * `arbiter-cc check` processes for one stop. The lock serialises them so the
 * second one sees the first one's result (see `matchesLastStop`) instead of
 * evaluating again and burning a second iteration.
 *
 * Uses an O_EXCL file create, which is atomic on every platform Node runs on.
 * A lock older than ten minutes is treated as left behind by a killed process.
 */
export async function acquireStopLock(lockPath: string, timeoutMs: number): Promise<StopLock> {
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      } finally {
        await handle.close()
      }
      return {
        release: async () => {
          try {
            await unlink(lockPath)
          } catch {
            // Already gone — nothing to release
          }
        },
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    // Lock is held. Reclaim it if stale, otherwise wait and retry.
    try {
      const info = await stat(lockPath)
      if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
        await unlink(lockPath).catch(() => undefined)
        continue
      }
    } catch {
      continue // Released between our open() and stat() — retry immediately
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for stop lock at ${lockPath}`)
    }
    await sleep(POLL_MS)
  }
}

/**
 * Decide whether an incoming stop payload is the same stop event that
 * `last` already answered.
 *
 * Same session and same prompt_id is a definite match. When the agent sends
 * no prompt_id, fall back to "same session within `windowMs`", which is wide
 * enough to catch parallel hooks for one stop and narrow enough that the next
 * genuine stop (after the agent has done more work) is evaluated afresh.
 */
export function matchesLastStop(
  last: LastStopRecord | undefined,
  payload: StopPayload | null,
  now: number,
  windowMs: number,
): boolean {
  if (!last || !payload || typeof payload.session_id !== 'string' || !payload.session_id) return false
  if (last.sessionId !== payload.session_id) return false

  const incomingPrompt = typeof payload.prompt_id === 'string' ? payload.prompt_id : undefined
  if (incomingPrompt && last.promptId) {
    return incomingPrompt === last.promptId
  }

  const lastAt = Date.parse(last.at)
  if (Number.isNaN(lastAt)) return false
  return now - lastAt <= windowMs
}
