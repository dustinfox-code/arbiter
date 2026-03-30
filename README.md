# arbiter-cc

Arbiter intercepts Claude Code's stop signal and evaluates whether the task is actually done before letting the session end. If criteria aren't met, it sends Claude back to work with structured feedback about what's still failing.

## Quick Start

```bash
npx arbiter-cc init                              # wire stop hook + create .arbiter/
npx arbiter-cc task start "add user login endpoint"  # register a task
# start Claude Code — Arbiter fires automatically when Claude tries to stop
```

That's it. `init` configures the Claude Code stop hook and creates `.arbiter/config.json` with defaults. `task start` registers a task with two default criteria: `tests-pass` and `no-ts-errors`. When Claude tries to stop, Arbiter evaluates the criteria and either allows the stop or sends Claude back.

To customize criteria before starting Claude, edit `.arbiter/task.json`:

```bash
npx arbiter-cc check    # dry-run: trigger the hook manually to test your setup
```

## How the Loop Works

```
Claude tries to stop
    │
    ▼
Arbiter reads .arbiter/task.json
    │
    ├── no task?           → exit 0 (allow stop)
    ├── task complete/failed? → exit 0 (allow stop)
    ├── iteration >= max?  → mark failed, exit 0
    │
    ▼
Run all criteria (tests, tsc, custom commands, etc.)
    │
    ├── all required pass  → mark complete, exit 0
    │
    └── any required fail  → write feedback to stdout, exit 2 (loop)
```

**Exit codes:**
- `0` — stop allowed (task complete, failed, or no task)
- `2` — Claude re-enters with feedback injected as context
- `1` — internal Arbiter error

Each iteration saves a checkpoint to `.arbiter/checkpoints/` with the pass/fail state and git hash. The loop runs up to `maxIterations` times (default: 5), then marks the task failed and lets Claude stop.

## Completion Criteria Types

Edit the `criteria` array in `.arbiter/task.json` to control what Arbiter checks. Each entry needs an `id`, `type`, `description`, `required` (boolean), and `config` object.

| Type | What it does | Config |
|------|-------------|--------|
| `tests-pass` | Run test suite, pass if exit 0 | `{ "command": "npm test" }` |
| `no-ts-errors` | Run `tsc --noEmit` | `{ "tsconfigPath": "tsconfig.json" }` |
| `command` | Run any shell command, pass if exit 0 | `{ "command": "npm run lint" }` |
| `file-exists` | Check a file exists (path-traversal safe) | `{ "path": "src/auth.ts" }` |
| `llm` | Call Anthropic API with prompt + file context | `{ "prompt": "...", "files": ["src/auth.ts"], "model": "...", "timeout": 30000 }` |
| `critic` | Run adversarial review personas | `{ "personas": ["correctness", "security"], "files": "git-diff" }` |
| `custom` | Load a JS module as evaluator | `{ "path": "my-evaluator.mjs" }` |

### Example: full criteria array

```json
{
  "criteria": [
    {
      "id": "tests-pass",
      "type": "tests-pass",
      "description": "All tests pass",
      "required": true,
      "config": { "command": "npm test" }
    },
    {
      "id": "no-ts-errors",
      "type": "no-ts-errors",
      "description": "No TypeScript compilation errors",
      "required": true,
      "config": {}
    },
    {
      "id": "lint-clean",
      "type": "command",
      "description": "ESLint passes with no errors",
      "required": false,
      "config": { "command": "npx eslint src/ --max-warnings 0" }
    },
    {
      "id": "critic-review",
      "type": "critic",
      "description": "Adversarial review passes",
      "required": true,
      "config": { "personas": ["correctness", "security"], "files": "git-diff" }
    }
  ]
}
```

