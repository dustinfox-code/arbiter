import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskContextManager, validateTask } from '../../src/core/task-manager.js'

describe('TaskContextManager', () => {
  let tempDir: string
  let manager: TaskContextManager

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'arbiter-test-'))
    // Write a default config so manager can resolve the task file path
    await mkdir(join(tempDir, '.arbiter'), { recursive: true })
    await writeFile(
      join(tempDir, '.arbiter', 'config.json'),
      JSON.stringify({ taskFile: '.arbiter/task.json' }),
    )
    manager = new TaskContextManager(tempDir)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns null when no task exists', async () => {
    expect(await manager.load()).toBeNull()
  })

  it('exists() returns false when no task exists', async () => {
    expect(await manager.exists()).toBe(false)
  })

  it('creates a task with correct fields', async () => {
    const task = await manager.create('Test task', [], 5)
    expect(task.id).toBeTruthy()
    expect(task.description).toBe('Test task')
    expect(task.status).toBe('pending')
    expect(task.iteration).toBe(0)
    expect(task.maxIterations).toBe(5)
    expect(task.checkpoints).toEqual([])
  })

  it('loads a created task', async () => {
    const created = await manager.create('Test task', [], 5)
    const loaded = await manager.load()
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe(created.id)
  })

  it('exists() returns true after create', async () => {
    await manager.create('Test task', [], 5)
    expect(await manager.exists()).toBe(true)
  })

  it('updates a task', async () => {
    await manager.create('Test task', [], 5)
    const updated = await manager.update({ status: 'running', iteration: 1 })
    expect(updated.status).toBe('running')
    expect(updated.iteration).toBe(1)
  })

  it('throws when updating with no active task', async () => {
    await expect(manager.update({ status: 'running' })).rejects.toThrow('No active task')
  })

  it('clears the task', async () => {
    await manager.create('Test task', [], 5)
    await manager.clear()
    expect(await manager.load()).toBeNull()
  })

  it('clear on non-existent task does not throw', async () => {
    await expect(manager.clear()).resolves.toBeUndefined()
  })

  it('addCheckpoint appends to checkpoints array', async () => {
    await manager.create('Test task', [], 5)
    const checkpoint = {
      id: 'cp-1',
      iteration: 1,
      timestamp: new Date().toISOString(),
      criteriaResults: [],
      passedIds: ['a'],
      failedIds: ['b'],
    }
    const updated = await manager.addCheckpoint(checkpoint)
    expect(updated.checkpoints).toHaveLength(1)
    expect(updated.checkpoints[0].id).toBe('cp-1')
  })
})

describe('validateTask', () => {
  const good = {
    id: 't', description: 'd', criteria: [{ id: 'c', type: 'command', description: 'x', required: true, config: {} }],
    status: 'pending', iteration: 0, maxIterations: 5, createdAt: 'now', updatedAt: 'now', checkpoints: [], metadata: {},
  }

  it('accepts a well-formed task and defaults metadata', () => {
    const { metadata: _m, ...noMeta } = good
    expect(validateTask(noMeta).metadata).toEqual({})
  })

  it('rejects an empty object with every missing field named', () => {
    expect(() => validateTask({})).toThrow(/id must be/)
    expect(() => validateTask({})).toThrow(/maxIterations must be/)
    expect(() => validateTask({})).toThrow(/status must be one of/)
  })

  it('rejects a missing iteration guard and malformed criteria', () => {
    expect(() => validateTask({ ...good, maxIterations: 0 })).toThrow(/maxIterations/)
    expect(() => validateTask({ ...good, iteration: -1 })).toThrow(/iteration/)
    expect(() => validateTask({ ...good, criteria: [{ id: 'c' }] })).toThrow(/criteria\[0\]/)
    expect(() => validateTask([])).toThrow(/root is not an object/)
  })
})
