# Changelog

## 0.2.0 — 2026-10-28

### Added
- Seven skills in `skills/`: five review personas, `critic`, and `loop`. Pure markdown, usable in any agent that reads SKILL.md.
- Claude Code plugin (`.claude-plugin/`, `hooks/hooks.json`) and a self-hosted marketplace: `/plugin install arbiter --marketplace dustinfox-code/arbiter`.
- `check --agent` and `init --agent` for Codex, Copilot CLI, Cursor and Gemini/Antigravity, plus `init --agent all`. Stdin field names from every agent are normalised.
- `npm run package:skills`: Agensi-ready zips and listing drafts.
- `scripts/sync-plugin-version.mjs`, run by `npm version`.

### Changed
- Persona ids are now the skill names. `correctness`, `edge-cases`, `security`, `hallucinations`, `test-quality` remain as aliases.
- Persona prompts load from the skill files; `BUILT_IN_PERSONAS` is replaced by `getBuiltInPersonas()`.
- Default `llmModel` is `claude-sonnet-5-5`; `@anthropic-ai/sdk` is `^1.3.0`.
- `ClaudeStopPayload` is renamed `StopPayload` (alias kept).
- Clean checklist categories are reported as one `info` finding instead of one per category.

### Fixed
- The stop hook wrote its feedback to stdout on exit 2, but agents feed stderr to the model on exit 2, so the model never saw which criteria failed. The hook now exits 0 with `{"decision":"block","reason":<feedback>}`.
- Two hooks for one stop (plugin plus `init`) each ran `check` and burned two iterations. `check` is now locked and idempotent per stop event.
