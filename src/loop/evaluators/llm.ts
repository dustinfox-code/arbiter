import type { CompletionCriteria, CriteriaResult } from '../../core/types.js'
import { resolveContextFiles } from '../../core/files.js'

interface LlmEvaluationResponse {
  passed: boolean
  feedback: string | null
}

/**
 * Call the Anthropic API with a user-supplied prompt and optional context files.
 * Expects a structured JSON response { passed: boolean, feedback: string | null }.
 * Config: { prompt: string, files?: string[] | "git-diff", model?: string, timeout?: number }
 */
export async function evaluateLlm(
  criteria: CompletionCriteria,
  cwd: string,
  llmModel: string,
): Promise<CriteriaResult> {
  if (criteria.config.prompt === undefined || criteria.config.prompt === null) {
    throw new Error("llm criteria requires a 'prompt' config field (string)")
  }
  if (typeof criteria.config.prompt !== 'string') {
    throw new Error(`llm criteria 'prompt' must be a string, got ${typeof criteria.config.prompt}`)
  }
  if (criteria.config.prompt === '') {
    throw new Error("llm criteria 'prompt' must be a non-empty string")
  }
  if (criteria.config.files !== undefined && criteria.config.files !== null) {
    if (criteria.config.files !== 'git-diff' && !Array.isArray(criteria.config.files)) {
      throw new Error("llm criteria 'files' must be a string[] or \"git-diff\" if provided")
    }
  }
  if (criteria.config.model !== undefined && criteria.config.model !== null && typeof criteria.config.model !== 'string') {
    throw new Error(`llm criteria 'model' must be a string if provided, got ${typeof criteria.config.model}`)
  }
  if (criteria.config.timeout !== undefined && criteria.config.timeout !== null && typeof criteria.config.timeout !== 'number') {
    throw new Error(`llm criteria 'timeout' must be a number if provided, got ${typeof criteria.config.timeout}`)
  }

  const start = Date.now()
  const prompt = criteria.config.prompt
  const files = criteria.config.files
  const timeout = (criteria.config.timeout as number) ?? 30000

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      criteriaId: criteria.id,
      passed: false,
      required: criteria.required,
      description: criteria.description,
      feedback:
        'LLM evaluator cannot run: ANTHROPIC_API_KEY is not set. Set it in your environment or skip this criterion.',
      durationMs: Date.now() - start,
    }
  }

  try {
    // Dynamic import to avoid requiring the SDK at module load time
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ maxRetries: 2 })

    const contextFiles = await resolveContextFiles(files, cwd)
    let userMessage = `## Criterion\n${criteria.description}\n\n## Evaluation Prompt\n${prompt}`
    if (contextFiles.length > 0) {
      userMessage += '\n\n## Context Files\n'
      for (const file of contextFiles) {
        userMessage += `\n### ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n`
      }
    }

    const model = (criteria.config.model as string) || llmModel

    let timer: ReturnType<typeof setTimeout> | undefined
    const response = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 1024,
        system:
          'You are evaluating whether code meets a specific criterion. Respond with JSON matching this exact schema: { "passed": boolean, "feedback": string | null }. If the criterion is met, set passed to true and feedback to null. If not met, set passed to false and feedback to a specific, actionable explanation of what is not met and what needs to change. Do not include any text outside the JSON object.',
        messages: [{ role: 'user', content: userMessage }],
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('LLM evaluation timed out')), timeout)
      }),
    ]).finally(() => clearTimeout(timer))

    if (!response.content || response.content.length === 0) {
      return {
        criteriaId: criteria.id,
        passed: false,
        required: criteria.required,
        description: criteria.description,
        feedback: 'LLM evaluator returned empty response',
        durationMs: Date.now() - start,
      }
    }

    const content = response.content[0]
    if (content.type !== 'text') {
      return {
        criteriaId: criteria.id,
        passed: false,
        required: criteria.required,
        description: criteria.description,
        feedback: 'LLM evaluator returned unexpected response type',
        durationMs: Date.now() - start,
      }
    }

    let parsed: LlmEvaluationResponse
    try {
      parsed = JSON.parse(content.text) as LlmEvaluationResponse
    } catch {
      return {
        criteriaId: criteria.id,
        passed: false,
        required: criteria.required,
        description: criteria.description,
        feedback: `LLM evaluator returned unparseable response: ${content.text.slice(0, 500)}`,
        durationMs: Date.now() - start,
      }
    }

    return {
      criteriaId: criteria.id,
      passed: parsed.passed,
      required: criteria.required,
      description: criteria.description,
      feedback: parsed.feedback ?? undefined,
      durationMs: Date.now() - start,
    }
  } catch (err: unknown) {
    return {
      criteriaId: criteria.id,
      passed: false,
      required: criteria.required,
      description: criteria.description,
      feedback: `LLM evaluator error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    }
  }
}
