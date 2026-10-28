# Arbiter — System Specification

## What this is

Arbiter is an npm package that improves Claude Code workflows for both solo developers and teams. It does two things:

1. **Loop agent** — intercepts Claude Code's stop signal and evaluates whether the work is actually done before allowing the session to end. If criteria aren't met, it re-enters the loop with targeted feedback.

2. **Critic** — runs adversarial sub-agents over AI-generated code to catch failure modes that standard review tools miss: hallucinated APIs, spec drift, edge case blindness, and tests that only test the implementation rather than the requirements.

These two systems are designed to work together: the critic runs as part of the loop's completion gate, so "done" means the code passed adversarial review, not just that tests happened to pass.

---

## Guiding principles

- **Minimal configuration to get value.** `npx arbiter init` + `arbiter task start` should work without editing any config files.
- **Composable, not monolithic.** The loop and critic should be independently useful. A team might only want the critic. A solo dev might only want the loop. Both should work standalone.
- **Honest feedback over vague feedback.** When Arbiter blocks a stop, the injected message must tell Claude exactly what failed and why — not just "criteria not met."
- **Fail safe.** If Arbiter itself errors, Claude Code should not be left in a broken state. Hard errors exit cleanly; Arbiter never silently swallows failures.

---

## Distribution

- **npm package** named `arbiter-cc`
- TypeScript, ESM, Node ≥ 18
- `bin` entry so `npx arbiter-cc <command>` works without installation
- Programmatic API exported from the package root for teams building custom tooling on top

---

## Repository structure

```
arbiter/
├── src/
│   ├── core/              # Shared runtime — task state, checkpoints, hook entry point
│   ├── loop/              # Criteria evaluation and loop logic
│   ├── critic/            # Adversarial review agents and persona lenses
│   └── cli.ts             # CLI entry point
├── templates/
│   └── CLAUDE.md.tmpl     # Injected into user projects on init
├── package.json
└── tsconfig.json
```

---

## Cross-cutting contracts

These are the types that cross module boundaries. All modules must agree on them. Implementation details within each module are intentionally left open.

```typescript
// The task being worked on and its current state
interface TaskContext {
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
interface CompletionCriteria {
  id: string
  type: CriteriaType
  description: string      // Shown in feedback to Claude — be specific
  required: boolean        // false = warning only, does not block
  config: Record<string, unknown>
}

// The result of evaluating one criterion
interface CriteriaResult {
  criteriaId: string
  passed: boolean
  required: boolean
  description: string
  feedback?: string        // Shown to Claude if failed — must be actionable
  durationMs: number
}

// A snapshot of one loop iteration
interface Checkpoint {
  id: string
  iteration: number
  timestamp: string
  gitHash?: string
  criteriaResults: CriteriaResult[]
  passedIds: string[]
  failedIds: string[]
}

// The result of a critic review pass
interface ReviewResult {
  passed: boolean
  persona: string          // Which lens ran (e.g. "correctness", "security")
  findings: Finding[]
  summary: string
}

interface Finding {
  severity: 'error' | 'warning' | 'info'
  location?: string        // File and line if determinable
  message: string
  suggestion?: string      // Concrete fix, not just a flag
}

// What Claude Code sends to stop hooks via stdin
interface ClaudeStopPayload {
  session_id: string
  transcript_path: string
  cwd: string
  hook_event_name: 'Stop'
  stop_hook_active: boolean
}

// The hook's decision after evaluation
interface HookResult {
  decision: 'proceed' | 'loop' | 'error'
  iteration: number
  passedCriteria: string[]
  failedCriteria: string[]
  feedback?: string        // Written to stdout — becomes Claude's re-entry context
  summary: string          // Written to stderr — visible in Claude Code logs
}
```

---

## Phase 1 — Core loop

Build and validate this before starting Phase 2.

### 1.1 Core module

Responsibilities: load, persist, and mutate task state. Manage checkpoints. This is stateful — task state is persisted to `.arbiter/task.json` so it survives across Claude Code sessions.

Key behaviors:
- `TaskContextManager` loads from `.arbiter/task.json`, creates if not present, saves on every mutation
- `CheckpointManager` writes one JSON file per checkpoint to `.arbiter/checkpoints/`. Supports listing, retrieving by id, and pruning to keep the last N
- Checkpoints should attempt to capture a git hash if the project is in a git repo. If not, fall back gracefully — don't error
- Both managers take `cwd` as a parameter so they're testable without touching the real filesystem

### 1.2 Criteria evaluator

