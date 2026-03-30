import { access } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { CompletionCriteria, CriteriaResult } from '../../core/types.js'

/**
 * Check that a file or path exists.
 * Config: { path: string }
 */
export async function evaluateFileExists(
  criteria: CompletionCriteria,
  cwd: string,
): Promise<CriteriaResult> {
  if (criteria.config.path === undefined || criteria.config.path === null) {
    throw new Error("file-exists criteria requires a 'path' config field (string)")
  }
  if (typeof criteria.config.path !== 'string') {
    throw new Error(`file-exists criteria 'path' must be a string, got ${typeof criteria.config.path}`)
  }
  if (criteria.config.path === '') {
    throw new Error("file-exists criteria 'path' must be a non-empty string")
  }

  const start = Date.now()
  const filePath = criteria.config.path

  const resolvedPath = resolve(cwd, filePath)
  const resolvedCwd = resolve(cwd)
  if (!resolvedPath.startsWith(resolvedCwd + sep) && resolvedPath !== resolvedCwd) {
    return {
      criteriaId: criteria.id,
      passed: false,
      required: criteria.required,
      description: criteria.description,
      feedback: `Path escapes project directory: ${filePath}`,
      durationMs: Date.now() - start,
    }
  }

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
