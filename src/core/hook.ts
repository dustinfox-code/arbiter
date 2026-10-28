import type { StopPayload, CriteriaResult, HookResult, LastStopRecord, TaskContext } from './types.js'
import { loadConfig } from './config.js'
import { TaskContextManager } from './task-manager.js'
import { CheckpointManager } from './checkpoint-manager.js'
import { CriteriaEvaluator } from '../loop/evaluator.js'
import { acquireStopLock, matchesLastStop } from './stop-lock.js'
import { emitForAgent, type AgentId } from './agents.js'

/** How long a second `check` process waits for the first to finish before failing open. */
const DEFAULT_LOCK_TIMEOUT_MS = 110_000
/** Replay window for payloads that carry a session_id but no prompt_id. */
const DEFAULT_REPLAY_WINDOW_MS = 5_000

export interface HookRunOptions {
  cwd?: string
  stdinData?: string
  /** Test seam: shorten the wait for the stop lock. */
  lockTimeoutMs?: number
  /** Test seam: shorten the same-session replay window. */
  replayWindowMs?: number
}

/**
 * Read all of stdin as a string. Returns empty string if stdin is a TTY
 * (i.e., no piped input).
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return ''
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * Build the structured feedback the agent receives when it is sent back to work.
 * This is the `reason` of the block decision, so it must say exactly what failed.
 */
function formatFeedback(
  iteration: number,
  maxIterations: number,
  results: CriteriaResult[],
): string {
  const passed = results.filter(r => r.passed)
  const failedRequired = results.filter(r => !r.passed && r.required)
  const failedOptional = results.filter(r => !r.passed && !r.required)
  const remaining = maxIterations - iteration

  let output = `## Arbiter: Criteria Not Met (Iteration ${iteration}/${maxIterations})\n\n`

  if (passed.length > 0) {
    output += '### Passed\n'
    for (const r of passed) {
      output += `- [${r.criteriaId}] ${r.description}\n`
    }
    output += '\n'
  }

  if (failedRequired.length > 0) {
    output += '### Failed\n'
    for (const r of failedRequired) {
      output += `- [${r.criteriaId}] ${r.description}\n`
      if (r.feedback) {
        output += `  ${r.feedback.split('\n').join('\n  ')}\n`
      }
    }
    output += '\n'
  }

  if (failedOptional.length > 0) {
    output += '### Warnings (non-blocking)\n'
    for (const r of failedOptional) {
      output += `- [${r.criteriaId}] ${r.description}\n`
      if (r.feedback) {
        output += `  ${r.feedback.split('\n').join('\n  ')}\n`
      }
    }
    output += '\n'
  }

  output += '---\n'
  output += 'Fix the failing criteria above and continue working. Do not stop until all required criteria pass.\n'
  output += `You have ${remaining} iteration${remaining === 1 ? '' : 's'} remaining.\n`

  return output
}

function readLastStop(task: TaskContext): LastStopRecord | undefined {
  const candidate = task.metadata?.lastStop
  if (!candidate || typeof candidate !== 'object') return undefined
  const record = candidate as Partial<LastStopRecord>
  if (typeof record.sessionId !== 'string' || typeof record.at !== 'string' || !record.result) return undefined
  return record as LastStopRecord
}

