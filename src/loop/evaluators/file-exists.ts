import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompletionCriteria, CriteriaResult } from '../../core/types.js'

/**
 * Check that a file or path exists.
 * Config: { path: string }
 */
export async function evaluateFileExists(
  criteria: CompletionCriteria,
  cwd: string,
): Promise<CriteriaResult> {
  const start = Date.now()
  const filePath = criteria.config.path as string

  if (!filePath) {
    return {
      criteriaId: criteria.id,
      passed: false,
      required: criteria.required,
      description: criteria.description,
      feedback: 'file-exists criterion is missing "path" in config',
      durationMs: Date.now() - start,
    }
  }

  const resolvedPath = join(cwd, filePath)

  try {
    await access(resolvedPath)
    return {
      criteriaId: criteria.id,
      passed: true,
      required: criteria.required,
      description: criteria.description,
      durationMs: Date.now() - start,
    }
  } catch {
    return {
      criteriaId: criteria.id,
      passed: false,
      required: criteria.required,
      description: criteria.description,
      feedback: `File not found: ${filePath}`,
      durationMs: Date.now() - start,
    }
  }
}