Responsibilities: take a list of `CompletionCriteria`, run each evaluator, return `CriteriaResult[]`.

Supported criteria types in Phase 1:

| Type | Behavior |
|------|----------|
| `command` | Run an arbitrary shell command. Pass = exit 0. Capture stdout/stderr for feedback on failure. |
| `tests-pass` | Run the project's test suite. Default command is `npm test` but configurable. Extract just the failure lines from output, not the full run, for feedback. |
| `no-ts-errors` | Run `tsc --noEmit`. Configurable tsconfig path. |
| `file-exists` | Check that a file or path exists. |
| `llm` | Call the Anthropic API with a user-supplied prompt and optional context files. Expect a structured JSON response `{ passed: boolean, feedback: string | null }`. Treat parse failure as a non-pass with feedback explaining the evaluator failed. |
| `custom` | Load a user-supplied `.js` or `.ts` module from a path. The module must export a default async function with signature `(criteria, payload, cwd) => { passed, feedback? }`. |

Design notes:
- Run criteria with bounded concurrency (not all at once, not one at a time)
- Each evaluator should be isolated — one evaluator throwing must not prevent others from running
- Feedback strings are shown directly to Claude. They should be specific: include the actual error output, not just "command failed"

### 1.3 Hook interface

This is the Claude Code stop hook entry point. It is called by Claude Code as a shell command with the stop payload on stdin.

