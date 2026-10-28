// Programmatic API — usable without the CLI
export { TaskContextManager } from './core/task-manager.js'
export { CheckpointManager } from './core/checkpoint-manager.js'
export { HookInterface, runHook } from './core/hook.js'
export type { HookRunOptions } from './core/hook.js'
export { emitForAgent, parseAgentId, AGENT_IDS } from './core/agents.js'
export type { AgentId, HookEmission } from './core/agents.js'
export { acquireStopLock, matchesLastStop } from './core/stop-lock.js'
export { CriteriaEvaluator } from './loop/evaluator.js'
export { loadConfig } from './core/config.js'
export { pooled } from './core/pool.js'
export { resolveContextFiles, isPathContained } from './core/files.js'

// Critic module
export { runCritic } from './critic/runner.js'
export type { CriticRunOptions, CriticRunResult } from './critic/runner.js'
export { BUILT_IN_PERSONAS, resolvePersonas } from './critic/personas.js'
export type { PersonaDefinition } from './critic/personas.js'

// Types and constants
export {
  DEFAULT_CONFIG,
  type ArbiterConfig,
  type CustomPersonaConfig,
  type TaskContext,
  type CompletionCriteria,
  type CriteriaResult,
  type CriteriaType,
  type Checkpoint,
  type ReviewResult,
  type Finding,
  type ClaudeStopPayload,
  type StopPayload,
  type LastStopRecord,
  type HookResult,
} from './core/types.js'
