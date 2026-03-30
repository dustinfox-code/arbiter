# arbiter-cc

Loop agent for Claude Code — enforce task completion before stopping.

Arbiter hooks into Claude Code's stop signal and evaluates whether your work is actually done before allowing the session to end. If criteria aren't met, it sends Claude back with targeted feedback.

## Quick Start

```bash
# In your project directory:
npx arbiter-cc init

# Start a task:
npx arbiter-cc task start "implement user authentication"

# Edit .arbiter/task.json to customize criteria, then start Claude Code.
# Arbiter's stop hook fires automatically when Claude tries to stop.
```

## CLI Reference

### `arbiter-cc init`

Sets up Arbiter in the current project:
- Creates `.arbiter/` directory with default config
- Wires the stop hook into `.claude/settings.json`
- Updates `.gitignore`
- Prints a `CLAUDE.md` snippet to add to your project

### `arbiter-cc task start "<description>"`

Creates a new task with default criteria (tests-pass, no-ts-errors).

Flags:
- `--max-iterations <n>` — Max loop iterations before failing (default: 5)
- `--force` — Replace an existing task

### `arbiter-cc task status`

Shows current task description, status, iteration count, and the pass/fail breakdown from the last checkpoint.

### `arbiter-cc task clear`

Removes the active task. Does not delete checkpoints.

### `arbiter-cc check`

Manually triggers the stop hook evaluation. Useful for verifying Arbiter is configured correctly before starting a session.

### `arbiter-cc checkpoints`

Lists all checkpoints with iteration number, timestamp, and pass/fail counts.

Flags:
- `--restore <id>` — Restore to a checkpoint via git checkout

## Criteria Types

| Type | Behavior |
|------|----------|
| `command` | Run a shell command. Pass = exit 0. Config: `{ command: "..." }` |
| `tests-pass` | Run the test suite. Config: `{ command: "npm test" }` |
| `no-ts-errors` | Run `tsc --noEmit`. Config: `{ tsconfigPath?: "..." }` |
| `file-exists` | Check a file exists. Config: `{ path: "..." }` |
| `llm` | Call Anthropic API with a prompt. Config: `{ prompt: "...", files?: [...] }` |
| `custom` | Load a JS module. Config: `{ path: "evaluator.mjs" }` |

## Programmatic API

```typescript
import {
  TaskContextManager,
  CheckpointManager,
  HookInterface,
  CriteriaEvaluator,
  DEFAULT_CONFIG,
} from 'arbiter-cc'

// Use the evaluator standalone
const evaluator = new CriteriaEvaluator('/path/to/project', 'claude-sonnet-4-20250514')
const results = await evaluator.evaluate(criteria)

// Run the hook programmatically
const hook = new HookInterface()
const result = await hook.run({ cwd: '/path/to/project' })
```

## Configuration

Edit `.arbiter/config.json`:

```json
{
  "maxIterations": 5,
  "checkpointDir": ".arbiter/checkpoints",
  "taskFile": ".arbiter/task.json",
  "llmModel": "claude-sonnet-4-20250514",
  "critic": {
    "enabled": false,
    "personas": ["correctness", "edge-cases", "security"],
    "failOnWarnings": false
  }
}
```

All fields are optional — missing fields fall back to defaults.

## How It Works

1. You start a task with `arbiter-cc task start`
2. Claude Code works on the task
3. When Claude tries to stop, Arbiter's stop hook fires
4. Arbiter evaluates all criteria (tests pass? no TS errors? etc.)
5. If all required criteria pass → task marked complete, Claude stops
6. If any required criteria fail → Claude gets structured feedback and continues working
7. This repeats up to `maxIterations` times

## License

MIT
