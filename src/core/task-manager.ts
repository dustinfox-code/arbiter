import { readFile, writeFile, mkdir, unlink, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TaskContext, CompletionCriteria, Checkpoint } from './types.js'
import { loadConfig } from './config.js'

const TASK_STATUSES = new Set(['pending', 'running', 'complete', 'failed', 'abandoned'])

/**
 * Check the fields the hook relies on. A hand-edited task.json missing
 * `maxIterations` would otherwise disable the iteration guard silently.
 */
export function validateTask(value: unknown, source = 'task.json'): TaskContext {
  const problems: string[] = []
  const t = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  if (!value || typeof value !== 'object' || Array.isArray(value)) problems.push('root is not an object')
  if (typeof t.id !== 'string' || !t.id) problems.push('id must be a non-empty string')
  if (typeof t.description !== 'string') problems.push('description must be a string')
  if (!Array.isArray(t.criteria)) problems.push('criteria must be an array')
  else {
    t.criteria.forEach((c, i) => {
      const cr = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
      if (typeof cr.id !== 'string' || typeof cr.type !== 'string' || typeof cr.required !== 'boolean') {
        problems.push(`criteria[${i}] needs string id, string type, boolean required`)
      }
    })
  }
  if (typeof t.status !== 'string' || !TASK_STATUSES.has(t.status)) problems.push(`status must be one of ${[...TASK_STATUSES].join(', ')}`)
  if (!Number.isInteger(t.iteration) || (t.iteration as number) < 0) problems.push('iteration must be a non-negative integer')
  if (!Number.isInteger(t.maxIterations) || (t.maxIterations as number) < 1) problems.push('maxIterations must be a positive integer')
  if (!Array.isArray(t.checkpoints)) problems.push('checkpoints must be an array')
  if (t.metadata !== undefined && (!t.metadata || typeof t.metadata !== 'object' || Array.isArray(t.metadata))) problems.push('metadata must be an object')
  if (problems.length > 0) {
    throw new Error(`Invalid ${source}: ${problems.join('; ')}`)
  }
  if (t.metadata === undefined) t.metadata = {}
  return t as unknown as TaskContext
}

export class TaskContextManager {
  private cwd: string
  private taskFilePath: string | null = null

  constructor(cwd: string) {
    this.cwd = cwd
  }

  private async getTaskFilePath(): Promise<string> {
    if (!this.taskFilePath) {
      const config = await loadConfig(this.cwd)
      this.taskFilePath = join(this.cwd, config.taskFile)
    }
    return this.taskFilePath
  }

  /**
   * Path of the lock file that serialises concurrent stop-hook evaluations.
   * Lives next to the task file so it is cleaned up with `task clear`.
   */
  async lockPath(): Promise<string> {
    return (await this.getTaskFilePath()) + '.lock'
  }

  async exists(): Promise<boolean> {
    const filePath = await this.getTaskFilePath()
    try {
      await access(filePath)
      return true
    } catch {
      return false
    }
  }

  async load(): Promise<TaskContext | null> {
    const filePath = await this.getTaskFilePath()
    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err: unknown) {
      throw new Error(`Failed to parse task file: ${(err as Error).message}`)
    }
    return validateTask(parsed, filePath)
  }

  async save(task: TaskContext): Promise<void> {
    const filePath = await this.getTaskFilePath()
    await mkdir(dirname(filePath), { recursive: true })
    task.updatedAt = new Date().toISOString()
    await writeFile(filePath, JSON.stringify(task, null, 2), 'utf-8')
  }

  async create(
    description: string,
    criteria: CompletionCriteria[],
    maxIterations: number,
  ): Promise<TaskContext> {
    const now = new Date().toISOString()
    const task: TaskContext = {
      id: randomUUID(),
      description,
      criteria,
      status: 'pending',
      iteration: 0,
      maxIterations,
      createdAt: now,
      updatedAt: now,
      checkpoints: [],
      metadata: {},
    }
    await this.save(task)
    return task
  }

  async update(
    partial: Partial<Pick<TaskContext, 'status' | 'iteration' | 'metadata' | 'criteria' | 'checkpoints'>>,
  ): Promise<TaskContext> {
    const task = await this.load()
    if (!task) {
      throw new Error('No active task to update')
    }
    Object.assign(task, partial)
    await this.save(task)
    return task
  }

  async addCheckpoint(checkpoint: Checkpoint): Promise<TaskContext> {
    const task = await this.load()
    if (!task) {
      throw new Error('No active task to add checkpoint to')
    }
    task.checkpoints.push(checkpoint)
    await this.save(task)
    return task
  }

  async clear(): Promise<void> {
    const filePath = await this.getTaskFilePath()
    for (const target of [filePath, filePath + '.lock']) {
      try {
        await unlink(target)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err
        }
      }
    }
  }
}
