import type { ClaudeStopPayload, CriteriaResult, HookResult } from './types.js'
import { loadConfig } from './config.js'
import { TaskContextManager } from './task-manager.js'
import { CheckpointManager } from './checkpoint-manager.js'
import { CriteriaEvaluator } from '../loop/evaluator.js'

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
 * Build the structured feedback prompt written to stdout on exit 2.
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

export class HookInterface {
  /**
   * Run the stop hook evaluation. This is the main entry point called by
   * Claude Code's stop hook or manually via `arbiter check`.
   *
   * When called programmatically, pass `cwd` to override the working directory
   * and `stdinData` to provide the payload directly (instead of reading stdin).
   */
  async run(opts?: { cwd?: string; stdinData?: string }): Promise<HookResult> {
    const stdinData = opts?.stdinData ?? await readStdin()

    // Parse the stop payload
    let payload: ClaudeStopPayload | null = null
    if (stdinData.trim()) {
      try {
        payload = JSON.parse(stdinData) as ClaudeStopPayload
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

    // Step 2: Load active task. If no task exists, don't interfere.
    const task = await taskManager.load()
    if (!task) {
      process.stderr.write('Arbiter: No active task — allowing stop\n')
      return {
        decision: 'proceed',
        iteration: 0,
        passedCriteria: [],
        failedCriteria: [],
        summary: 'No active task',
      }
    }

    // Step 3: If task is already terminal, exit cleanly.
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

    // Step 4: Check iteration limit.
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

    // Step 5: Increment iteration, set status to running.
    const iteration = task.iteration + 1
    await taskManager.update({ status: 'running', iteration })

    // Step 6: Run all criteria.
    const evaluator = new CriteriaEvaluator(cwd, config.llmModel)
    const results = await evaluator.evaluate(task.criteria, payload ?? undefined)

    // Step 7: Write a checkpoint.
    const checkpointManager = new CheckpointManager(cwd, config.checkpointDir)
    const checkpoint = checkpointManager.buildCheckpoint(iteration, results)
    await checkpointManager.write(checkpoint)
    await taskManager.addCheckpoint(checkpoint)

    const passedCriteria = results.filter(r => r.passed).map(r => r.criteriaId)
    const failedCriteria = results.filter(r => !r.passed).map(r => r.criteriaId)
    const requiredFailures = results.filter(r => !r.passed && r.required)

    // Step 8: All required criteria pass → complete.
    if (requiredFailures.length === 0) {
      await taskManager.update({ status: 'complete' })
      const msg = `Arbiter: All required criteria passed (iteration ${iteration}/${task.maxIterations}) — task complete\n`
      process.stderr.write(msg)
      return {
        decision: 'proceed',
        iteration,
        passedCriteria,
        failedCriteria,
        summary: `All required criteria passed on iteration ${iteration}`,
      }
    }

    // Step 9: Required criteria failed → loop.
    const feedback = formatFeedback(iteration, task.maxIterations, results)
    process.stdout.write(feedback)
    const msg = `Arbiter: ${requiredFailures.length} required criteria failed (iteration ${iteration}/${task.maxIterations}) — looping\n`
    process.stderr.write(msg)

    return {
      decision: 'loop',
      iteration,
      passedCriteria,
      failedCriteria,
      feedback,
      summary: `${requiredFailures.length} required criteria failed on iteration ${iteration}`,
    }
  }
}

/**
 * Entry point for the stop hook process. Handles exit codes:
 *  0 — allow stop
 *  2 — loop (stdout has feedback)
 *  1 — internal error
 */
export async function runHook(opts?: { cwd?: string; stdinData?: string }): Promise<void> {
  try {
    const hook = new HookInterface()
    const result = await hook.run(opts)

    switch (result.decision) {
      case 'proceed':
        process.exitCode = 0
        break
      case 'loop':
        process.exitCode = 2
        break
      case 'error':
        process.exitCode = 1
        break
    }
  } catch (err: unknown) {
    process.stderr.write(`Arbiter internal error: ${(err as Error).message}\n`)
    process.exitCode = 1
  }
}
