// Programmatic API — usable without the CLI
export { TaskContextManager, validateTask } from './core/task-manager.js'
export { packageVersion } from './core/version.js'
export { CheckpointManager } from './core/checkpoint-manager.js'
export { HookInterface, runHook } from './core/hook.js'
export type { HookRunOptions } from './core/hook.js'
export { emitForAgent, normalizeStopPayload, parseAgentId, AGENT_IDS, AGENT_INFO } from './core/agents.js'
export type { AgentId, AgentInfo, HookEmission } from './core/agents.js'
export { wireAgentHook, wireDetectedAgents, detectAgents, hookCommand } from './core/agent-config.js'
export type { WireResult } from './core/agent-config.js'
export { acquireStopLock, matchesLastStop } from './core/stop-lock.js'
export { CriteriaEvaluator } from './loop/evaluator.js'
export { loadConfig } from './core/config.js'
export { pooled } from './core/pool.js'
export { resolveContextFiles, isPathContained } from './core/files.js'

// Critic module
export { runCritic } from './critic/runner.js'
export type { CriticRunOptions, CriticRunResult } from './critic/runner.js'
export {
  getBuiltInPersonas,
  resolvePersonas,
  extractPersonaSection,
  canonicalPersonaId,
  skillsDir,
  BUILT_IN_PERSONA_IDS,
  PERSONA_ALIASES,
  PERSONA_START,
  PERSONA_END,
} from './critic/personas.js'
export type { PersonaDefinition, BuiltInPersonaId } from './critic/personas.js'

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
