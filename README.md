# Arbiter

Adversarial code review and a definition-of-done loop for AI coding agents.

Arbiter is two ideas. The **critic** runs five independent reviewers, each in a fresh context, each hunting one failure mode AI-generated code is prone to: spec drift, missed edge cases, security holes, hallucinated APIs, and tests that cannot fail. The **loop** writes down what "done" means before the work starts, then verifies every criterion, fixes, and re-verifies until all pass or the budget runs out. The stop hook turns the loop from advice into enforcement: the agent cannot end its turn while a required criterion fails.

You can have it three ways, and they share one set of files:

| Route | What you get | Where it works |
|---|---|---|
| **Claude Code plugin** | Seven skills under `/arbiter:` plus the Stop hook, zero config | Claude Code |
| **Skills** | The seven `SKILL.md` files, pure markdown, no runtime | Claude Code, Codex, Copilot CLI, Cursor, anything that reads the SKILL.md standard |
| **CLI (`arbiter-cc`)** | The stop hook for five agents, the API-driven critic, checkpoints | Claude Code, Codex, Copilot CLI, Cursor, Gemini/Antigravity |

## Install

### Claude Code plugin

```
/plugin install arbiter --marketplace dustinfox-code/arbiter
```

Or in two steps: `claude plugin marketplace add dustinfox-code/arbiter`, then `claude plugin install arbiter@arbiter`. The plugin's hook runs `npx arbiter-cc check`, so Node 18+ is needed; the first run downloads the package.

### Skills anywhere

