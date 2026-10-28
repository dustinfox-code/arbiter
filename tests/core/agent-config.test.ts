import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wireAgentHook, wireDetectedAgents, detectAgents, hookCommand } from '../../src/core/agent-config.js'
import { AGENT_IDS } from '../../src/core/agents.js'

describe('wireAgentHook', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arbiter-wire-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function json(rel: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(dir, rel), 'utf-8')) as Record<string, unknown>
  }

  it('claude: writes a Stop entry in .claude/settings.json with the bare command', async () => {
    const r = await wireAgentHook(dir, 'claude')
    expect(r.status).toBe('wired')
    const s = await json('.claude/settings.json')
    const stop = (s.hooks as Record<string, unknown>).Stop as Array<Record<string, unknown>>
    expect(stop).toHaveLength(1)
    expect(stop[0].matcher).toBe('')
    const inner = stop[0].hooks as Array<Record<string, unknown>>
    expect(inner[0]).toEqual({ type: 'command', command: 'npx arbiter-cc check', timeout: 120 })
  })

  it('codex: writes a Stop entry in .codex/hooks.json with --agent codex and no matcher', async () => {
    const r = await wireAgentHook(dir, 'codex')
    expect(r.status).toBe('wired')
    const s = await json('.codex/hooks.json')
    const stop = (s.hooks as Record<string, unknown>).Stop as Array<Record<string, unknown>>
    expect(stop[0]).not.toHaveProperty('matcher')
    const inner = stop[0].hooks as Array<Record<string, unknown>>
    expect(inner[0].command).toBe('npx arbiter-cc check --agent codex')
  })

  it('copilot: writes an agentStop entry in .github/hooks/arbiter.json using bash/timeoutSec', async () => {
    const r = await wireAgentHook(dir, 'copilot')
    expect(r.status).toBe('wired')
    const s = await json('.github/hooks/arbiter.json')
    expect(s.version).toBe(1)
    const list = (s.hooks as Record<string, unknown>).agentStop as Array<Record<string, unknown>>
    expect(list[0]).toEqual({ type: 'command', bash: 'npx arbiter-cc check --agent copilot', timeoutSec: 120 })
  })

  it('cursor: writes a stop entry in .cursor/hooks.json', async () => {
    const r = await wireAgentHook(dir, 'cursor')
    expect(r.status).toBe('wired')
    const s = await json('.cursor/hooks.json')
    expect(s.version).toBe(1)
    const list = (s.hooks as Record<string, unknown>).stop as Array<Record<string, unknown>>
    expect(list[0]).toEqual({ command: 'npx arbiter-cc check --agent cursor', timeout: 120 })
  })

  it('gemini: writes nothing and returns a snippet with decision-free AfterAgent registration', async () => {
    const r = await wireAgentHook(dir, 'gemini')
    expect(r.status).toBe('printed')
    expect(r.path).toBeNull()
    await expect(access(join(dir, '.gemini'))).rejects.toThrow()
    const snippet = JSON.parse(r.snippet!) as Record<string, unknown>
    const list = (snippet.hooks as Record<string, unknown>).AfterAgent as Array<Record<string, unknown>>
    const inner = list[0].hooks as Array<Record<string, unknown>>
    expect(inner[0].command).toBe('npx arbiter-cc check --agent gemini')
    expect(inner[0].timeout).toBe(120000)
  })

  it('is idempotent: a second call reports present and leaves one entry', async () => {
    for (const agent of ['claude', 'codex', 'copilot', 'cursor'] as const) {
      await wireAgentHook(dir, agent)
      const again = await wireAgentHook(dir, agent)
      expect(again.status, agent).toBe('present')
    }
    const claude = await json('.claude/settings.json')
    expect(((claude.hooks as Record<string, unknown>).Stop as unknown[]).length).toBe(1)
    const copilot = await json('.github/hooks/arbiter.json')
    expect(((copilot.hooks as Record<string, unknown>).agentStop as unknown[]).length).toBe(1)
  })

  it('preserves other hooks and settings already in the file', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true })
    await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other' }] }], PreToolUse: [] },
    }))
    await wireAgentHook(dir, 'claude')
    const s = await json('.claude/settings.json')
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] })
    const stop = (s.hooks as Record<string, unknown>).Stop as unknown[]
    expect(stop).toHaveLength(2)
    expect((s.hooks as Record<string, unknown>).PreToolUse).toEqual([])
  })

  it('refuses to clobber a file it cannot parse', async () => {
    await mkdir(join(dir, '.codex'), { recursive: true })
    await writeFile(join(dir, '.codex', 'hooks.json'), '{ not json')
    await expect(wireAgentHook(dir, 'codex')).rejects.toThrow(/Could not parse/)
  })

  it('hookCommand keeps the bare form for claude only', () => {
    expect(hookCommand('claude')).toBe('npx arbiter-cc check')
    for (const agent of AGENT_IDS.filter(a => a !== 'claude')) {
      expect(hookCommand(agent)).toBe(`npx arbiter-cc check --agent ${agent}`)
    }
  })
})

describe('init --agent all', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arbiter-detect-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('detects agents by their config directories, treating .github alone as not-Copilot', async () => {
    await mkdir(join(dir, '.claude'))
    await mkdir(join(dir, '.github'))
    const d = await detectAgents(dir)
    expect(d).toEqual({ claude: true, codex: false, copilot: false, gemini: false, cursor: false })
    await mkdir(join(dir, '.github', 'hooks'))
    expect((await detectAgents(dir)).copilot).toBe(true)
  })

  it('wires only the detected agents and reports the rest as skipped', async () => {
    await mkdir(join(dir, '.claude'))
    await mkdir(join(dir, '.cursor'))
    const results = await wireDetectedAgents(dir)
    const byAgent = Object.fromEntries(results.map(r => [r.agent, r.status]))
    expect(byAgent).toEqual({ claude: 'wired', codex: 'skipped', copilot: 'skipped', gemini: 'skipped', cursor: 'wired' })
    await expect(access(join(dir, '.codex'))).rejects.toThrow()
  })
})
