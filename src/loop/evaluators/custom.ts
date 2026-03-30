import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CompletionCriteria, CriteriaResult, ClaudeStopPayload } from '../../core/types.js'

const CUSTOM_TIMEOUT_MS = 30000

/**
 * Load and execute a user-supplied .js module.
 * The module must export a default async function with signature:
 *   (criteria, payload, cwd) => { passed: boolean, feedback?: string }
 *
 * Config: { path: string }
 */
export async function evaluateCustom(
  criteria: CompletionCriteria,
  cwd: string,
  payload?: ClaudeStopPayload,
): Promise<CriteriaResult> {
  if (criteria.config.path === undefined || criteria.config.path === null) {
    throw new Error("custom criteria requires a 'path' config field (string)")
  }
  if (typeof criteria.config.path !== 'string') {
    throw new Error(`custom criteria 'path' must be a string, got ${typeof criteria.config.path}`)
  }
  if (criteria.config.path === '') {
    throw new Error("custom criteria 'path' must be a non-empty string")
  }

  const start = Date.now()
  const modulePath = criteria.config.path

  try {
    const resolvedPath = resolve(cwd, modulePath)
    const resolvedCwd = resolve(cwd)
    if (!resolvedPath.startsWith(resolvedCwd + sep) && resolvedPath !== resolvedCwd) {
      return {
        criteriaId: criteria.id,
        passed: false,
        required: criteria.required,
        description: criteria.description,
        feedback: `Custom evaluator path escapes project directory: ${modulePath}`,
        durationMs: Date.now() - start,
      }
    }

    const moduleUrl = pathToFileURL(resolvedPath).href
    const mod = await import(moduleUrl)

    const evaluate = mod.default
    if (typeof evaluate !== 'function') {
      return {
        criteriaId: criteria.id,
        passed: false,
        required: criteria.required,
        description: criteria.description,
        feedback: `Custom evaluator at ${modulePath} does not export a default function`,
        durationMs: Date.now() - start,
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      evaluate(criteria, payload, cwd),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Custom evaluator timed out after 30s')), CUSTOM_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(timer))

    return {
      criteriaId: criteria.id,
      passed: Boolean(result.passed),
      required: criteria.required,
      description: criteria.description,
      feedback: result.feedback ?? undefined,
      durationMs: Date.now() - start,
    }
  } catch (err: unknown) {
    return {
      criteriaId: criteria.id,
      passed: false,
      required: criteria.required,
      description: criteria.description,
      feedback: `Custom evaluator error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    }
  }
}
