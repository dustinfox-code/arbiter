import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointManager } from '../../src/core/checkpoint-manager.js'
import type { CriteriaResult } from '../../src/core/types.js'

describe('CheckpointManager', () => {
  let tempDir: string
  let manager: CheckpointManager

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'arbiter-test-'))
    manager = new CheckpointManager(tempDir, '.arbiter/checkpoints')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function makeResults(passed: boolean[]): CriteriaResult[] {
    return passed.map((p, i) => ({
      criteriaId: `criterion-${i}`,
      passed: p,
      required: true,
      description: `Criterion ${i}`,
      durationMs: 10,
    }))
  }

  it('list returns empty array when no checkpoints exist', async () => {
    expect(await manager.list()).toEqual([])
  })

  it('writes and reads a checkpoint', async () => {
    const cp = manager.buildCheckpoint(1, makeResults([true, false]))
    await manager.write(cp)

    const list = await manager.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(cp.id)
    expect(list[0].passedIds).toEqual(['criterion-0'])
    expect(list[0].failedIds).toEqual(['criterion-1'])
  })

  it('getById returns the correct checkpoint', async () => {
    const cp = manager.buildCheckpoint(1, makeResults([true]))
    await manager.write(cp)

    const found = await manager.getById(cp.id)
    expect(found).not.toBeNull()
    expect(found!.iteration).toBe(1)
  })

  it('getById returns null for non-existent id', async () => {
    expect(await manager.getById('nonexistent')).toBeNull()
  })

  it('prune keeps only the last N checkpoints', async () => {
    for (let i = 1; i <= 5; i++) {
      const cp = manager.buildCheckpoint(i, makeResults([true]))
      await manager.write(cp)
    }

    const removed = await manager.prune(3)
    expect(removed).toBe(2)

    const remaining = await manager.list()
    expect(remaining).toHaveLength(3)
    expect(remaining[0].iteration).toBe(3)
  })

  it('prune returns 0 when within limit', async () => {
    const cp = manager.buildCheckpoint(1, makeResults([true]))
    await manager.write(cp)
    expect(await manager.prune(10)).toBe(0)
  })

  it('buildCheckpoint generates correct id format', () => {
    const cp = manager.buildCheckpoint(3, makeResults([true]))
    expect(cp.id).toMatch(/^checkpoint-3-\d{8}T\d{6}Z$/)
    expect(cp.iteration).toBe(3)
  })
})
