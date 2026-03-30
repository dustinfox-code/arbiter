import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { execSync } from 'node:child_process'
import type { CompletionCriteria, CriteriaResult } from '../../core/types.js'

interface LlmEvaluationResponse {
  passed: boolean
  feedback: string | null
}

/**
 * Validate that a resolved path is within the given base directory.
 */
function isPathContained(base: string, target: string): boolean {
  const resolvedBase = resolve(base)
  const resolvedTarget = resolve(target)
  return resolvedTarget.startsWith(resolvedBase + sep) || resolvedTarget === resolvedBase
}

/**
 * Resolve which files to include as context for the LLM evaluator.
 * Validates that all paths stay within cwd.
 */
async function resolveContextFiles(
  files: unknown,
  cwd: string,
): Promise<{ path: string; content: string }[]> {
  if (!files) return []

  if (files === 'git-diff') {
    try {
      const output = execSync('git diff --name-only HEAD~1', {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      const paths = output.split('\n').filter(Boolean)
      return resolveContextFiles(paths, cwd)
    } catch {
      return []
    }
  }

  if (Array.isArray(files)) {
    const results: { path: string; content: string }[] = []
    for (const filePath of files as string[]) {
      const resolvedPath = resolve(cwd, filePath)
      if (!isPathContained(cwd, resolvedPath)) {
        results.push({ path: filePath, content: `[Skipped: path escapes project directory]` })
        continue
      }
      try {
        const content = await readFile(resolvedPath, 'utf-8')
        results.push({ path: filePath, content })
      } catch {
        results.push({ path: filePath, content: `[File not readable: ${filePath}]` })
      }
    }
    return results
  }

  return []
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
  const start = Date.now()
  const prompt = criteria.config.prompt as string
  const files = criteria.config.files
  const timeout = (criteria.config.timeout as number) ?? 30000

  if (!prompt) {
    return {
      criteriaId: criteria.id,
      passed: false,
      required: criteria.required,
      description: criteria.description,
      feedback: 'llm criterion is missing "prompt" in config',
      durationMs: Date.now() - start,
    }
  }

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

    let timer: ReturnType<typeof setTimeout>
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
    ]).finally(() => clearTimeout(timer!))

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
      feedback: `LLM evaluator error: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    }
  }
}
