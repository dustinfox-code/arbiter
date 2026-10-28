import type { HookResult, StopPayload } from './types.js'

/**
 * Agents whose stop hook `check` can speak to. Each has a different file to
 * register the hook in, a different name for the event, and (for two of
 * them) a different JSON shape for "send the agent back to work".
 */
export type AgentId = 'claude' | 'codex' | 'copilot' | 'gemini' | 'cursor'

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'copilot', 'gemini', 'cursor']

export interface AgentInfo {
  id: AgentId
  label: string
  /** The stop-style hook event this agent fires. */
  event: string
  /** Project-relative config file the hook is registered in; null when `init` only prints a snippet. */
  configPath: string | null
  /** Whether the maintainers have run this adapter end to end against the real agent. */
  verified: boolean
  /** One line for the README's support table. */
  note: string
}

export const AGENT_INFO: Record<AgentId, AgentInfo> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    event: 'Stop',
    configPath: '.claude/settings.json',
    verified: true,
    note: 'Exit 0 with {"decision":"block","reason"}. Also wired automatically by the Claude Code plugin.',
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    event: 'Stop',
    configPath: '.codex/hooks.json',
    verified: false,
    note: 'Same JSON as Claude Code. Project hooks run only after you trust them with /hooks in Codex, which is an interactive step, so this adapter is per docs until a maintainer runs it.',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    event: 'agentStop',
    configPath: '.github/hooks/arbiter.json',
    verified: false,
    note: 'Same JSON as Claude Code; stdin uses sessionId. Per docs, not run against the real CLI.',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI / Antigravity CLI',
    event: 'AfterAgent',
    configPath: null,
    verified: false,
    note: 'Exit 0 with {"decision":"deny","reason"}. Gemini CLI was retired in June 2026; Antigravity CLI reportedly keeps the hook model but its config path is not confirmed, so init prints the snippet instead of writing it.',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    event: 'stop',
    configPath: '.cursor/hooks.json',
    verified: false,
    note: 'Exit 0 with {"followup_message"}; Cursor submits it as the next user message. stdin uses conversation_id, generation_id and workspace_roots. Per docs, not run against the real editor.',
  },
}

export interface HookEmission {
  stdout: string
  exitCode: number
}

/**
 * Translate a HookResult into what the host agent expects on stdout and as
 * an exit code.
 *
 * Why not exit 2: on exit 2 Claude Code and Codex feed *stderr* to the
 * model and ignore stdout, so feedback written to stdout was never seen.
 * Every supported agent accepts exit 0 plus a JSON object on stdout whose
 * reason becomes the model's re-entry prompt, which is where the full
 * criteria feedback has to go.
 *
 * `proceed` emits nothing: an empty stdout on exit 0 lets the stop through.
 * `error` exits 1, which every agent treats as a non-blocking hook error, so
 * Arbiter failing never traps the agent in a loop.
 */
export function emitForAgent(result: HookResult, agent: AgentId = 'claude'): HookEmission {
  switch (result.decision) {
    case 'proceed':
      return { stdout: '', exitCode: 0 }
    case 'error':
      return { stdout: '', exitCode: 1 }
    case 'loop':
      return { stdout: JSON.stringify(blockObject(result.feedback ?? result.summary, agent)), exitCode: 0 }
  }
}

function blockObject(reason: string, agent: AgentId): Record<string, string> {
  switch (agent) {
    case 'claude':
    case 'codex':
    case 'copilot':
      return { decision: 'block', reason }
    case 'gemini':
      return { decision: 'deny', reason }
    case 'cursor':
      return { followup_message: reason }
  }
}

/**
 * Map any supported agent's stop payload onto StopPayload's field names.
 *
 * Agents disagree on spelling, not meaning: Copilot sends `sessionId`,
 * Cursor sends `conversation_id`, `generation_id` and `workspace_roots`,
 * Codex calls the turn `turn_id`. Accepting every alias regardless of the
 * `--agent` flag keeps the hook robust when the flag is wrong or absent.
 * Fields already in canonical form are left untouched.
 */
export function normalizeStopPayload(raw: Record<string, unknown>): StopPayload {
  const pickString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = raw[key]
      if (typeof value === 'string' && value) return value
    }
    return undefined
  }

  const sessionId = pickString('session_id', 'sessionId', 'conversation_id') ?? ''
  const promptId = pickString('prompt_id', 'turn_id', 'generation_id')

  let cwd = pickString('cwd')
  if (!cwd && Array.isArray(raw.workspace_roots) && typeof raw.workspace_roots[0] === 'string') {
    cwd = raw.workspace_roots[0]
  }

  const stopHookActive = raw.stop_hook_active === true || raw.stopHookActive === true

  return {
    ...raw,
    session_id: sessionId,
    prompt_id: promptId,
    cwd,
    stop_hook_active: stopHookActive,
    transcript_path: pickString('transcript_path', 'transcriptPath'),
  }
}

/**
 * Validate a user-supplied agent id (e.g. from `--agent`). Throws with the
 * list of valid ids so a typo is caught before any evaluation runs.
 */
export function parseAgentId(value: unknown): AgentId {
  if (typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value)) {
    return value as AgentId
  }
  throw new Error(`Unknown agent "${String(value)}". Valid agents: ${AGENT_IDS.join(', ')}`)
}
