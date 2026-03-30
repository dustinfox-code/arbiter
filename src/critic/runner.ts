import type { CustomPersonaConfig, ReviewResult, Finding } from '../core/types.js'
import { resolveContextFiles } from '../core/files.js'
import { resolvePersonas, type PersonaDefinition } from './personas.js'
import { pooled } from '../core/pool.js'

const CONCURRENCY = 3
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_FILE_LINES = 500
const MAX_TOTAL_CHARS = 100_000

export interface CriticRunOptions {
  cwd: string
  taskDescription: string
  files: string[] | 'git-diff' | 'all'
  personaIds: string[]
  customPersonas: CustomPersonaConfig[]
  llmModel: string
  failOnWarnings: boolean
  timeout?: number
}

export interface CriticRunResult {
  results: ReviewResult[]
  passed: boolean
  feedbackText: string
}

interface ParsedPersonaResponse {
  findings: Finding[]
  summary: string
}

/**
 * Try to parse JSON from LLM response text. Falls back to extracting
 * from a markdown code fence if direct parse fails.
 */
function parsePersonaResponse(text: string): ParsedPersonaResponse {
  // Try direct parse first
  try {
    const parsed = JSON.parse(text) as ParsedPersonaResponse
    if (Array.isArray(parsed.findings) && typeof parsed.summary === 'string') {
      return parsed
    }
  } catch {
    // Fall through to code fence extraction
  }

  // Try extracting from ```json ... ``` fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]) as ParsedPersonaResponse
      if (Array.isArray(parsed.findings) && typeof parsed.summary === 'string') {
        return parsed
      }
    } catch {
      // Fall through to error
    }
  }

  throw new Error(`Failed to parse persona response as JSON (response length: ${text.length} chars)`)
}

/**
 * Truncate file content to MAX_FILE_LINES to avoid blowing the context window.
 */
function truncateContent(content: string): string {
  const lines = content.split('\n')
  if (lines.length <= MAX_FILE_LINES) return content
  return lines.slice(0, MAX_FILE_LINES).join('\n') + `\n[... truncated at ${MAX_FILE_LINES} lines, ${lines.length} total]`
}

/**
 * Build the user message containing task description and file contents.
 */
function buildUserMessage(
  taskDescription: string,
  contextFiles: { path: string; content: string }[],
): string {
  let msg = `## Task Description\n${taskDescription}\n\n## Files to Review\n`
  if (contextFiles.length === 0) {
    msg += '\nNo files provided for review.\n'
  } else {
    let totalChars = msg.length
    let included = 0
    for (const file of contextFiles) {
      const truncated = truncateContent(file.content)
      const block = `\n### ${file.path}\n\`\`\`\n${truncated}\n\`\`\`\n`
      if (totalChars + block.length > MAX_TOTAL_CHARS && included > 0) {
        msg += `\n[... ${contextFiles.length - included} more file(s) omitted — total context budget exceeded]\n`
        break
      }
      msg += block
      totalChars += block.length
      included++
    }
  }
  return msg
}

/**
 * Validate and normalize findings from the LLM response.
 */
function normalizeFindings(findings: unknown[]): Finding[] {
  return findings
    .filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object')
    .map((f) => ({
      severity: (['error', 'warning', 'info'].includes(f.severity as string)
        ? f.severity
        : 'info') as Finding['severity'],
      location: typeof f.location === 'string' ? f.location : undefined,
      message: typeof f.message === 'string' ? f.message : 'No message provided',
      suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
    }))
}

/**
 * Run a single persona review against the provided context.
 */
async function runPersona(
  persona: PersonaDefinition,
  userMessage: string,
  client: { messages: { create: (params: Record<string, unknown>) => Promise<Record<string, unknown>> } },
  model: string,
  timeout: number,
): Promise<ReviewResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 4096,
        system: persona.systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Critic persona timed out')), timeout)
      }),
    ]).finally(() => clearTimeout(timer))

    if (!response || typeof response !== 'object' || !('content' in response)) {
      return {
        passed: false,
        persona: persona.id,
        findings: [{ severity: 'error', message: 'Persona returned unexpected response shape' }],
        summary: 'Persona returned unexpected response shape',
      }
    }

    const content = (response as { content: Array<{ type: string; text: string }> }).content
    if (!content || content.length === 0 || content[0].type !== 'text') {
      return {
        passed: false,
        persona: persona.id,
        findings: [{ severity: 'error', message: 'Persona returned empty or non-text response' }],
        summary: 'Persona returned empty or non-text response',
      }
    }

    const parsed = parsePersonaResponse(content[0].text)
    const findings = normalizeFindings(parsed.findings)

    return {
      passed: !findings.some(f => f.severity === 'error'),
      persona: persona.id,
      findings,
      summary: parsed.summary,
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      passed: false,
      persona: persona.id,
      findings: [{ severity: 'error', message: `Persona error: ${errMsg}` }],
      summary: `Persona failed: ${errMsg}`,
    }
  }
}

