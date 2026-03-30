import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { execSync } from 'node:child_process'
import type { Checkpoint, CriteriaResult } from './types.js'

/** Validate that a path does not escape the base directory via traversal. */
function assertPathContained(base: string, target: string): void {
  const resolvedBase = resolve(base)
  const resolvedTarget = resolve(target)
  if (!resolvedTarget.startsWith(resolvedBase + sep) && resolvedTarget !== resolvedBase) {
    throw new Error(`Path escapes base directory: ${target}`)
  }
}

export class CheckpointManager {
  private cwd: string
  private checkpointDir: string

  constructor(cwd: string, checkpointDir: string) {
    this.cwd = cwd
    this.checkpointDir = join(cwd, checkpointDir)
  }

  /**
   * Attempt to capture the current git HEAD hash. Returns undefined if
   * the project is not in a git repo or git is not available.
   */
  getGitHash(): string | undefined {
    try {
      return execSync('git rev-parse HEAD', {
        cwd: this.cwd,
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    } catch {
      return undefined
    }
  }

  /**
   * Create a checkpoint from criteria results for the given iteration.
   */
  buildCheckpoint(iteration: number, criteriaResults: CriteriaResult[]): Checkpoint {
    const now = new Date()
    const compactTimestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    const id = `checkpoint-${iteration}-${compactTimestamp}`

    return {
      id,
      iteration,
      timestamp: now.toISOString(),
      gitHash: this.getGitHash(),
      criteriaResults,
      passedIds: criteriaResults.filter(r => r.passed).map(r => r.criteriaId),
      failedIds: criteriaResults.filter(r => !r.passed).map(r => r.criteriaId),
    }
  }

  /**
   * Write a checkpoint to disk as an individual JSON file.
   */
  async write(checkpoint: Checkpoint): Promise<void> {
    await mkdir(this.checkpointDir, { recursive: true })
    const filePath = join(this.checkpointDir, `${checkpoint.id}.json`)
    await writeFile(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8')
  }

  /**
   * List all checkpoints, sorted by iteration (ascending).
   */
  async list(): Promise<Checkpoint[]> {
    try {
      const files = await readdir(this.checkpointDir)
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort()

      const checkpoints: Checkpoint[] = []
      for (const file of jsonFiles) {
        const raw = await readFile(join(this.checkpointDir, file), 'utf-8')
        checkpoints.push(JSON.parse(raw) as Checkpoint)
      }

      return checkpoints.sort((a, b) => a.iteration - b.iteration)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
  }

  /**
   * Retrieve a checkpoint by its id.
   */
  async getById(id: string): Promise<Checkpoint | null> {
    try {
      const filePath = join(this.checkpointDir, `${id}.json`)
      assertPathContained(this.checkpointDir, filePath)
      const raw = await readFile(filePath, 'utf-8')
      return JSON.parse(raw) as Checkpoint
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  /**
   * Prune checkpoints to keep only the last N. Removes oldest files first.
   */
  async prune(keepLast: number = 10): Promise<number> {
    const checkpoints = await this.list()
    if (checkpoints.length <= keepLast) return 0

    const toRemove = checkpoints.slice(0, checkpoints.length - keepLast)
    for (const cp of toRemove) {
      const filePath = join(this.checkpointDir, `${cp.id}.json`)
      try {
        await unlink(filePath)
      } catch {
        // File may already be gone — ignore
      }
    }

    return toRemove.length
  }
}