Set `"required": false` to make a criterion advisory-only (warnings reported but don't block completion).

### `llm` criteria

The LLM evaluator sends your prompt plus file contents to the Anthropic API and expects a `{ "passed": boolean, "feedback": "..." }` JSON response. Set `"files": "git-diff"` to automatically include changed files.

```json
{
  "id": "docs-updated",
  "type": "llm",
  "description": "README reflects the new API",
  "required": false,
  "config": {
    "prompt": "Check if the README documents all exported functions. Return passed=false if any are missing.",
    "files": ["README.md", "src/index.ts"]
  }
}
```

Requires `ANTHROPIC_API_KEY` in the environment.

### `custom` criteria

Export a default async function from a `.mjs` file:

```javascript
// my-evaluator.mjs
export default async function(criteria, payload, cwd) {
  // do your checks
  return { passed: true, feedback: null }
  // or: { passed: false, feedback: "What went wrong" }
}
```

```json
{
  "id": "my-check",
  "type": "custom",
  "description": "Custom project check",
  "required": true,
  "config": { "path": "my-evaluator.mjs" }
}
```

## The Critic

The critic runs adversarial LLM-powered personas that review code for AI-specific failure modes. Each persona is a focused system prompt that receives your code and task description, returning structured findings.

### Built-in personas

| Persona | What it catches |
|---------|----------------|
| `correctness` | Spec drift, incomplete features, TODOs, mismatched signatures |
| `edge-cases` | Missing null checks, unhandled rejections, off-by-one, resource leaks |
| `security` | Injection, path traversal, hardcoded secrets, unsafe eval |
| `hallucinations` | Imports that don't exist in package.json, fake API methods |
| `test-quality` | Tautological tests, missing assertions, tests that can't fail |

### Run standalone

```bash
# Review git-diff files with default personas (correctness, edge-cases, security)
npx arbiter-cc review

# Pick specific personas
npx arbiter-cc review --personas correctness,hallucinations

# Review specific files
npx arbiter-cc review --files src/auth.ts,src/api.ts

# Review all project files
npx arbiter-cc review --all
```

The review command uses the active task description for context (if one exists). Exits non-zero if any errors are found.

### Add as a loop criterion

Add a `critic` type entry to your task criteria:

```json
{
  "id": "critic-review",
  "type": "critic",
  "description": "Adversarial review finds no errors",
  "required": true,
  "config": {
    "personas": ["correctness", "security", "hallucinations"],
    "files": "git-diff"
  }
}
```

If `config.personas` is omitted, it falls back to the personas listed in `.arbiter/config.json`.

### Custom personas

Define custom personas in `.arbiter/config.json`:

```json
{
  "critic": {
    "personas": ["correctness", "security", "api-contracts"],
    "customPersonas": [
      {
        "id": "api-contracts",
        "description": "Verify API request/response schemas match the spec",
        "systemPrompt": "You are reviewing code for API contract violations..."
      }
    ]
  }
}
```

Custom personas with the same `id` as a built-in persona override it.

## Configuration Reference

`.arbiter/config.json` — all fields optional, shown with defaults:

```json
{
  "maxIterations": 5,
  "checkpointDir": ".arbiter/checkpoints",
  "taskFile": ".arbiter/task.json",
  "llmModel": "claude-sonnet-4-20250514",
  "critic": {
    "enabled": false,
    "personas": ["correctness", "edge-cases", "security"],
    "failOnWarnings": false,
    "customPersonas": []
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxIterations` | number | `5` | Max loop iterations before task is marked failed |
| `checkpointDir` | string | `".arbiter/checkpoints"` | Where checkpoint JSON files are stored |
| `taskFile` | string | `".arbiter/task.json"` | Path to the active task file |
| `llmModel` | string | `"claude-sonnet-4-20250514"` | Model used for `llm` and `critic` evaluators |
| `critic.enabled` | boolean | `false` | Whether critic runs as part of the loop (when using critic criteria type, this is separate) |
| `critic.personas` | string[] | `["correctness", "edge-cases", "security"]` | Default personas for critic evaluations |
| `critic.failOnWarnings` | boolean | `false` | If true, warnings (not just errors) cause critic to fail |
| `critic.customPersonas` | array | `[]` | Custom persona definitions (see above) |

Missing config file = all defaults. Partial config = deep-merged with defaults.

## CLI Reference

```
arbiter-cc init                          Initialize Arbiter in the current project
arbiter-cc task start "<description>"    Start a task (default criteria: tests-pass, no-ts-errors)
arbiter-cc task status                   Show current task state and last checkpoint
arbiter-cc task clear                    Remove the active task
arbiter-cc check                         Manually trigger stop hook evaluation
arbiter-cc checkpoints                   List all checkpoints
arbiter-cc checkpoints --restore <id>    Restore to a checkpoint via git checkout
arbiter-cc review                        Run standalone critic review
```

**Flags:**
- `--max-iterations <n>` — Override max iterations on task start (default: 5)
- `--force` — Replace an existing task without clearing first
- `--personas <list>` — Comma-separated persona IDs for review
- `--files <list|git-diff|all>` — Files to review (default: git-diff)
- `--all` — Shorthand for `--files all`

## Known Limitations (v0.1)

**No task editing.** You can't add or remove criteria from a running task via the CLI. Edit `.arbiter/task.json` directly. If you break the JSON, Arbiter will error on the next stop hook.

**Test output parsing is heuristic.** The `tests-pass` evaluator extracts failure context using regex pattern matching (looks for "FAIL", "Error:", "AssertionError" near failure lines). Non-standard test output formats may produce poor feedback.

**File size limits.** Files over 1 MB are skipped. Critic context is capped at ~500 lines per file. Large files may be truncated or excluded from review.

**Git-diff default can review nothing.** Both the critic and `files: "git-diff"` resolve changed files via `git diff --name-only HEAD`. If there are no uncommitted changes (e.g., everything was committed), the file list is empty and the review is a no-op.

**LLM/critic require `ANTHROPIC_API_KEY`.** Not checked at init time — you'll get a failure at evaluation time if it's missing.

**Custom evaluators are unsandboxed.** The `custom` evaluator type runs your JS module with full filesystem and network access. The only guardrail is a 30-second timeout.

**No atomic task state.** Task status, checkpoint writes, and task updates are separate file operations. A process kill mid-loop could leave `.arbiter/task.json` in an inconsistent state. Run `arbiter-cc task clear` and start over if this happens.

**Iteration limit is a hard stop.** When `maxIterations` is reached, the task is marked `failed` and cannot be resumed. You must `task clear` and `task start` again.

**Single dependency.** Requires `@anthropic-ai/sdk` (^0.52.0). Node >= 18.

## License

MIT