Behavior:
1. Read and parse the Claude Code stop payload from stdin
2. Load the active task from `TaskContextManager`. If no task exists, exit 0 (don't interfere with non-Arbiter sessions)
3. If the task is already `complete` or `failed`, exit 0
4. If `iteration >= maxIterations`, mark the task `failed`, log a clear message to stderr, exit 0 (don't loop forever)
5. Increment iteration, set status to `running`
6. Run all criteria via the evaluator
7. Write a checkpoint
8. If all required criteria pass: mark task `complete`, write success summary to stderr, exit 0
9. If any required criteria fail: build feedback prompt, emit it as the agent's block decision on stdout, exit 0

Exit codes (revised in 0.2.0; see Phase 3):
- `0` — always. When criteria fail, stdout carries `{"decision":"block","reason":<feedback>}` and the agent re-enters with the reason as its prompt. On exit 2 the agents feed *stderr* to the model, so 0.1's stdout feedback was never seen.
- `1` — Arbiter itself failed (parse error, unrecoverable internal error). Agents treat this as non-blocking.

Feedback prompt format (the block decision's `reason`, on stdout, exit 0):
- Must include: current iteration / max, which criteria passed, which failed, and the specific feedback string from each failing criterion
- Must end with a clear instruction to Claude to fix the failing criteria and not stop until they pass
- Should be structured (markdown is fine, Claude Code renders it)

### 1.4 CLI

Commands:

```
arbiter init
```
- Creates `.arbiter/` directory
- Writes default `config.json`
- Wires the stop hook into `.claude/settings.json` — adds `{ type: "command", command: "npx arbiter-cc check" }` to the `Stop` hooks array. Creates the file if it doesn't exist. Does not duplicate if already present.
- Appends `.arbiter/checkpoints/` and `.arbiter/task.json` to `.gitignore` if the file exists
- Prints a `CLAUDE.md` snippet the user should add to their project, explaining to Claude what Arbiter is and how to work with it

```
arbiter task start "<description>"
```
- Creates a new task in `.arbiter/task.json`
- Scaffolds default criteria (tests-pass, no-ts-errors) as a starting point
- Tells the user to edit `.arbiter/task.json` to customize criteria for this specific task
- Accepts `--max-iterations <n>` flag (default: 5)

```
arbiter task status
```
- Shows current task description, status, iteration count, and the pass/fail breakdown from the last checkpoint

```
arbiter task clear
```
- Removes `.arbiter/task.json`. Does not delete checkpoints.

```
arbiter check
```
- Manually triggers the stop hook evaluation (same code path as the hook, but can be run directly for testing)
- Useful for verifying Arbiter is configured correctly before starting a session

```
arbiter checkpoints
```
- Lists all checkpoints with iteration number, timestamp, and pass/fail counts
- Accepts `--restore <id>` flag to restore a checkpoint (git checkout if available, otherwise file-level)

### 1.5 Config

Loaded from `.arbiter/config.json`. All fields optional — fall back to defaults if missing.

```typescript
interface ArbiterConfig {
  maxIterations: number           // Default: 5
  checkpointDir: string           // Default: .arbiter/checkpoints
  taskFile: string                // Default: .arbiter/task.json
  llmModel: string                // Default: claude-sonnet-5-5 (0.2.0)
  critic: {
    enabled: boolean              // Default: false (Phase 2)
    personas: string[]            // Default: ["spec-drift-review", "edge-case-review", "ai-code-security-review"] (0.2.0; 0.1 ids remain aliases)
    failOnWarnings: boolean       // Default: false
  }
}
```

### 1.6 Programmatic API

Export from the package root:
- `TaskContextManager`
- `CheckpointManager`
- `HookInterface`
- `CriteriaEvaluator`
- All types from the contracts section above
- `DEFAULT_CONFIG`

The programmatic API should be usable without the CLI — a team should be able to build a custom hook that uses Arbiter's evaluator with their own orchestration.

### 1.7 CLAUDE.md template

Arbiter's `init` command prints this (or a version of it) for the user to add to their project's `CLAUDE.md`. It is intentionally written to Claude, not to the developer:

```markdown
## Arbiter

This project uses Arbiter to enforce task completion before stopping.

When you finish a task, Arbiter's stop hook evaluates whether all
required criteria are met. If they aren't, you'll receive a structured
feedback message explaining what's still failing. Address the failures
and complete the work — do not try to stop until Arbiter allows it.

If you believe a criterion is incorrectly failing due to an environment
issue (not a code issue), say so explicitly in your response before
stopping so the developer can investigate.

Current task status: run `arbiter task status` to check.
```

---

## Phase 2 — Critic module

Build this after Phase 1 is working and tested. The critic plugs into the loop as an optional criteria type, but also runs as a standalone command.

### 2.1 What the critic is for

Standard code review tools are designed for human-written code. AI-generated code has different and more specific failure modes:

- **Hallucinated APIs** — methods or imports that look correct but don't exist
- **Spec drift** — code does something, just not what was asked
- **Happy path only** — error handling is missing or perfunctory
- **Tautological tests** — tests that pass because they test the implementation, not the requirements
- **Overconfident types** — TypeScript types that are technically correct but mask runtime failures

The critic runs a set of adversarial sub-agents, each focused on one of these failure modes, and returns structured findings.

### 2.2 Personas

Each persona is a sub-agent with a focused system prompt. Phase 2 ships with these built-in, but the system must be extensible so users can add custom personas via config.

| Persona | Focus |
|---------|-------|
| `correctness` | Does the code do what was asked? Checks implementation against the task description. Flags spec drift. |
| `edge-cases` | What inputs or states will break this? Focuses on missing error handling, null/undefined paths, boundary conditions. |
| `security` | Basic security review. Injection risks, unsafe operations, credentials in code, insufficient validation. |
| `hallucinations` | Are all imported modules real? Are all called methods real members of their types? Checks against the actual dependency tree. |
| `test-quality` | Do the tests actually test requirements, or just the implementation? Flags tautological tests and missing coverage of specified behavior. |

### 2.3 Behavior

The critic takes:
- The task description (from `TaskContext`)
- A list of files to review (inferred from git diff, or configurable)
- Which personas to run (from config, or all by default)

It runs each persona as a separate API call (parallelized) and collects `ReviewResult[]`.

Each finding must include a `suggestion` where possible — not just a flag, but a concrete recommendation for what to change.

Findings with severity `error` cause the critic to return `passed: false`. Findings with severity `warning` cause `passed: false` only if `failOnWarnings` is true in config.

### 2.4 Integration with the loop

The critic integrates as a `criteria` type:

```json
{
  "id": "critic-review",
  "type": "critic",
  "description": "Code passes adversarial review",
  "required": true,
  "config": {
    "personas": ["correctness", "edge-cases", "hallucinations"],
    "files": "git-diff"
  }
}
```

When this criterion is evaluated, the `CriteriaEvaluator` calls the critic module. The `feedback` string returned is the consolidated findings from all personas, formatted for Claude to act on.

### 2.5 Standalone command

```
arbiter review
```
- Runs the critic against the current working state without the loop
- Accepts `--personas <list>` to run specific lenses
- Accepts `--files <glob>` to review specific files
- Prints findings to stdout grouped by persona and severity
- Exits non-zero if any `error`-severity findings are present

### 2.6 Custom personas

Users can add personas via `.arbiter/config.json`:

```json
{
  "critic": {
    "enabled": true,
    "customPersonas": [
      {
        "id": "accessibility",
        "description": "Checks for accessibility issues in UI code",
        "systemPrompt": "You are an accessibility expert reviewing AI-generated UI code..."
      }
    ]
  }
}
```

Custom personas follow the same `ReviewResult` contract as built-in personas.

---

## What Claude Code should figure out

These are intentionally left to Claude Code's judgment:

- Internal implementation of each evaluator (how to parse test output, how to structure LLM prompts for the critic personas, etc.)
- How checkpoints are stored on disk (JSON files, sqlite, doesn't matter — just match the interface)
- Error message copy and formatting details
- How to handle edge cases within each module that aren't explicitly specced
- Test structure and coverage approach

---

## Build order

1. Types and contracts (`src/core/types.ts`)
2. TaskContextManager and CheckpointManager
3. CriteriaEvaluator with all Phase 1 types
4. HookInterface
5. CLI
6. Package config (package.json, tsconfig.json)
7. README
8. (After validation) Critic module
9. (After critic is working) Critic integration into loop criteria

---

## Definition of done for Phase 1

- `npx arbiter-cc init` runs without error in a fresh Node project
- `arbiter task start "test task"` creates `.arbiter/task.json`
- A stop hook fires, reads the payload, evaluates criteria, and either exits 0 or exits 2 with a feedback message
- `arbiter task status` shows correct state after a loop iteration
- `arbiter checkpoints` lists checkpoints with accurate pass/fail counts
- The programmatic API imports correctly from the package root
- No external runtime dependencies beyond `@anthropic-ai/sdk`

---

## Phase 3 — Skills and plugin (0.2.0)

Decided 2026-10-28 after a marketplace (Agensi.io) asked to list Arbiter's skills, which revealed the package had none: it was a CLI and a hook. Goal: distribution first, every listing free, pricing revisited only on traction.

### What ships

- **Seven pure-markdown skills in `skills/`.** Five personas (`spec-drift-review`, `edge-case-review`, `ai-code-security-review`, `hallucinated-api-review`, `tautological-test-review`), the `critic` orchestrator, and the `loop` definition-of-done skill. Each `SKILL.md` is self-contained: scope resolution, a numbered must-answer-every-category checklist, the findings format, and an opt-in `fix` argument. All are model-invoked with trigger-rich descriptions; none has a `scripts/` folder or an install instruction, which is what Agensi's security scan rejects. Each carries `agents/openai.yaml` for Codex's picker and the personas carry `context: fork` so Claude Code runs them in a fresh context.
- **One source of truth for persona prompts.** The checklist sits between `<!-- arbiter:persona:start/end -->` markers; `getBuiltInPersonas()` extracts it as the API system prompt. There is no generated `agents/` directory: `critic` reaches personas by calling the Skill tool, and `context: fork` already isolates them.
- **A Claude Code plugin.** `.claude-plugin/plugin.json` lists the skills; `hooks/hooks.json` wires the Stop hook to `npx arbiter-cc check`; `.claude-plugin/marketplace.json` makes the repo its own marketplace. Codex and Copilot CLI also read this manifest. `plugin.json` version tracks `package.json` via `scripts/sync-plugin-version.mjs`.
- **Portable enforcement.** Every major agent has a stop-style hook that can send the agent back with a reason: Claude Code, Codex and Copilot share `{"decision":"block","reason"}`; Gemini uses `deny`; Cursor uses `{"followup_message"}`. `check --agent` emits the right one and `init --agent` writes the right config file. Adapters are labelled verified only after a maintainer runs them against the real agent.
- **Agensi packaging.** `npm run package:skills` zips each skill with one top-level folder named after its slug. `loop` and `critic` become `arbiter-loop` and `arbiter-critic` on the way out, with cross-references rewritten, because the plugin namespaces them as `/arbiter:loop` and `/arbiter:critic` while a marketplace slug must carry the brand.

### Loop design

The `loop` skill is the discipline: it writes `.arbiter/task.json` (the same schema the hook reads), verifies every criterion itself, and iterates up to `maxIterations`. The hook is the enforcement. Both exist so the skill alone works in any agent and the hook makes it binding where installed.

### Hook fixes forced by the move

- Feedback moves from stdout-on-exit-2 to a JSON block decision on exit 0.
- Agents run every hook for an event in parallel, so a project with both the plugin hook and an `init`-wired hook ran `check` twice per stop. `check` now takes an O_EXCL lock next to `task.json` and replays its last answer for a repeat of the same stop event. The replay key is session id, prompt id, `stop_hook_active`, a hash of the last assistant message, and a 10-second window: `prompt_id` alone identifies the user turn, and one turn produces several stop events once a hook blocks.
- `stop_hook_active` is recorded with each evaluation.
