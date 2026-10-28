import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, utimes, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireStopLock, matchesLastStop, hashMessage } from '../../src/core/stop-lock.js'
import type { LastStopRecord } from '../../src/core/types.js'

describe('acquireStopLock', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arbiter-lock-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates and releases the lock file', async () => {
    const path = join(dir, 'nested', 'task.json.lock')
    const lock = await acquireStopLock(path, 1000)
    await expect(access(path)).resolves.toBeUndefined()
    await lock.release()
    await expect(access(path)).rejects.toThrow()
  })

  it('a second acquirer waits until the first releases', async () => {
    const path = join(dir, 'task.json.lock')
    const first = await acquireStopLock(path, 1000)
    let secondAcquiredAt: number | undefined
    const waiting = acquireStopLock(path, 2000).then(lock => {
      secondAcquiredAt = Date.now()
      return lock
    })
    await new Promise(r => setTimeout(r, 250))
    expect(secondAcquiredAt).toBeUndefined()
    const releasedAt = Date.now()
    await first.release()
    const second = await waiting
    expect(secondAcquiredAt!).toBeGreaterThanOrEqual(releasedAt)
    await second.release()
  })

  it('times out when the lock is never released', async () => {
    const path = join(dir, 'task.json.lock')
    const held = await acquireStopLock(path, 1000)
    await expect(acquireStopLock(path, 250)).rejects.toThrow(/Timed out/)
    await held.release()
  })

  it('release leaves a lock that another process now owns', async () => {
    const path = join(dir, 'task.json.lock')
    const mine = await acquireStopLock(path, 500)
    // Simulate: my lock was reclaimed as stale and someone else wrote theirs
    await rm(path)
    await writeFile(path, JSON.stringify({ pid: 1, token: 'theirs' }))
    await mine.release()
    await expect(access(path)).resolves.toBeUndefined()
    await rm(path)
  })

  it('reclaims a stale lock left by a dead process', async () => {
    const path = join(dir, 'task.json.lock')
    await writeFile(path, '{"pid":99999}')
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000)
    await utimes(path, elevenMinutesAgo, elevenMinutesAgo)
    const lock = await acquireStopLock(path, 500)
    await lock.release()
  })
})

describe('matchesLastStop', () => {
  const base: LastStopRecord = {
    sessionId: 's1',
    promptId: 'p1',
    at: new Date(1_000_000).toISOString(),
    result: { decision: 'loop', iteration: 1, passedCriteria: [], failedCriteria: [], summary: '' },
  }

  it('matches same session and prompt inside the window', () => {
    expect(matchesLastStop(base, { session_id: 's1', prompt_id: 'p1' }, 1_000_000 + 4_000, 5000)).toBe(true)
  })

  it('rejects a different prompt in the same session even inside the window', () => {
    expect(matchesLastStop(base, { session_id: 's1', prompt_id: 'p2' }, 1_000_000 + 10, 5000)).toBe(false)
  })

  it('rejects a different session', () => {
    expect(matchesLastStop(base, { session_id: 's2', prompt_id: 'p1' }, 1_000_000 + 10, 5000)).toBe(false)
  })

  it('uses the time window when either side lacks a prompt id', () => {
    const noPrompt = { ...base, promptId: undefined }
    expect(matchesLastStop(noPrompt, { session_id: 's1' }, 1_000_000 + 4_000, 5000)).toBe(true)
    expect(matchesLastStop(noPrompt, { session_id: 's1' }, 1_000_000 + 6_000, 5000)).toBe(false)
    expect(matchesLastStop(base, { session_id: 's1' }, 1_000_000 + 4_000, 5000)).toBe(true)
  })

  it('rejects a stop whose stop_hook_active differs from the record', () => {
    const rec = { ...base, stopHookActive: false }
    expect(matchesLastStop(rec, { session_id: 's1', prompt_id: 'p1', stop_hook_active: false }, 1_000_000 + 10, 5000)).toBe(true)
    expect(matchesLastStop(rec, { session_id: 's1', prompt_id: 'p1', stop_hook_active: true }, 1_000_000 + 10, 5000)).toBe(false)
  })

  it('rejects a stop whose assistant message differs from the record', () => {
    const rec = { ...base, lastMessageHash: hashMessage('a') }
    expect(matchesLastStop(rec, { session_id: 's1', prompt_id: 'p1', last_assistant_message: 'a' }, 1_000_000 + 10, 5000)).toBe(true)
    expect(matchesLastStop(rec, { session_id: 's1', prompt_id: 'p1', last_assistant_message: 'b' }, 1_000_000 + 10, 5000)).toBe(false)
    // Absent on either side: not a discriminator
    expect(matchesLastStop(rec, { session_id: 's1', prompt_id: 'p1' }, 1_000_000 + 10, 5000)).toBe(true)
  })

  it('always requires the record to be inside the window, even with matching ids', () => {
    expect(matchesLastStop(base, { session_id: 's1', prompt_id: 'p1' }, 1_000_000 + 60_000, 5000)).toBe(false)
  })

  it('never matches without a record or without a session id', () => {
    expect(matchesLastStop(undefined, { session_id: 's1' }, 0, 5000)).toBe(false)
    expect(matchesLastStop(base, null, 0, 5000)).toBe(false)
    expect(matchesLastStop(base, { session_id: '' }, 0, 5000)).toBe(false)
  })
})
