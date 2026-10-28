// Cross-cutting contracts — these types cross module boundaries.
// All modules must agree on them. Do not modify without spec approval.

export type CriteriaType =
  | 'command'
  | 'tests-pass'
  | 'no-ts-errors'
  | 'file-exists'
  | 'llm'
  | 'custom'
  | 'critic'

// The task being worked on and its current state
export interface TaskContext {
  id: string
  description: string
  criteria: CompletionCriteria[]
  status: 'pending' | 'running' | 'complete' | 'failed' | 'abandoned'
  iteration: number
  maxIterations: number
  createdAt: string        // ISO 8601
  updatedAt: string
  checkpoints: Checkpoint[]
  metadata: Record<string, unknown>
}

// A single completion gate
export interface CompletionCriteria {
  id: string
  type: CriteriaType
  description: string      // Shown in feedback to Claude — be specific
  required: boolean        // false = warning only, does not block
  config: Record<string, unknown>
}

// The result of evaluating one criterion
export interface CriteriaResult {
  criteriaId: string
  passed: boolean
  required: boolean
  description: string
  feedback?: string        // Shown to Claude if failed — must be actionable
  durationMs: number
}

// A snapshot of one loop iteration
export interface Checkpoint {
  id: string
  iteration: number
  timestamp: string
  gitHash?: string
  criteriaResults: CriteriaResult[]
  passedIds: string[]
  failedIds: string[]
}

// The result of a critic review pass
export interface ReviewResult {
  passed: boolean
  persona: string          // Which lens ran (e.g. "spec-drift-review", "ai-code-security-review")
  findings: Finding[]
  summary: string
}

export interface Finding {
  severity: 'error' | 'warning' | 'info'
  location?: string        // File and line if determinable
  message: string
  suggestion?: string      // Concrete fix, not just a flag
}

// What the host agent sends to the stop hook via stdin. Field names follow
// Claude Code's Stop event; Codex and Copilot send the same core fields.
// Every field except session_id is optional so a hand-run `arbiter-cc check`
// (empty stdin) and other agents' payloads both parse.
export interface StopPayload {
  session_id: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  stop_hook_active?: boolean      // true when the agent is already continuing because of a stop hook
  prompt_id?: string              // identifies the user turn; used to make `check` idempotent per stop
  permission_mode?: string
  last_assistant_message?: string
  [key: string]: unknown
}

/** @deprecated Use StopPayload. Kept for 0.1.x API compatibility. */
export type ClaudeStopPayload = StopPayload

// The hook's decision after evaluation
export interface HookResult {
  decision: 'proceed' | 'loop' | 'error'
  iteration: number
  passedCriteria: string[]
  failedCriteria: string[]
  feedback?: string        // Delivered to the agent as the block reason — becomes its re-entry context
  summary: string          // Written to stderr — visible in the agent's logs
  replayed?: boolean       // true when this result was served from the last-stop cache, not re-evaluated
}

// What `check` remembers about the last stop event it evaluated, stored in
// task.metadata.lastStop. A second hook process for the same stop (two hooks
// wired for one event, or a retry) replays this instead of re-evaluating,
// so one stop never burns two iterations.
export interface LastStopRecord {
  sessionId: string
  promptId?: string
  at: string               // ISO 8601
  stopHookActive?: boolean
  result: HookResult
}

// A user-defined critic persona loaded from config
export interface CustomPersonaConfig {
  id: string
  description: string
  systemPrompt: string
}

// Configuration loaded from .arbiter/config.json
export interface ArbiterConfig {
  maxIterations: number           // Default: 5
  checkpointDir: string           // Default: .arbiter/checkpoints
  taskFile: string                // Default: .arbiter/task.json
  llmModel: string                // Default: claude-sonnet-5-5
  critic: {
    enabled: boolean              // Default: false (Phase 2)
    personas: string[]            // Default: ["spec-drift-review", "edge-case-review", "ai-code-security-review"]
    failOnWarnings: boolean       // Default: false
    customPersonas: CustomPersonaConfig[]  // Default: []
  }
}

export const DEFAULT_CONFIG: ArbiterConfig = {
  maxIterations: 5,
  checkpointDir: '.arbiter/checkpoints',
  taskFile: '.arbiter/task.json',
  llmModel: 'claude-sonnet-5-5',
  critic: {
    enabled: false,
    personas: ['spec-drift-review', 'edge-case-review', 'ai-code-security-review'],
    failOnWarnings: false,
    customPersonas: [],
  },
}
