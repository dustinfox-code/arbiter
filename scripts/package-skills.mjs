#!/usr/bin/env node
// Package each skill in skills/ as an Agensi-ready zip, plus a listing draft.
//
// Agensi rules this satisfies: one top-level folder per zip named after the
// skill; `name` in SKILL.md equals that folder; only text files. The two
// branded skills are renamed on the way out (loop -> arbiter-loop,
// critic -> arbiter-critic) because inside the Claude Code plugin they are
// namespaced as /arbiter:loop and /arbiter:critic, while on a marketplace a
// slug has to carry the brand itself. Cross-references between skills are
// rewritten to match.
//
// Usage: node scripts/package-skills.mjs [outDir]   (default: dist/skills)
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = join(ROOT, 'skills')

/** Plugin folder name -> marketplace slug. Unlisted skills keep their name. */
export const RENAMES = { loop: 'arbiter-loop', critic: 'arbiter-critic' }

/** Listing metadata per skill (by plugin folder name). */
const LISTINGS = {
  'spec-drift-review': { category: 'Develop / Code review', tags: ['code-review', 'spec', 'requirements', 'ai-generated-code', 'correctness'] },
  'edge-case-review': { category: 'Develop / Code review', tags: ['code-review', 'edge-cases', 'error-handling', 'robustness', 'ai-generated-code'] },
  'ai-code-security-review': { category: 'Develop / Security', tags: ['security', 'injection', 'secrets', 'path-traversal', 'code-review'] },
  'hallucinated-api-review': { category: 'Develop / Code review', tags: ['hallucination', 'imports', 'dependencies', 'api', 'ai-generated-code'] },
  'tautological-test-review': { category: 'Develop / Testing', tags: ['testing', 'test-quality', 'assertions', 'code-review', 'ai-generated-code'] },
  critic: { category: 'Develop / Code review', tags: ['code-review', 'adversarial', 'parallel', 'subagents', 'ai-generated-code'] },
  loop: { category: 'Develop / Workflow', tags: ['definition-of-done', 'loop', 'ralph-loop', 'verification', 'stop-hook'] },
}

// ── Minimal store-only ZIP writer (no deps; Agensi scans text, compression is irrelevant) ──

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}
/** entries: [{ name: 'folder/file', data: Buffer }] → Buffer of a valid zip (store method). */
export function buildZip(entries, when = new Date()) {
  const { time, date } = dosDateTime(when)
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)        // version needed
    local.writeUInt16LE(0x0800, 6)    // flags: UTF-8 names
    local.writeUInt16LE(0, 8)         // method: store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)      // version made by
    central.writeUInt16LE(20, 6)      // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)      // extra
    central.writeUInt16LE(0, 32)      // comment
    central.writeUInt16LE(0, 34)      // disk
    central.writeUInt16LE(0, 36)      // internal attrs
    central.writeUInt32LE(0, 38)      // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, end])
}

// ── Skill transforms ──

function frontmatterField(md, field) {
  const block = md.match(/^---\n([\s\S]*?)\n---\n/)
  if (!block) return undefined
  const line = block[1].split('\n').find(l => l.startsWith(field + ':'))
  if (!line) return undefined
  let v = line.slice(field.length + 1).trim()
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  return v
}

function setFrontmatterName(md, name) {
  return md.replace(/^(---\n[\s\S]*?)name: [^\n]+/, `$1name: ${name}`)
}

/** Rewrite `Skill tool with "<old>"` references so renamed skills still find each other. */
export function rewriteReferences(md) {
  let out = md
  for (const [from, to] of Object.entries(RENAMES)) {
    out = out.replaceAll(`Skill tool with "${from}"`, `Skill tool with "${to}"`)
  }
  return out
}

function yamlField(yaml, field) {
  const m = yaml.match(new RegExp(`^\\s*${field}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'))
  return m ? m[1].trim() : undefined
}

function listingMarkdown({ slug, folder, md, yaml }) {
  const title = yamlField(yaml, 'display_name') ?? slug
  const short = yamlField(yaml, 'short_description') ?? ''
  const description = frontmatterField(md, 'description') ?? ''
  const meta = LISTINGS[folder] ?? { category: 'Develop', tags: [] }
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, '')
  const intro = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))[0] ?? ''
  return `# Listing draft: ${title}

- **Slug / folder:** \`${slug}\`
- **Zip:** \`${slug}.zip\`
- **Price:** Free
- **Category:** ${meta.category}
- **Tags:** ${meta.tags.join(', ')}
- **Short description (picker):** ${short}

## Description

${description}

${intro}

## What you get

One \`SKILL.md\` with the complete procedure and checklist, plus \`agents/openai.yaml\` for Codex's skill picker. Pure markdown: no scripts, no installs, no network. Works in Claude Code, Codex, Copilot CLI, Cursor and any agent that reads the SKILL.md standard.

## Also available

- Claude Code plugin with a Stop hook that enforces the loop: \`/plugin install arbiter --marketplace dustinfox-code/arbiter\`
- Source, issues and the npm CLI: https://github.com/dustinfox-code/arbiter
- License: MIT
`
}

export function buildPackages(outDir = join(ROOT, 'dist', 'skills')) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date()
  const results = []
  for (const folder of readdirSync(SKILLS).filter(f => statSync(join(SKILLS, f)).isDirectory()).sort()) {
    const slug = RENAMES[folder] ?? folder
    const srcMd = readFileSync(join(SKILLS, folder, 'SKILL.md'), 'utf-8')
    const md = rewriteReferences(slug === folder ? srcMd : setFrontmatterName(srcMd, slug))
    const yamlPath = join(SKILLS, folder, 'agents', 'openai.yaml')
    const yaml = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf-8') : ''

    const entries = [{ name: `${slug}/SKILL.md`, data: Buffer.from(md, 'utf-8') }]
    if (yaml) entries.push({ name: `${slug}/agents/openai.yaml`, data: Buffer.from(yaml, 'utf-8') })
    const zipPath = join(outDir, `${slug}.zip`)
    writeFileSync(zipPath, buildZip(entries, stamp))

    // Staged copy for inspection, and the listing draft for the submission form
    const staged = join(outDir, slug)
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'SKILL.md'), md)
    if (yaml) {
      mkdirSync(join(staged, 'agents'), { recursive: true })
      writeFileSync(join(staged, 'agents', 'openai.yaml'), yaml)
    }
    const listingPath = join(outDir, `${slug}.listing.md`)
    writeFileSync(listingPath, listingMarkdown({ slug, folder, md, yaml }))

    results.push({ folder, slug, zipPath, listingPath, files: entries.map(e => e.name) })
  }
  return results
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : undefined
  const results = buildPackages(out)
  for (const r of results) {
    console.log(`${r.slug.padEnd(26)} ${r.zipPath}`)
  }
  console.log(`\n${results.length} skill packages written. Upload each zip at https://www.agensi.io/dashboard/submit using its .listing.md.`)
}
