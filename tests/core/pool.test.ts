import { describe, it, expect } from 'vitest'
import { pooled } from '../../src/core/pool.js'

describe('pooled', () => {
  it('returns results in input order', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ]
    expect(await pooled(tasks, 2)).toEqual(['a', 'b', 'c'])
  })

  it('respects concurrency limit', async () => {
    let concurrent = 0
    let maxConcurrent = 0

    const makeTask = (delay: number) => async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, delay))
      concurrent--
      return delay
    }

    const tasks = [makeTask(50), makeTask(50), makeTask(50), makeTask(50)]
    await pooled(tasks, 2)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('handles empty task list', async () => {
    expect(await pooled([], 3)).toEqual([])
  })
})
