import type { HookResult } from './types.js'

/**
 * Agents whose stop-hook output format `check` can speak.
 * More adapters are added alongside `init --agent` support.
 */
export type AgentId = 'claude'

export const AGENT_IDS: readonly AgentId[] = ['claude']

export interface HookEmission {
  stdout: string
  exitCode: number
}

/**
 * Translate a HookResult into what the host agent expects on stdout and as
 * an exit code.
 *
 * Why not exit 2: on exit 2 Claude Code (and Codex) feed *stderr* to the
 * model and ignore stdout, so feedback written to stdout was never seen.
 * Every supported agent accepts exit 0 plus a JSON object on stdout whose
 * `reason` becomes the model's re-entry prompt, which is where the full
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
      return formatBlock(result, agent)
  }
}

function formatBlock(result: HookResult, agent: AgentId): HookEmission {
  const reason = result.feedback ?? result.summary
  switch (agent) {
    case 'claude':
      return { stdout: JSON.stringify({ decision: 'block', reason }), exitCode: 0 }
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
