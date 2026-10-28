import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CustomPersonaConfig } from '../core/types.js'

export interface PersonaDefinition {
  id: string
  description: string
  systemPrompt: string
}

/**
 * The built-in personas are the five review skills in `skills/`. Each
 * SKILL.md carries its checklist between these markers; that section, plus
 * the JSON response contract below, is the persona's API system prompt.
 * One file serves the skill (read by the agent) and the CLI (read here),
 * so the two can never drift.
 */
export const PERSONA_START = '<!-- arbiter:persona:start -->'
export const PERSONA_END = '<!-- arbiter:persona:end -->'

export const BUILT_IN_PERSONA_IDS = [
  'spec-drift-review',
  'edge-case-review',
  'ai-code-security-review',
  'hallucinated-api-review',
  'tautological-test-review',
] as const

export type BuiltInPersonaId = (typeof BUILT_IN_PERSONA_IDS)[number]

/** 0.1.x persona ids, accepted in config and on the command line. */
export const PERSONA_ALIASES: Record<string, BuiltInPersonaId> = {
  correctness: 'spec-drift-review',
  'edge-cases': 'edge-case-review',
  security: 'ai-code-security-review',
  hallucinations: 'hallucinated-api-review',
  'test-quality': 'tautological-test-review',
}

const RESPONSE_FORMAT_INSTRUCTION = `

Respond with JSON matching this exact schema — no text outside the JSON object:
{
  "findings": [
    {
      "severity": "error" | "warning" | "info",
      "location": "file.ts:line (if determinable, otherwise omit)",
      "message": "What is wrong",
      "suggestion": "Concrete fix — not just a flag, but what to change"
    }
  ],
  "summary": "One-sentence overall assessment"
}

Report the clean categories as one "info" finding whose message is "Checked, no issues: <categories>".
If nothing at all was found, return: { "findings": [{ "severity": "info", "message": "Checked, no issues: <all categories>" }], "summary": "No issues found." }`

/**
 * Pull the persona section out of a SKILL.md. Exported for tests and for
 * anyone building a persona from their own skill file.
 */
export function extractPersonaSection(markdown: string, source = 'SKILL.md'): string {
  const start = markdown.indexOf(PERSONA_START)
  const end = markdown.indexOf(PERSONA_END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${source} has no ${PERSONA_START} … ${PERSONA_END} section`)
  }
  return markdown.slice(start + PERSONA_START.length, end).trim()
}

function readFrontmatterField(markdown: string, field: string): string | undefined {
  const block = markdown.match(/^---\n([\s\S]*?)\n---\n/)
  if (!block) return undefined
  for (const line of block[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    if (line.slice(0, idx).trim() !== field) continue
    let value = line.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    return value
  }
  return undefined
}

/**
 * Locate the package's `skills/` directory. Works from `src/` under vitest
 * and from `dist/` in the published package, since both sit two levels
 * below the package root.
 */
export function skillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate = resolve(here, '..', '..', 'skills')
  if (!existsSync(candidate)) {
    throw new Error(`Arbiter skills directory not found at ${candidate}. Is the package installed completely?`)
  }
  return candidate
}

let cache: Record<string, PersonaDefinition> | null = null

/**
 * Load the five built-in personas from their skill files. Read once per
 * process; the files are small and the result is memoised.
 */
export function getBuiltInPersonas(): Record<string, PersonaDefinition> {
  if (cache) return cache
  const dir = skillsDir()
  const personas: Record<string, PersonaDefinition> = {}
  for (const id of BUILT_IN_PERSONA_IDS) {
    const path = join(dir, id, 'SKILL.md')
    const markdown = readFileSync(path, 'utf-8')
    personas[id] = {
      id,
      description: readFrontmatterField(markdown, 'description') ?? id,
      systemPrompt: extractPersonaSection(markdown, path) + RESPONSE_FORMAT_INSTRUCTION,
    }
  }
  cache = personas
  return personas
}

/** Map a persona id or 0.1.x alias to its canonical id. Unknown ids pass through. */
export function canonicalPersonaId(id: string): string {
  return PERSONA_ALIASES[id] ?? id
}

/**
 * Resolve persona IDs to their definitions. Custom personas override built-in
 * ones by matching ID (canonical or alias). Throws if a requested ID is not found.
 */
export function resolvePersonas(
  requestedIds: string[],
  customPersonas: CustomPersonaConfig[],
): PersonaDefinition[] {
  const builtIn = getBuiltInPersonas()

  const customMap = new Map<string, PersonaDefinition>()
  for (const cp of customPersonas) {
    customMap.set(canonicalPersonaId(cp.id), {
      id: cp.id,
      description: cp.description,
      systemPrompt: cp.systemPrompt,
    })
  }

  const resolved: PersonaDefinition[] = []
  const missing: string[] = []

  for (const requested of requestedIds) {
    const id = canonicalPersonaId(requested)
    const custom = customMap.get(id)
    if (custom) {
      resolved.push(custom)
    } else if (builtIn[id]) {
      resolved.push(builtIn[id])
    } else {
      missing.push(requested)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Unknown critic persona(s): ${missing.join(', ')}. ` +
      `Available: ${BUILT_IN_PERSONA_IDS.join(', ')}` +
      (customPersonas.length > 0 ? `, ${customPersonas.map(p => p.id).join(', ')}` : ''),
    )
  }

  return resolved
}
