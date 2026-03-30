import { execFile } from 'node:child_process'
import type { CompletionCriteria, CriteriaResult } from '../../core/types.js'

const FAILURE_MARKERS = [
  /\bFAIL\b/i,
  /\bError:/,
  /\bAssertionError\b/,
  /\bexpected\b/i,
  /\bnot ok\b/,
  /[✕✗×]/,
  /\bfailing\b/i,
  /\bfailed\b/i,
]

/**
 * Extract failure-relevant lines from test output.
 * Tier 1: heuristic extraction of lines near failure markers.
 * Tier 2: fallback to last 30 lines if heuristics produce nothing useful.
 */
function extractFailureLines(output: string): string {
  const lines = output.split('\n')

  // Tier 1: find lines matching failure markers with context
  const matchedLineIndices = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (FAILURE_MARKERS.some(marker => marker.test(lines[i]))) {
      // Include 2 lines before and 1 after for context
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 1); j++) {
        matchedLineIndices.add(j)
      }
    }
  }

  // Always include the last 5 lines (usually the summary)
  for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) {
    matchedLineIndices.add(i)
  }

  const extracted = [...matchedLineIndices]
    .sort((a, b) => a - b)
    .map(i => lines[i])
    .filter(line => line.trim().length > 0)

  // Tier 2: if heuristics produced very little or too much
  if (extracted.length <= 5) {
    // Heuristics didn't find much — fall back to tail
    return lines.slice(-30).join('\n').trim()
  }
  if (extracted.length > 50) {
    return lines.slice(-30).join('\n').trim()
  }

  return extracted.join('\n')
}

/**
 * Run the project's test suite. Pass = exit 0.
 * Config: { command?: string }
 */
export async function evaluateTestsPass(
  criteria: CompletionCriteria,
  cwd: string,
): Promise<CriteriaResult> {
  const start = Date.now()
  const command = (criteria.config.command as string) || 'npm test'

  return new Promise<CriteriaResult>((resolve) => {
    execFile('sh', ['-c', command], { cwd, timeout: 120000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start
      if (error) {
        const fullOutput = (stdout + '\n' + stderr).trim()
        const failureLines = extractFailureLines(fullOutput)
        const feedback = `Tests failed (exit ${error.code ?? 'unknown'}):\n${failureLines}`

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
