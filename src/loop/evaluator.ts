import type { CompletionCriteria, CriteriaResult, ClaudeStopPayload } from '../core/types.js'
import { pooled } from '../core/pool.js'
import { evaluateCommand } from './evaluators/command.js'
import { evaluateTestsPass } from './evaluators/tests-pass.js'
import { evaluateNoTsErrors } from './evaluators/no-ts-errors.js'
import { evaluateFileExists } from './evaluators/file-exists.js'
import { evaluateLlm } from './evaluators/llm.js'
import { evaluateCustom } from './evaluators/custom.js'

const CONCURRENCY = 3

export class CriteriaEvaluator {
  private cwd: string
  private llmModel: string

  constructor(cwd: string, llmModel: string) {
    this.cwd = cwd
    this.llmModel = llmModel
  }

  /**
   * Dispatch a single criterion to the appropriate evaluator.
   */
  private async evaluateOne(
    criteria: CompletionCriteria,
    payload?: ClaudeStopPayload,
  ): Promise<CriteriaResult> {
    switch (criteria.type) {
      case 'command':
        return evaluateCommand(criteria, this.cwd)
      case 'tests-pass':
        return evaluateTestsPass(criteria, this.cwd)
      case 'no-ts-errors':
        return evaluateNoTsErrors(criteria, this.cwd)
      case 'file-exists':
        return evaluateFileExists(criteria, this.cwd)
      case 'llm':
        return evaluateLlm(criteria, this.cwd, this.llmModel)
      case 'custom':
        return evaluateCustom(criteria, this.cwd, payload)
      default:
        return {
          criteriaId: criteria.id,
          passed: false,
          required: criteria.required,
          description: criteria.description,
          feedback: `Unknown criteria type: ${criteria.type as string}`,
          durationMs: 0,
        }
    }
  }

  /**
   * Evaluate all criteria with bounded concurrency. Each evaluator is
   * isolated — one throwing does not prevent others from running.
   */
  async evaluate(
    criteria: CompletionCriteria[],
    payload?: ClaudeStopPayload,
  ): Promise<CriteriaResult[]> {
    const tasks = criteria.map(
      (c) => async (): Promise<CriteriaResult> => {
        try {
          return await this.evaluateOne(c, payload)
        } catch (err: unknown) {
          return {
            criteriaId: c.id,
            passed: false,
            required: c.required,
            description: c.description,
            feedback: `Evaluator error: ${(err as Error).message}`,
            durationMs: 0,
          }
        }
      },
    )

    return pooled(tasks, CONCURRENCY)
  }
}
