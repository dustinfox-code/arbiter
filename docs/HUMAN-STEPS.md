# Human steps for the 0.2.0 release

Everything below needs an account, a password, or an interactive prompt, so it is yours. Order matters: the plugin's hook runs `npx arbiter-cc check`, which resolves to whatever is on npm, so the npm publish comes first.

## 1. Publish 0.2.0 to npm

```bash
npm run check:version && npm test && npm run build
npm publish
```

Then confirm `npx arbiter-cc@0.2.0 --help` prints the agents list.

## 2. Merge and tag

Merge the PR to `main`, then `git tag v0.2.0 && git push --tags`. The self-hosted marketplace serves whatever is on `main`.

## 3. Verify the plugin from the marketplace

In any project, in Claude Code:

```
/plugin marketplace add dustinfox-code/arbiter
/plugin install arbiter@arbiter
```

Then `arbiter-cc task start "smoke"` with a criterion that fails, ask Claude for something trivial, and watch it get sent back. Done when `arbiter-cc task status` shows `complete` after Claude fixes it.

## 4. Verify the Codex adapter (you have Codex installed)

```bash
mkdir /tmp/arbiter-codex && cd /tmp/arbiter-codex && git init
npx arbiter-cc init --agent codex
npx arbiter-cc task start "create DONE.txt containing done"
```

Edit `.arbiter/task.json` so the only criterion is `{"id":"done-file","type":"file-exists","description":"DONE.txt exists","required":true,"config":{"path":"DONE.txt"}}`. Start `codex` interactively, run `/hooks`, trust the project hook, then ask Codex to reply "hello" and nothing else. If Codex creates `DONE.txt` and `task status` shows `complete` at iteration 2, flip `verified` to `true` for `codex` in `src/core/agents.ts` and the README table.

## 5. Agensi listings

1. Create a creator account at https://www.agensi.io/sell (free listings need no payout setup).
2. `npm run package:skills`. Seven zips and seven `.listing.md` drafts land in `dist/skills/`.
3. For each zip, submit at https://www.agensi.io/dashboard/submit: upload the zip, paste the title, descriptions, category and tags from its `.listing.md`, price **Free**.
4. Their review takes 24 to 48 hours and includes an automated security scan. The skills contain no scripts and no install commands, so they should pass clean; if one is flagged, the scan report says which rule.
5. After approval, connect Agensi in Claude Code (`claude mcp add --transport http agensi https://mcp.agensi.io/mcp/auth`, then `/mcp` → Authenticate) and load one skill through it to see the delivered text.

## 6. Later, optional

- **Official Anthropic plugin directory:** submit from https://claude.ai/directory/manage once the skills have had a few weeks of use. The icon at `.claude-plugin/icon.png` becomes the listing icon the first time you save there, so replace it before that if you want a different one.
- **Cursor and Copilot CLI adapters** are per docs. If you ever install either, run the same smoke test as step 4 and flip `verified`.
- **Antigravity CLI:** `init --agent gemini` prints the snippet. If you learn where Antigravity reads hooks from, teach `wireAgentHook` the path.
