import { execFile } from 'node:child_process'
import type { CompletionCriteria, CriteriaResult } from '../../core/types.js'

/**
 * Run an arbitrary shell command. Pass = exit 0.
 * Config: { command: string }
 */
export async function evaluateCommand(
  criteria: CompletionCriteria,
  cwd: string,
): Promise<CriteriaResult> {
  if (criteria.config.command === undefined || criteria.config.command === null) {
    throw new Error("command criteria requires a 'command' config field (string)")
  }
  if (typeof criteria.config.command !== 'string') {
    throw new Error(`command criteria 'command' must be a string, got ${typeof criteria.config.command}`)
  }
  if (criteria.config.command === '') {
    throw new Error("command criteria 'command' must be a non-empty string")
  }

  const start = Date.now()
  const command = criteria.config.command

  return new Promise<CriteriaResult>((resolve) => {
    execFile('sh', ['-c', command], { cwd, timeout: 60000 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start
      if (error) {
        const output = (stdout + '\n' + stderr).trim()
        const feedback = output
          ? `Command failed (exit ${error.code ?? 'unknown'}):\n${output.slice(-2000)}`
          : `Command failed with exit code ${error.code ?? 'unknown'}`

        resolve({
          criteriaId: criteria.id,
          passed: false,
          required: criteria.required,
          description: criteria.description,
          feedback,
          durationMs,
        })
      } else {
        resolve({
          criteriaId: criteria.id,
          passed: true,
          required: criteria.required,
          description: criteria.description,
          durationMs,
        })
      }
    })
  })
}
