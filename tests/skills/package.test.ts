import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error plain ESM script without types
import { buildPackages, buildZip, rewriteReferences, RENAMES } from '../../scripts/package-skills.mjs'

interface PackageResult { folder: string; slug: string; zipPath: string; listingPath: string; files: string[] }

describe('package:skills', () => {
  let out: string
  let results: PackageResult[]

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'arbiter-pkg-'))
    results = buildPackages(out) as PackageResult[]
  })
  afterAll(async () => {
    await rm(out, { recursive: true, force: true })
  })

  it('packages every skill folder once', async () => {
    const folders = (await readdir(join(process.cwd(), 'skills'))).sort()
    expect(results.map(r => r.folder).sort()).toEqual(folders)
  })

  it('renames only loop and critic, to the branded slugs', () => {
    const slugs = Object.fromEntries(results.map(r => [r.folder, r.slug]))
    expect(slugs.loop).toBe('arbiter-loop')
    expect(slugs.critic).toBe('arbiter-critic')
    for (const r of results) {
      if (!(r.folder in RENAMES)) expect(r.slug).toBe(r.folder)
    }
  })

  it('each zip has one top-level folder named after the slug, holding SKILL.md and agents/openai.yaml', () => {
    for (const r of results) {
      const listing = execFileSync('unzip', ['-Z1', r.zipPath], { encoding: 'utf-8' }).trim().split('\n').sort()
      expect(listing, r.slug).toEqual([`${r.slug}/SKILL.md`, `${r.slug}/agents/openai.yaml`])
      // the archive is intact (unzip -t exits non-zero on CRC mismatch)
      execFileSync('unzip', ['-tq', r.zipPath], { stdio: 'ignore' })
    }
  })

  it('the staged SKILL.md name equals the slug, so Agensi accepts it', async () => {
    for (const r of results) {
      const md = await readFile(join(out, r.slug, 'SKILL.md'), 'utf-8')
      expect(md, r.slug).toMatch(new RegExp(`^---\\n[\\s\\S]*?name: ${r.slug}\\n`))
    }
  })

  it('rewrites cross-references to the renamed skills in every packaged file', async () => {
    const loop = await readFile(join(out, 'arbiter-loop', 'SKILL.md'), 'utf-8')
    expect(loop).toContain('Skill tool with "arbiter-critic"')
    expect(loop).not.toContain('Skill tool with "critic"')
    const critic = await readFile(join(out, 'arbiter-critic', 'SKILL.md'), 'utf-8')
    expect(critic).toContain('Skill tool with "arbiter-critic"')
    // persona references are untouched
    expect(critic).toContain('spec-drift-review')
  })

  it('stages openai.yaml unchanged beside the rewritten SKILL.md', async () => {
    for (const r of results) {
      const staged = await readFile(join(out, r.slug, 'agents', 'openai.yaml'), 'utf-8')
      const source = await readFile(join(process.cwd(), 'skills', r.folder, 'agents', 'openai.yaml'), 'utf-8')
      expect(staged, r.slug).toBe(source)
    }
  })

  it('writes a listing draft per skill with slug, price, tags and the plugin install line', async () => {
    for (const r of results) {
      const listing = await readFile(r.listingPath, 'utf-8')
      expect(listing, r.slug).toContain(`\`${r.slug}\``)
      expect(listing, r.slug).toContain('**Price:** Free')
      expect(listing, r.slug).toMatch(/\*\*Tags:\*\* \S/)
      expect(listing, r.slug).toContain('/plugin install arbiter --marketplace dustinfox-code/arbiter')
    }
  })

  it('rewriteReferences and buildZip are deterministic for a fixed timestamp', () => {
    expect(rewriteReferences('Call the Skill tool with "loop". Then call the Skill tool with "critic".'))
      .toBe('Call the Skill tool with "arbiter-loop". Then call the Skill tool with "arbiter-critic".')
    // Only the invocation phrase is rewritten; prose mentions of the plugin names stay
    expect(rewriteReferences('the loop skill and the critic skill')).toBe('the loop skill and the critic skill')
    const when = new Date(2026, 0, 1, 12, 0, 0)
    const a = buildZip([{ name: 'x/SKILL.md', data: Buffer.from('hi') }], when)
    const b = buildZip([{ name: 'x/SKILL.md', data: Buffer.from('hi') }], when)
    const c = buildZip([{ name: 'x/SKILL.md', data: Buffer.from('ho') }], when)
    expect(Buffer.compare(a, b)).toBe(0)
    expect(Buffer.compare(a, c)).not.toBe(0)
  })
})
