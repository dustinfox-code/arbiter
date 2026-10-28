import { describe, it, expect } from 'vitest'
import {
  getBuiltInPersonas,
  resolvePersonas,
  extractPersonaSection,
  canonicalPersonaId,
  BUILT_IN_PERSONA_IDS,
  PERSONA_ALIASES,
} from '../../src/critic/personas.js'

describe('built-in personas load from the skill files', () => {
  it('loads exactly the five review skills', () => {
    const personas = getBuiltInPersonas()
    expect(Object.keys(personas).sort()).toEqual([...BUILT_IN_PERSONA_IDS].sort())
  })

  it('each system prompt is the marked section plus the JSON contract', () => {
    for (const persona of Object.values(getBuiltInPersonas())) {
      expect(persona.systemPrompt.startsWith('You are reviewing AI-generated'), persona.id).toBe(true)
      expect(persona.systemPrompt, persona.id).toContain('### Checklist')
      expect(persona.systemPrompt, persona.id).toContain('Severity: `error`')
      expect(persona.systemPrompt, persona.id).toContain('"findings": [')
      expect(persona.systemPrompt, persona.id).toContain('Checked, no issues:')
      // Nothing from outside the markers leaks into the API prompt
      expect(persona.systemPrompt, persona.id).not.toContain('## Fix mode')
      expect(persona.systemPrompt, persona.id).not.toContain('## Scope')
      expect(persona.systemPrompt, persona.id).not.toContain('<!--')
    }
  })

  it('takes the description from the skill frontmatter', () => {
    const personas = getBuiltInPersonas()
    expect(personas['hallucinated-api-review'].description).toMatch(/exists/)
    expect(personas['tautological-test-review'].description).toMatch(/cannot fail/)
  })
})

describe('extractPersonaSection', () => {
  it('returns the trimmed text between the markers', () => {
    const md = 'head\n<!-- arbiter:persona:start -->\n\nBody text\n\n<!-- arbiter:persona:end -->\ntail'
    expect(extractPersonaSection(md)).toBe('Body text')
  })

  it('throws, naming the file, when the markers are missing or reversed', () => {
    expect(() => extractPersonaSection('no markers', 'x/SKILL.md')).toThrow(/x\/SKILL\.md has no/)
    expect(() => extractPersonaSection('<!-- arbiter:persona:end --> a <!-- arbiter:persona:start -->')).toThrow()
  })
})

describe('resolvePersonas', () => {
  it('resolves canonical ids', () => {
    const [a, b] = resolvePersonas(['spec-drift-review', 'edge-case-review'], [])
    expect(a.id).toBe('spec-drift-review')
    expect(b.id).toBe('edge-case-review')
  })

  it('accepts every 0.1.x alias and returns the canonical persona', () => {
    for (const [alias, canonical] of Object.entries(PERSONA_ALIASES)) {
      expect(canonicalPersonaId(alias)).toBe(canonical)
      expect(resolvePersonas([alias], [])[0].id).toBe(canonical)
    }
  })

  it('lets a custom persona override a built-in by canonical id or alias', () => {
    const custom = { id: 'security', description: 'mine', systemPrompt: 'custom prompt' }
    const [resolved] = resolvePersonas(['ai-code-security-review'], [custom])
    expect(resolved.systemPrompt).toBe('custom prompt')
  })

  it('rejects unknown ids and lists the canonical ids', () => {
    expect(() => resolvePersonas(['nope'], [])).toThrow(/Unknown critic persona\(s\): nope/)
    expect(() => resolvePersonas(['nope'], [])).toThrow(/spec-drift-review/)
  })
})
