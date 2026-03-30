// Programmatic API — usable without the CLI
export { TaskContextManager } from './core/task-manager.js'
export { CheckpointManager } from './core/checkpoint-manager.js'
export { HookInterface, runHook } from './core/hook.js'
export { CriteriaEvaluator } from './loop/evaluator.js'
export { loadConfig } from './core/config.js'
export { pooled } from './core/pool.js'

// Types and constants
export {
  DEFAULT_CONFIG,
  type ArbiterConfig,
  type TaskContext,
  type CompletionCriteria,
  type CriteriaResult,
  type CriteriaType,
  type Checkpoint,
  type ReviewResult,
  type Finding,
  type ClaudeStopPayload,
  type HookResult,
} from './core/types.js'