/**
 * Format critic results as a markdown feedback string for Claude.
 */
function formatCriticFeedback(results: ReviewResult[]): string {
  let output = '## Critic Review Findings\n\n'
  let totalErrors = 0
  let totalWarnings = 0

  for (const result of results) {
    const errors = result.findings.filter(f => f.severity === 'error')
    const warnings = result.findings.filter(f => f.severity === 'warning')
    const infos = result.findings.filter(f => f.severity === 'info')
    totalErrors += errors.length
    totalWarnings += warnings.length

    const status = result.passed ? 'PASSED' : 'FAILED'
    output += `### ${result.persona} (${status})\n`

    if (result.findings.length === 0) {
      output += 'No issues found.\n\n'
      continue
    }

    for (const group of [
      { label: 'ERROR', items: errors },
      { label: 'WARN', items: warnings },
      { label: 'INFO', items: infos },
    ]) {
      for (const f of group.items) {
        const loc = f.location ? ` ${f.location}` : ''
        output += `- **[${group.label}]**${loc} — ${f.message}\n`
        if (f.suggestion) {
          output += `  Fix: ${f.suggestion}\n`
        }
      }
    }
    output += '\n'
  }

  output += '---\n'
  if (totalErrors > 0) {
    output += `${totalErrors} error(s), ${totalWarnings} warning(s) across ${results.length} personas.\n`
    output += 'Fix the error-severity findings above before proceeding.\n'
  } else if (totalWarnings > 0) {
    output += `${totalWarnings} warning(s) across ${results.length} personas. No errors.\n`
  } else {
    output += 'All personas passed with no issues.\n'
  }

  return output
}

/**
 * Run the critic: resolve personas, gather files, call LLM for each
 * persona in parallel, and return aggregated results.
 */
export async function runCritic(options: CriticRunOptions): Promise<CriticRunResult> {
  const {
    cwd,
    taskDescription,
    files,
    personaIds,
    customPersonas,
    llmModel,
    failOnWarnings,
    timeout = DEFAULT_TIMEOUT_MS,
  } = options

  // Resolve personas
  const personas = resolvePersonas(personaIds, customPersonas)

  // Gather context files
  let contextFiles = await resolveContextFiles(files, cwd)

  // For the hallucinations persona, always include package.json
  const hasHallucinations = personaIds.includes('hallucinations')
  if (hasHallucinations && !contextFiles.some(f => f.path === 'package.json')) {
    const pkgFiles = await resolveContextFiles(['package.json'], cwd)
    contextFiles = [...contextFiles, ...pkgFiles]
  }

  // Check for API key before making calls
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      results: personas.map(p => ({
        passed: false,
        persona: p.id,
        findings: [{ severity: 'error' as const, message: 'ANTHROPIC_API_KEY is not set' }],
        summary: 'Cannot run critic without ANTHROPIC_API_KEY',
      })),
      passed: false,
      feedbackText: '## Critic Review\n\nCannot run: ANTHROPIC_API_KEY is not set.\n',
    }
  }

  // Dynamic import of SDK — once, shared across all persona tasks
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ maxRetries: 2 })

  // Build the shared user message
  const userMessage = buildUserMessage(taskDescription, contextFiles)

  // Run personas in parallel with bounded concurrency
  const tasks = personas.map(
    (persona) => async (): Promise<ReviewResult> =>
      runPersona(persona, userMessage, client as never, llmModel, timeout),
  )
  const results = await pooled(tasks, CONCURRENCY)

  // Determine overall pass/fail
  const passed = results.every(r => {
    if (!r.passed) return false
    if (failOnWarnings && r.findings.some(f => f.severity === 'warning')) return false
    return true
  })

  return {
    results,
    passed,
    feedbackText: formatCriticFeedback(results),
  }
}
