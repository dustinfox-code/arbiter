import { describe, it, expect } from 'vitest'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const SKILLS_DIR = join(process.cwd(), 'skills')
const PERSONA_SKILLS = [
  'spec-drift-review',
  'edge-case-review',
  'ai-code-security-review',
  'hallucinated-api-review',
  'tautological-test-review',
]

interface Frontmatter { [key: string]: string }

function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error('No frontmatter block')
  const fm: Frontmatter = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    fm[key] = value
  }
  return { fm, body: match[2] }
}

async function skillDirs(): Promise<string[]> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true })
  return entries.filter(e => e.isDirectory()).map(e => e.name).sort()
}

describe('loop skill contract', () => {
  it('documents a task.json example that matches the TaskContext shape the hook reads', async () => {
    const text = await readFile(join(SKILLS_DIR, 'loop', 'SKILL.md'), 'utf-8')
    const fence = text.match(/```json\n(\{\n  "id": "<uuid>"[\s\S]*?)\n```/)
    expect(fence, 'task.json example fence').not.toBeNull()
    const task = JSON.parse(fence![1]) as Record<string, unknown>
    for (const key of ['id', 'description', 'criteria', 'status', 'iteration', 'maxIterations', 'createdAt', 'updatedAt', 'checkpoints', 'metadata']) {
      expect(task, `task.json example has ${key}`).toHaveProperty(key)
    }
    expect(task.status).toBe('pending')
    expect(task.maxIterations).toBe(5)
    for (const c of task.criteria as Array<Record<string, unknown>>) {
      for (const key of ['id', 'type', 'description', 'required', 'config']) {
        expect(c, `criterion has ${key}`).toHaveProperty(key)
      }
    }
  })

  it('documents a checkpoint example with the fields the CLI prints', async () => {
    const text = await readFile(join(SKILLS_DIR, 'loop', 'SKILL.md'), 'utf-8')
    const fence = text.match(/```json\n(\{ "id": "checkpoint-[\s\S]*?)\n```/)
    expect(fence, 'checkpoint example fence').not.toBeNull()
    const cp = JSON.parse(fence![1]) as Record<string, unknown>
    for (const key of ['id', 'iteration', 'timestamp', 'criteriaResults', 'passedIds', 'failedIds']) {
      expect(cp, `checkpoint example has ${key}`).toHaveProperty(key)
    }
  })

  it('mentions the npm package once, as a link, with nothing executable', async () => {
    const text = await readFile(join(SKILLS_DIR, 'loop', 'SKILL.md'), 'utf-8')
    expect(text.match(/arbiter-cc/g)?.length).toBe(1)
    expect(text).toMatch(/https:\/\/github\.com\/dustinfox-code\/arbiter/)
  })
})

describe('skills/ layout (Agensi + Claude Code plugin rules)', () => {
  it('every skill folder has a SKILL.md whose name matches the folder', async () => {
    for (const dir of await skillDirs()) {
      const text = await readFile(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf-8')
      const { fm } = parseFrontmatter(text)
      expect(fm.name, `${dir}/SKILL.md name`).toBe(dir)
      expect(fm.name).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('every description is one to three sentences and carries a trigger clause', async () => {
    for (const dir of await skillDirs()) {
      const { fm } = parseFrontmatter(await readFile(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf-8'))
      const sentences = fm.description.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean)
      expect(sentences.length, `${dir} description sentence count`).toBeGreaterThanOrEqual(1)
      expect(sentences.length, `${dir} description sentence count`).toBeLessThanOrEqual(3)
      expect(fm.description, `${dir} description trigger`).toMatch(/Use when/)
    }
  })

  it('every skill has Codex metadata beside it', async () => {
    for (const dir of await skillDirs()) {
      const yaml = await readFile(join(SKILLS_DIR, dir, 'agents', 'openai.yaml'), 'utf-8')
      expect(yaml).toMatch(/display_name:/)
      expect(yaml).toMatch(/short_description:/)
    }
  })

  it('skills are pure markdown: no scripts folder, no install or npx instructions', async () => {
    for (const dir of await skillDirs()) {
      await expect(stat(join(SKILLS_DIR, dir, 'scripts'))).rejects.toThrow()
      const text = await readFile(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf-8')
      expect(text, `${dir} mentions npx`).not.toMatch(/\bnpx\b/)
      expect(text, `${dir} mentions npm install`).not.toMatch(/npm (i|install)\b/)
    }
  })

  it('persona skills carry exactly one marked persona section and fork their context', async () => {
    for (const dir of PERSONA_SKILLS) {
      const text = await readFile(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf-8')
      const { fm } = parseFrontmatter(text)
      expect(fm.context, `${dir} context`).toBe('fork')
      expect(fm['argument-hint'], `${dir} argument-hint`).toMatch(/fix/)
      expect(text.match(/<!-- arbiter:persona:start -->/g)?.length, `${dir} start marker`).toBe(1)
      expect(text.match(/<!-- arbiter:persona:end -->/g)?.length, `${dir} end marker`).toBe(1)
      const section = text.slice(
        text.indexOf('<!-- arbiter:persona:start -->'),
        text.indexOf('<!-- arbiter:persona:end -->'),
      )
      expect(section, `${dir} persona opens with a role line`).toMatch(/You are reviewing AI-generated/)
      expect(section, `${dir} persona has a numbered checklist`).toMatch(/### Checklist\n\n1\. \*\*/)
      expect(section, `${dir} persona defines severities`).toMatch(/Severity: `error`/)
      expect(section, `${dir} persona asks for the clean list`).toMatch(/Checked, no issues:/)
    }
  })
})