- **skills.sh:** `npx skills add dustinfox-code/arbiter` copies the skills into your project for whichever agents you use.
- **Agensi:** each skill is listed free on [agensi.io](https://www.agensi.io) and loads through their MCP connector.
- **By hand:** copy any folder under `skills/` into your agent's skills directory. Each is self-contained.

### CLI, for enforcement in any agent

```bash
npx arbiter-cc init                  # wires the Stop hook for Claude Code
npx arbiter-cc init --agent codex    # or copilot, cursor, gemini
npx arbiter-cc init --agent all      # every agent whose config directory already exists
```

## The skills

| Skill | What it does |
|---|---|
| `spec-drift-review` | Measures the code against the task it was meant to implement: unmet requirements, placeholder code, scope creep, interface drift. |
| `edge-case-review` | Seven categories that break at runtime: collection bounds, null paths, unhandled rejections, unvalidated boundary types, off-by-one, swallowed errors, leaked handles. |
| `ai-code-security-review` | Injection, path traversal, hardcoded secrets, unsafe eval and deserialization, untrusted input, insecure defaults. Every finding names the input, the sink and the consequence. |
| `hallucinated-api-review` | Confirms every package, export, method, option and type exists, by reading the manifest and installed type declarations rather than from memory. |
| `tautological-test-review` | Finds tests that pass whether or not the code is right: tautologies, mocked units under test, weak assertions, uncovered requirements, brittle coupling. |
| `critic` | Runs the five above in parallel subagents and reports them side by side. Report-only unless you pass `fix`. |
| `loop` | Captures the task, proposes criteria from your stack, writes `.arbiter/task.json`, and verifies before declaring done. The advisory half of the loop. |

Every review skill takes an optional `fix` argument. Without it the report is the deliverable. With it the skill applies the error-severity fixes, re-runs its checklist once, and says what changed, always within the permissions your session already grants.

Each persona's checklist lives between `<!-- arbiter:persona:start -->` and `<!-- arbiter:persona:end -->` in its `SKILL.md`. The CLI critic loads the same text as its API system prompt, so the skill and the CLI cannot drift.

## The loop

```
Agent tries to stop
    │
    ▼
arbiter-cc check reads .arbiter/task.json
    │
    ├── no task?                → allow stop
    ├── task complete/failed?   → allow stop
    ├── same stop already answered (parallel hooks)? → replay the answer
    ├── iteration >= max?       → mark failed, allow stop
    │
    ▼
Run all criteria (tests, tsc, commands, critic, …)
    │
    ├── all required pass → mark complete, allow stop
    │
    └── any required fail → {"decision":"block","reason":<what failed and why>}
                            the agent re-enters with the reason as its next prompt
```

Exit codes: `0` always, with the block decision as JSON on stdout when the agent has to continue; `1` only when Arbiter itself failed, which every agent treats as a non-blocking hook error so a broken Arbiter can never trap a session.

Each iteration writes a checkpoint to `.arbiter/checkpoints/` with the pass/fail state and git hash. After `maxIterations` (default 5) the task is marked failed and the stop is allowed.

### Start a task

```bash
npx arbiter-cc task start "add user login endpoint"   # default criteria: tests-pass, no-ts-errors
npx arbiter-cc task status
npx arbiter-cc check                                   # dry run of the hook, no payload
```

Or use the `loop` skill, which proposes criteria from your project and writes the same file.

## Enforcement across agents

The hook speaks each agent's dialect. `check --agent <id>` chooses the output; `init --agent <id>` writes the registration.

| Agent | Event | Config written by `init` | Continuation | Status |
|---|---|---|---|---|
| Claude Code | `Stop` | `.claude/settings.json` (or the plugin) | `{"decision":"block","reason"}` | Verified end to end |
| Codex CLI | `Stop` | `.codex/hooks.json` | same | Per docs. Project hooks run after you trust them with `/hooks` in Codex |
| GitHub Copilot CLI | `agentStop` | `.github/hooks/arbiter.json` | same | Per docs |
| Cursor | `stop` | `.cursor/hooks.json` | `{"followup_message"}` | Per docs. Cursor caps stop-hook loops at 5 per script by default |
| Gemini CLI / Antigravity | `AfterAgent` | printed, not written | `{"decision":"deny","reason"}` | Per docs. Gemini CLI was retired in June 2026; Antigravity's hook file location is unconfirmed |

"Per docs" means the adapter follows the agent's published hook contract and has not yet been run against the real agent by a maintainer. Field-name differences on stdin (`sessionId`, `conversation_id`, `generation_id`, `turn_id`, `workspace_roots`) are normalised regardless of the flag.

Two hooks for one stop, for example the plugin's and one from `init`, are serialised with a lock and the second replays the first's decision, so one stop never costs two iterations.

## Completion criteria types

Edit the `criteria` array in `.arbiter/task.json`. Each entry has `id`, `type`, `description`, `required`, and `config`.

| Type | What it does | Config |
|------|-------------|--------|
| `tests-pass` | Run the test suite, pass on exit 0 | `{ "command": "npm test" }` |
| `no-ts-errors` | Run `tsc --noEmit` | `{ "tsconfigPath": "tsconfig.json" }` |
| `command` | Run any shell command, pass on exit 0 | `{ "command": "npm run lint" }` |
| `file-exists` | Check a file exists (path-traversal safe) | `{ "path": "src/auth.ts" }` |
| `llm` | Ask the Anthropic API a yes/no question about files | `{ "prompt": "...", "files": ["src/auth.ts"], "model": "...", "timeout": 30000 }` |
| `critic` | Run review personas via the API | `{ "personas": ["spec-drift-review", "ai-code-security-review"], "files": "git-diff" }` |
| `custom` | Load a JS module as evaluator | `{ "path": "my-evaluator.mjs" }` |

`"required": false` makes a criterion advisory: reported, never blocking. `llm` and `critic` need `ANTHROPIC_API_KEY`. A `custom` module exports `async (criteria, payload, cwd) => ({ passed, feedback })` and runs unsandboxed with a 30-second timeout.

## The critic from the CLI

```bash
npx arbiter-cc review                                              # git-diff files, default personas
npx arbiter-cc review --personas hallucinated-api-review,tautological-test-review
npx arbiter-cc review --files src/auth.ts,src/api.ts
npx arbiter-cc review --all
```

Persona ids are the skill names. The 0.1 ids (`correctness`, `edge-cases`, `security`, `hallucinations`, `test-quality`) still work as aliases. Custom personas in `.arbiter/config.json` override built-ins by id:

```json
{
  "critic": {
    "personas": ["spec-drift-review", "api-contracts"],
    "customPersonas": [
      { "id": "api-contracts", "description": "Request/response schemas match the spec", "systemPrompt": "You are reviewing..." }
    ]
  }
}
```

## Configuration

`.arbiter/config.json`, all fields optional, shown with defaults:

```json
{
  "maxIterations": 5,
  "checkpointDir": ".arbiter/checkpoints",
  "taskFile": ".arbiter/task.json",
  "llmModel": "claude-sonnet-5-5",
  "critic": {
    "enabled": false,
    "personas": ["spec-drift-review", "edge-case-review", "ai-code-security-review"],
    "failOnWarnings": false,
    "customPersonas": []
  }
}
```

## CLI reference

```
arbiter-cc init [--agent <id|all>]      Create .arbiter/ and wire the stop hook (default: claude)
arbiter-cc task start "<description>"   Start a task (default criteria: tests-pass, no-ts-errors)
arbiter-cc task status                  Show task state and the last checkpoint
arbiter-cc task clear                   Remove the active task
arbiter-cc check [--agent <id>]         Evaluate the stop hook (reads the agent's payload on stdin)
arbiter-cc checkpoints                  List checkpoints
arbiter-cc checkpoints --restore <id>   git checkout the checkpoint's commit
arbiter-cc review                       Run the critic
```

Flags: `--agent`, `--max-iterations <n>`, `--force`, `--personas <list>`, `--files <list|git-diff|all>`, `--all`.

## Known limitations

- **Task editing** is by hand: edit `.arbiter/task.json`. Malformed JSON fails the next check with exit 1, which lets the agent stop.
- **Test output parsing** is heuristic for `tests-pass`; unusual runners give thinner feedback.
- **File size:** files over 1 MB are skipped; critic context is capped at ~500 lines per file and ~100k characters total.
- **`git-diff` reviews nothing on a clean tree.** The skills fall back to the last commit; the CLI does not yet.
- **`npx` first run** downloads the package, inside the hook's 120-second timeout.
- **Unverified adapters:** see the table above. Reports from anyone who runs one are welcome.
- **No atomic task state:** a process kill mid-evaluation can leave `task.json` inconsistent. `task clear` and start again.

## Development

```bash
npm test                   # no network needed
npm run build
npm run package:skills     # dist/skills/*.zip and *.listing.md for Agensi
npm run check:version      # plugin.json version matches package.json
claude plugin validate . --strict
```

Releases bump `package.json`; `npm version` syncs `.claude-plugin/plugin.json`. The human-only release steps are in [docs/HUMAN-STEPS.md](docs/HUMAN-STEPS.md).

## License

MIT