export class HookInterface {
  /**
   * Run the stop hook evaluation. This is the main entry point called by
   * the agent's stop hook or manually via `arbiter-cc check`.
   *
   * When called programmatically, pass `cwd` to override the working directory
   * and `stdinData` to provide the payload directly (instead of reading stdin).
   *
   * Nothing here writes the decision to stdout; `runHook` does that through
   * the agent adapter. Stderr carries human-readable progress only.
   */
  async run(opts?: HookRunOptions): Promise<HookResult> {
    const stdinData = opts?.stdinData ?? await readStdin()
    const lockTimeoutMs = opts?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    const replayWindowMs = opts?.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS

    // Parse the stop payload
    let payload: StopPayload | null = null
    if (stdinData.trim()) {
      try {
        payload = JSON.parse(stdinData) as StopPayload
      } catch {
        process.stderr.write('Arbiter: Failed to parse stop hook payload from stdin\n')
        return {
          decision: 'error',
          iteration: 0,
          passedCriteria: [],
          failedCriteria: [],
          summary: 'Failed to parse stop hook payload',
        }
      }
    }

    const cwd = opts?.cwd ?? payload?.cwd ?? process.cwd()
    const config = await loadConfig(cwd)
    const taskManager = new TaskContextManager(cwd)

    // Load active task. If no task exists, don't interfere — and don't
    // create any files in a project that isn't using Arbiter.
    const initial = await taskManager.load()
    if (!initial) {
      process.stderr.write('Arbiter: No active task — allowing stop\n')
      return {
        decision: 'proceed',
        iteration: 0,
        passedCriteria: [],
        failedCriteria: [],
        summary: 'No active task',
      }
    }

    // Serialise with any other `check` process for this project. Agents run
    // all hooks for an event in parallel, so two wired hooks mean two of us.
    let lock
    try {
      lock = await acquireStopLock(await taskManager.lockPath(), lockTimeoutMs)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Arbiter: ${msg} — failing open\n`)
      return {
        decision: 'error',
        iteration: initial.iteration,
        passedCriteria: [],
        failedCriteria: [],
        summary: 'Could not acquire stop lock',
      }
    }

    try {
      // Re-read under the lock: another process may have just finished.
      const task = (await taskManager.load()) ?? initial

      // Same stop event already answered → replay, don't re-evaluate.
      const lastStop = readLastStop(task)
      if (matchesLastStop(lastStop, payload, Date.now(), replayWindowMs) && lastStop) {
        process.stderr.write(
          `Arbiter: Replaying decision "${lastStop.result.decision}" for stop already evaluated (iteration ${lastStop.result.iteration}/${task.maxIterations})\n`,
        )
        return { ...lastStop.result, replayed: true }
      }

      // If task is already terminal, exit cleanly.
      if (task.status === 'complete' || task.status === 'failed') {
        process.stderr.write(`Arbiter: Task already ${task.status} — allowing stop\n`)
        return {
          decision: 'proceed',
          iteration: task.iteration,
          passedCriteria: [],
          failedCriteria: [],
          summary: `Task already ${task.status}`,
        }
      }

      // Check iteration limit.
      if (task.iteration >= task.maxIterations) {
        await taskManager.update({ status: 'failed' })
        const msg = `Arbiter: Max iterations (${task.maxIterations}) reached — marking task failed\n`
        process.stderr.write(msg)
        return {
          decision: 'proceed',
          iteration: task.iteration,
          passedCriteria: [],
          failedCriteria: [],
          summary: `Max iterations reached (${task.maxIterations})`,
        }
      }

      // Increment iteration, set status to running.
      const iteration = task.iteration + 1
      await taskManager.update({ status: 'running', iteration })

      const stopHookActive = payload?.stop_hook_active === true
      if (stopHookActive) {
        process.stderr.write(`Arbiter: Agent is continuing from an earlier stop hook (iteration ${iteration}/${task.maxIterations})\n`)
      }

      // Run all criteria.
      const evaluator = new CriteriaEvaluator(cwd, config.llmModel, config, task.description)
      const results = await evaluator.evaluate(task.criteria, payload ?? undefined)

      // Write a checkpoint.
      const checkpointManager = new CheckpointManager(cwd, config.checkpointDir)
      const checkpoint = checkpointManager.buildCheckpoint(iteration, results)
      await checkpointManager.write(checkpoint)
      await taskManager.addCheckpoint(checkpoint)

      const passedCriteria = results.filter(r => r.passed).map(r => r.criteriaId)
      const failedCriteria = results.filter(r => !r.passed).map(r => r.criteriaId)
      const requiredFailures = results.filter(r => !r.passed && r.required)

      let result: HookResult
      if (requiredFailures.length === 0) {
        // All required criteria pass → complete.
        await taskManager.update({ status: 'complete' })
        process.stderr.write(
          `Arbiter: All required criteria passed (iteration ${iteration}/${task.maxIterations}) — task complete\n`,
        )
        result = {
          decision: 'proceed',
          iteration,
          passedCriteria,
          failedCriteria,
          summary: `All required criteria passed on iteration ${iteration}`,
        }
      } else {
        // Required criteria failed → loop.
        const feedback = formatFeedback(iteration, task.maxIterations, results)
        process.stderr.write(
          `Arbiter: ${requiredFailures.length} required criteria failed (iteration ${iteration}/${task.maxIterations}) — looping\n`,
        )
        result = {
          decision: 'loop',
          iteration,
          passedCriteria,
          failedCriteria,
          feedback,
          summary: `${requiredFailures.length} required criteria failed on iteration ${iteration}`,
        }
      }

      // Remember this stop so a parallel or repeated hook replays instead of re-running.
      if (payload && typeof payload.session_id === 'string' && payload.session_id) {
        const current = (await taskManager.load()) ?? task
        const record: LastStopRecord = {
          sessionId: payload.session_id,
          promptId: typeof payload.prompt_id === 'string' ? payload.prompt_id : undefined,
          at: new Date().toISOString(),
          stopHookActive,
          result,
        }
        await taskManager.update({ metadata: { ...current.metadata, lastStop: record } })
      }

      return result
    } finally {
      await lock.release()
    }
  }
}

/**
 * Entry point for the stop hook process. Evaluates, then speaks the host
 * agent's dialect on stdout and sets the exit code:
 *  proceed — exit 0, nothing on stdout (stop allowed)
 *  loop    — exit 0, JSON block decision with the feedback as `reason`
 *  error   — exit 1, which agents treat as a non-blocking hook error
 */
export async function runHook(opts?: HookRunOptions & { agent?: AgentId }): Promise<void> {
  try {
    const hook = new HookInterface()
    const result = await hook.run(opts)
    const emission = emitForAgent(result, opts?.agent ?? 'claude')
    if (emission.stdout) {
      process.stdout.write(emission.stdout + '\n')
    }
    process.exitCode = emission.exitCode
  } catch (err: unknown) {
    process.stderr.write(`Arbiter internal error: ${(err as Error).message}\n`)
    process.exitCode = 1
  }
}
