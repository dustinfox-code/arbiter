import { open, unlink, stat, mkdir, rename, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
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
 * The file holds a token; `release` only removes the file if the token is
 * still ours, so a process can never delete a lock another process has since
 * taken. A lock older than ten minutes is treated as left behind by a killed
 * process and reclaimed by atomic rename, so two reclaimers cannot both win.
 */
export async function acquireStopLock(lockPath: string, timeoutMs: number): Promise<StopLock> {
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  const token = `${process.pid}-${randomUUID()}`

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }))
      } catch (writeErr) {
        await handle.close().catch(() => undefined)
        await unlink(lockPath).catch(() => undefined)
        throw writeErr
      }
      await handle.close()
      return {
        release: async () => {
          try {
            const current = JSON.parse(await readFile(lockPath, 'utf-8')) as { token?: string }
            if (current.token === token) await unlink(lockPath)
          } catch {
            // Already gone, or not ours to remove
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
        // rename is atomic: exactly one reclaimer succeeds, and nobody unlinks a fresh lock by mistake
        const graveyard = `${lockPath}.stale-${token}`
        await rename(lockPath, graveyard)
        await unlink(graveyard).catch(() => undefined)
        continue
      }
    } catch {
      continue // Released or reclaimed by someone else between our calls — retry immediately
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for stop lock at ${lockPath}`)
    }
    await sleep(POLL_MS)
  }
}

/**
 * Decide whether an incoming stop payload is the same stop *event* that
 * `last` already answered, as opposed to a later stop in the same turn.
 *
 * One user turn produces several stop events once a hook starts blocking:
 * stop, blocked, work, stop again. Those share session_id and prompt_id,
 * so neither can be the whole key. What tells stop events apart within a
 * turn: `stop_hook_active` flips from false to true after the first block,
 * the assistant's last message changes once it has done more work, and
 * real stops are seconds apart while parallel hooks for one stop finish
 * within milliseconds of each other. So every discriminator the agent
 * sends must agree, and the record must be recent.
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
  if (incomingPrompt && last.promptId && incomingPrompt !== last.promptId) return false

  if (typeof payload.stop_hook_active === 'boolean' && typeof last.stopHookActive === 'boolean'
    && payload.stop_hook_active !== last.stopHookActive) return false

  const incomingHash = hashMessage(payload.last_assistant_message)
  if (incomingHash && last.lastMessageHash && incomingHash !== last.lastMessageHash) return false

  const lastAt = Date.parse(last.at)
  if (Number.isNaN(lastAt)) return false
  return now - lastAt <= windowMs
}

/** Stable short hash of the assistant's last message; undefined when absent. */
export function hashMessage(message: unknown): string | undefined {
  if (typeof message !== 'string' || !message) return undefined
  return createHash('sha1').update(message).digest('hex')
}
