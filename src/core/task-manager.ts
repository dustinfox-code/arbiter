import { readFile, writeFile, mkdir, unlink, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TaskContext, CompletionCriteria, Checkpoint } from './types.js'
import { loadConfig } from './config.js'

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
    try {
      const raw = await readFile(filePath, 'utf-8')
      return JSON.parse(raw) as TaskContext
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw new Error(
        `Failed to parse task file: ${(err as Error).message}`,
      )
    }
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
    try {
      await unlink(filePath)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }
  }
}
