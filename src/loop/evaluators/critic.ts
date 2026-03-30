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

  const personaIds = Array.isArray(criteria.config.personas)
    ? criteria.config.personas as string[]
    : config.critic.personas

  const files = (criteria.config.files as string[] | 'git-diff') ?? 'git-diff'

  const timeout = typeof criteria.config.timeout === 'number'
    ? criteria.config.timeout
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
      feedback: `Critic evaluator error: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    }
  }
}
