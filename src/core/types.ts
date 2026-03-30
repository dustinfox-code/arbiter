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
  persona: string          // Which lens ran (e.g. "correctness", "security")
  findings: Finding[]
  summary: string
}

export interface Finding {
  severity: 'error' | 'warning' | 'info'
  location?: string        // File and line if determinable
  message: string
  suggestion?: string      // Concrete fix, not just a flag
}

// What Claude Code sends to stop hooks via stdin
export interface ClaudeStopPayload {
  session_id: string
  transcript_path: string
  cwd: string
  hook_event_name: 'Stop'
  stop_hook_active: boolean
}

// The hook's decision after evaluation
export interface HookResult {
  decision: 'proceed' | 'loop' | 'error'
  iteration: number
  passedCriteria: string[]
  failedCriteria: string[]
  feedback?: string        // Written to stdout — becomes Claude's re-entry context
  summary: string          // Written to stderr — visible in Claude Code logs
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
  llmModel: string                // Default: claude-sonnet-4-20250514
  critic: {
    enabled: boolean              // Default: false (Phase 2)
    personas: string[]            // Default: ["correctness", "edge-cases", "security"]
    failOnWarnings: boolean       // Default: false
    customPersonas: CustomPersonaConfig[]  // Default: []
  }
}

export const DEFAULT_CONFIG: ArbiterConfig = {
  maxIterations: 5,
  checkpointDir: '.arbiter/checkpoints',
  taskFile: '.arbiter/task.json',
  llmModel: 'claude-sonnet-4-20250514',
  critic: {
    enabled: false,
    personas: ['correctness', 'edge-cases', 'security'],
    failOnWarnings: false,
    customPersonas: [],
  },
}
