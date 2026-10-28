---
name: loop
description: Definition-of-done loop: agree on completion criteria before the work starts, then verify every one of them, fix, and re-verify until all pass or the iteration budget runs out. Use when the user says "don't stop until", "keep going until the tests pass", "make sure it's actually done", asks for a ralph loop, or wants a task gated on checks rather than on a feeling of being finished.
argument-hint: "<task description> | status"
---

Done is a verified state. Write down what done means before touching code, then hold the work to it: every criterion checked, every failure fixed, re-checked, until all pass or the budget is spent and you report honestly what remains.

This skill is the discipline. Enforcement, a stop hook that evaluates the same `.arbiter/task.json` and sends the agent back when criteria fail, in Claude Code, Codex, Copilot, Gemini and Cursor, comes from the `arbiter-cc` package: https://github.com/dustinfox-code/arbiter

## status

When the argument is `status`: read `.arbiter/task.json` and report the description, status, how many of `maxIterations` passes have been used (the longer of `metadata.loopPasses` and `iteration`), each criterion with required or optional, and the pass and fail lists of the most recent pass. Then stop.

## 1. Capture the task

The argument, or the user's request, is the task. Restate it in one or two sentences that name the observable outcome. Done when the user has not corrected the restatement.

When `.arbiter/task.json` already exists with status `pending` or `running`, say so and ask whether to continue it or replace it, before anything else.

## 2. Propose criteria

Detect the stack from the project and propose criteria. Each criterion is a `command` that must exit 0, a `file-exists` path, or one of the typed checks below. Read the project's own scripts and config rather than guessing the commands.

| Found in the project | Proposed criterion | Required |
|---|---|---|
| `package.json` with a `test` script | `tests-pass`, command from the script and lockfile (`npm test`, `pnpm test`, `yarn test`) | yes |
| `tsconfig.json` | `no-ts-errors` | yes |
| a `lint` or `typecheck` script | `command` running it | no |
| `pyproject.toml` or `pytest.ini` | `command`: `pytest` (plus `mypy` or `ruff check` when configured) | yes |
| `Cargo.toml` | `command`: `cargo test`, and `cargo clippy` optional | yes |
| `go.mod` | `command`: `go test ./...`, and `go vet ./...` optional | yes |
| `Makefile` with a `test` target | `command`: `make test` | yes |
| a requirement in the task that a command or a file's existence can check | `command` or `file-exists` for it | yes |
| non-trivial code changes | `critic` with `files: "git-diff"` | no |

Show the proposal as a list, with each criterion's id, type, command or path, and required flag. Done when the user confirms or amends it.

## 3. Write the task file

Write `.arbiter/task.json`, creating `.arbiter/` as needed. This schema is the contract shared with the stop hook; keep every field:

```json
{
  "id": "<uuid>",
  "description": "<the restated task>",
  "criteria": [
    { "id": "tests-pass", "type": "tests-pass", "description": "All tests pass", "required": true, "config": { "command": "npm test" } },
    { "id": "no-ts-errors", "type": "no-ts-errors", "description": "No TypeScript errors", "required": true, "config": {} },
    { "id": "lint", "type": "command", "description": "Lint is clean", "required": false, "config": { "command": "npm run lint" } },
    { "id": "review", "type": "critic", "description": "Adversarial review finds no errors", "required": false, "config": { "files": "git-diff" } }
  ],
  "status": "pending",
  "iteration": 0,
  "maxIterations": 5,
  "createdAt": "<ISO 8601>",
  "updatedAt": "<ISO 8601>",
  "checkpoints": [],
  "metadata": {}
}
```

When a `.gitignore` exists and lacks them, append `.arbiter/task.json` and `.arbiter/checkpoints/`. Done when the file parses and `status` is `pending`.

## 4. Do the work

Do the task. Set `status` to `running` when you start.

## 5. Verify

Before saying the task is done, evaluate every criterion yourself and record the result. One pass over all criteria is one iteration.

- `command` and `tests-pass`: run the command from `config.command` (`npm test` when absent). Pass on exit 0. On failure keep the failing lines of output; they are the feedback.
- `no-ts-errors`: run the project's installed TypeScript compiler with `--noEmit`, adding `-p <config.tsconfigPath>` when set.
- `file-exists`: the path in `config.path` exists.
- `llm`: judge the prompt in `config.prompt` against the files in `config.files` and state pass or fail with the reason.
- `critic`: call the Skill tool with "critic", passing `config.files` (default `git-diff`) and `config.personas` when set. Pass when no persona reports an error.
- `custom`: a JavaScript module only the stop hook can run; record it as unverified and say so.

Then record the pass by appending to `metadata.loopPasses` in the task file. Leave `iteration` and `checkpoints` alone: they are the stop hook's ledger, and a project with the hook installed would otherwise spend two iterations for every real pass.

```json
{ "at": "<ISO 8601>", "gitHash": "<git rev-parse HEAD, when in a repo>", "passedIds": [], "failedIds": ["tests-pass"], "feedback": { "tests-pass": "<failing lines>" } }
```

- Every required criterion passed: set `status` to `complete` and report.
- A required criterion failed and `metadata.loopPasses` has fewer than `maxIterations` entries: fix what the feedback names, then verify again.
- A required criterion failed and `metadata.loopPasses` has `maxIterations` entries: set `status` to `failed` and report.

A criterion that fails for an environment reason (a missing tool, no network, no API key) is reported as exactly that, with the criterion still marked failed. Done when `status` is `complete` or `failed`.

## 6. Report

```
loop: complete (pass 2 of 5)
- [tests-pass] All tests pass — passed
- [no-ts-errors] No TypeScript errors — passed
- [lint] Lint is clean — passed (optional)
- [review] Adversarial review finds no errors — not run (optional)
```

On `failed`, list what still fails and the last feedback for each, so the user can decide whether to raise the budget or change the criteria.
