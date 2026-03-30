import type { CompletionCriteria, CriteriaResult, ArbiterConfig } from '../../core/types.js'
import { runCritic } from '../../critic/runner.js'

/**
 * Critic criteria evaluator — runs adversarial review personas against code.
 *
 * Config fields (all optional, fall back to ArbiterConfig):
 *   personas: string[]         — which personas to run (default: config.critic.personas)
 *   files: string[] | "git-diff" — which files to review (default: "git-diff")
 *   timeout: number            — per-persona timeout in ms
 */
export async function evaluateCritic(
  criteria: CompletionCriteria,
  cwd: string,
  llmModel: string,
  config: ArbiterConfig,
  taskDescription: string,
): Promise<CriteriaResult> {
  const start = Date.now()
  const cfg = criteria.config ?? {}

  const personaIds = Array.isArray(cfg.personas) && cfg.personas.every((p: unknown) => typeof p === 'string')
    ? cfg.personas as string[]
    : config.critic.personas

  const files: string[] | 'git-diff' | 'all' =
    cfg.files === 'git-diff' || cfg.files === 'all'
      ? cfg.files
      : Array.isArray(cfg.files) && cfg.files.every((f: unknown) => typeof f === 'string')
        ? cfg.files as string[]
        : 'git-diff'

  const timeout = typeof cfg.timeout === 'number'
    ? cfg.timeout
    : undefined

  try {
    const result = await runCritic({
      cwd,
      taskDescription,
      files,
      personaIds,
      customPersonas: config.critic.customPersonas,
      llmModel,
      failOnWarnings: config.critic.failOnWarnings,
      timeout,
    })

    return {
      criteriaId: criteria.id,
      passed: result.passed,
      required: criteria.required,
      description: criteria.description,
      feedback: result.passed ? undefined : result.feedbackText,
      durationMs: Date.now() - start,
    }
  } catch (err: unknown) {
    return {
      criteriaId: criteria.id,
      passed: false,
      required: criteria.required,
      description: criteria.description,
      feedback: `Critic evaluator error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    }
  }
}
