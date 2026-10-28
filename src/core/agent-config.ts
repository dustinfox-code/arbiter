import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { AGENT_IDS, AGENT_INFO, type AgentId } from './agents.js'
import { packageVersion } from './version.js'

/** Seconds an agent waits for `check` before killing it. Criteria like a test suite need room. */
const HOOK_TIMEOUT_SECONDS = 120

export interface WireResult {
  agent: AgentId
  /** Project-relative path written or inspected, or null when nothing is written. */
  path: string | null
  /** 'wired' = written this call; 'present' = already there; 'printed' = snippet only; 'skipped' = not in use. */
  status: 'wired' | 'present' | 'printed' | 'skipped'
  message: string
  /** For 'printed': the JSON the user adds by hand. */
  snippet?: string
}

/**
 * The command each agent's hook runs. Pinned to this exact version: the hook
 * fires on every stop, and an unpinned `npx arbiter-cc` would fetch whatever
 * the registry serves. `npm version` rewrites the pin in hooks/hooks.json;
 * `init` writes the version of the CLI that ran it.
 */
export function hookCommand(agent: AgentId): string {
  const base = `npx arbiter-cc@${packageVersion()} check`
  return agent === 'claude' ? base : `${base} --agent ${agent}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err: unknown) {
    throw new Error(`Could not parse ${path}: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object; fix or remove it before running init`)
  }
  return parsed as Record<string, unknown>
}

/** The event's entry list, created when absent; refuses to replace a non-array someone else wrote. */
function eventList(hooks: Record<string, unknown>, event: string, path: string): unknown[] {
  if (hooks[event] === undefined) hooks[event] = []
  if (!Array.isArray(hooks[event])) {
    throw new Error(`${path}: hooks.${event} is not an array; fix it before running init`)
  }
  return hooks[event] as unknown[]
}

function hooksObject(file: Record<string, unknown>, path: string): Record<string, unknown> {
  if (file.hooks === undefined) file.hooks = {}
  if (!file.hooks || typeof file.hooks !== 'object' || Array.isArray(file.hooks)) {
    throw new Error(`${path}: "hooks" is not an object; fix it before running init`)
  }
  return file.hooks as Record<string, unknown>
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

/** True when any hook entry under `list` already runs arbiter-cc. Handles both nested and flat entry shapes. */
function hasArbiterEntry(list: unknown): boolean {
  if (!Array.isArray(list)) return false
  return list.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const e = entry as Record<string, unknown>
    const own = [e.command, e.bash, e.powershell].some(v => typeof v === 'string' && v.includes('arbiter-cc'))
    if (own) return true
    return Array.isArray(e.hooks) && e.hooks.some((h: unknown) =>
      !!h && typeof h === 'object' && typeof (h as Record<string, unknown>).command === 'string' &&
      ((h as Record<string, unknown>).command as string).includes('arbiter-cc'))
  })
}

/**
 * Register the Arbiter stop hook with one agent, in that agent's own config
 * file and dialect. Idempotent: a file that already runs arbiter-cc is left
 * alone. Other hooks in the file are preserved.
 */
export async function wireAgentHook(cwd: string, agent: AgentId): Promise<WireResult> {
  const info = AGENT_INFO[agent]
  const command = hookCommand(agent)

  switch (agent) {
    case 'claude':
    case 'codex': {
      // Both use { hooks: { <Event>: [ { hooks: [ { type, command, timeout } ] } ] } }
      const relPath = info.configPath as string
      const path = join(cwd, relPath)
      const settings = await readJson(path)
      const hooks = hooksObject(settings, relPath)
      const list = eventList(hooks, info.event, relPath)
      if (hasArbiterEntry(list)) {
        return { agent, path: relPath, status: 'present', message: `${info.label}: ${info.event} hook already present in ${relPath}` }
      }
      const entry: Record<string, unknown> = {
        hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }],
      }
      if (agent === 'claude') entry.matcher = ''
      list.push(entry)
      await writeJson(path, settings)
      return { agent, path: relPath, status: 'wired', message: `${info.label}: wired ${info.event} hook into ${relPath}` }
    }

    case 'copilot': {
      // { version: 1, hooks: { agentStop: [ { type, bash, timeoutSec } ] } } in .github/hooks/*.json
      const relPath = info.configPath as string
      const path = join(cwd, relPath)
      const file = await readJson(path)
      if (file.version === undefined) file.version = 1
      const hooks = hooksObject(file, relPath)
      const list = eventList(hooks, info.event, relPath)
      if (hasArbiterEntry(list)) {
        return { agent, path: relPath, status: 'present', message: `${info.label}: ${info.event} hook already present in ${relPath}` }
      }
      list.push({ type: 'command', bash: command, timeoutSec: HOOK_TIMEOUT_SECONDS })
      await writeJson(path, file)
      return { agent, path: relPath, status: 'wired', message: `${info.label}: wired ${info.event} hook into ${relPath} (per docs, unverified)` }
    }

    case 'cursor': {
      // { version: 1, hooks: { stop: [ { command, timeout } ] } } in .cursor/hooks.json
      const relPath = info.configPath as string
      const path = join(cwd, relPath)
      const file = await readJson(path)
      if (file.version === undefined) file.version = 1
      const hooks = hooksObject(file, relPath)
      const list = eventList(hooks, info.event, relPath)
      if (hasArbiterEntry(list)) {
        return { agent, path: relPath, status: 'present', message: `${info.label}: ${info.event} hook already present in ${relPath}` }
      }
      list.push({ command, timeout: HOOK_TIMEOUT_SECONDS })
      await writeJson(path, file)
      return { agent, path: relPath, status: 'wired', message: `${info.label}: wired ${info.event} hook into ${relPath} (per docs, unverified; Cursor caps stop-hook loops at 5 by default)` }
    }

    case 'gemini': {
      const snippet = JSON.stringify(
        { hooks: { AfterAgent: [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS * 1000 }] }] } },
        null,
        2,
      )
      return {
        agent,
        path: null,
        status: 'printed',
        snippet,
        message:
          `${info.label}: add the snippet below to the hooks section of the CLI's settings.json ` +
          `(Gemini CLI used .gemini/settings.json; Antigravity CLI's location is not confirmed, so nothing was written).`,
      }
    }
  }
}

/** Which agents appear to be in use in this project, judged by their config directories. */
export async function detectAgents(cwd: string): Promise<Record<AgentId, boolean>> {
  return {
    claude: await exists(join(cwd, '.claude')),
    codex: await exists(join(cwd, '.codex')),
    copilot: (await exists(join(cwd, '.github', 'hooks'))) || (await exists(join(cwd, '.github', 'copilot-instructions.md'))),
    gemini: await exists(join(cwd, '.gemini')),
    cursor: await exists(join(cwd, '.cursor')),
  }
}

/**
 * `init --agent all`: wire every agent whose config directory already
 * exists, and say why the others were skipped. Never creates a config
 * directory for an agent the project does not use.
 */
export async function wireDetectedAgents(cwd: string): Promise<WireResult[]> {
  const present = await detectAgents(cwd)
  const results: WireResult[] = []
  for (const agent of AGENT_IDS) {
    if (!present[agent]) {
      results.push({ agent, path: AGENT_INFO[agent].configPath, status: 'skipped', message: `${AGENT_INFO[agent].label}: no config directory found — skipped` })
      continue
    }
    results.push(await wireAgentHook(cwd, agent))
  }
  return results
}
