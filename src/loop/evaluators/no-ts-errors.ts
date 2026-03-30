import { execFile } from 'node:child_process'
import type { CompletionCriteria, CriteriaResult } from '../../core/types.js'

/**
 * Run `tsc --noEmit`. Pass = exit 0 (no type errors).
 * Config: { tsconfigPath?: string }
 */
export async function evaluateNoTsErrors(
  criteria: CompletionCriteria,
  cwd: string,
): Promise<CriteriaResult> {
  if (criteria.config.tsconfigPath !== undefined && criteria.config.tsconfigPath !== null && typeof criteria.config.tsconfigPath !== 'string') {
    throw new Error(`no-ts-errors criteria 'tsconfigPath' must be a string if provided, got ${typeof criteria.config.tsconfigPath}`)
  }
  if (typeof criteria.config.tsconfigPath === 'string' && criteria.config.tsconfigPath === '') {
    throw new Error("no-ts-errors criteria 'tsconfigPath' must be a non-empty string if provided")
  }

  const start = Date.now()
  const tsconfigPath = criteria.config.tsconfigPath as string | undefined
  const args = ['--noEmit']
  if (tsconfigPath) {
    args.push('--project', tsconfigPath)
  }

  return new Promise<CriteriaResult>((resolve) => {
    execFile('npx', ['tsc', ...args], { cwd, timeout: 60000 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start
      if (error) {
        const output = (stdout + '\n' + stderr).trim()
        // tsc outputs errors to stdout
        const errorLines = output.split('\n').filter(line => line.includes('error TS'))
        const errorCount = errorLines.length
        const feedback = errorCount > 0
          ? `TypeScript found ${errorCount} error${errorCount === 1 ? '' : 's'}:\n${errorLines.slice(0, 20).join('\n')}${errorCount > 20 ? `\n... and ${errorCount - 20} more` : ''}`
          : `tsc failed:\n${output.slice(-1000)}`

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
