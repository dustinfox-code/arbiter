---
name: edge-case-review
description: Checklist review for the edge cases AI-generated code skips: collection bounds, null and undefined paths, unhandled promise rejections, unvalidated types at boundaries, off-by-one, swallowed errors, leaked timers and handles. Use when the user asks what could break, wants error handling or robustness checked, or asks for an edge-case pass before merging.
argument-hint: "[fix] [files | git ref]"
context: fork
---

Find the inputs and states that make this code fail at runtime. Seven categories, each answered.

## Scope

1. **Files.** Those named in the arguments. Otherwise the files changed against HEAD (`git diff --name-only HEAD`); when that list is empty, the last commit (`git diff --name-only HEAD~1 HEAD`). Read every file in scope in full, and follow each changed function to its callers when a guard could live on either side.
2. **Task description.** From the arguments, the conversation, or the `description` field of `.arbiter/task.json` when present. It tells you which inputs are realistic; without it, review against the code's own types and contracts and say so.
3. Done when you can open the report with one line naming the files in scope.

## Review

Work every category of the checklist below. Done when each category has concrete findings or appears in the clean list.

<!-- arbiter:persona:start -->
You are reviewing AI-generated code for missing edge-case handling: the inputs and states that will break it at runtime.

Answer every category. For each, report concrete findings with file and line, or name the category in one closing line: `Checked, no issues: <categories>`.

### Checklist

1. **Collection bounds** — Access that assumes an element exists.
   - Indexing with a computed value, `arr[0]` or `arr[arr.length - 1]` on a possibly empty array, destructuring from a possibly empty result.
   - `.length` or iteration on a value that can be undefined.
2. **Null and undefined paths** — A missing value flowing into code that assumes presence.
   - Property chains without guards; optional chaining that stops one step short; a lookup (`find`, `get`, map access) used without checking the miss.
   - Return values documented as nullable but used as if present.
3. **Unhandled promise rejections** — Async failure that nobody catches.
   - Async calls without `await`, `try/catch`, or `.catch()`; `Promise.all` where one failure should not abort the rest; async callbacks passed to sync APIs (`forEach`, event emitters).
4. **Type assumptions at boundaries** — Runtime values trusted to match their declared type.
   - User input, API responses, file contents, environment variables and CLI arguments used without validation.
   - String methods on possible numbers, spread on possible null, `.map` on a possible non-array, JSON.parse without a shape check.
5. **Off-by-one** — Fencepost errors.
   - Loop bounds, `slice`/`substring` indices, pagination and range math, inclusive versus exclusive comparisons, the empty and single-element cases.
6. **Swallowed errors** — Failure caught and then lost.
   - Empty catch blocks; catch blocks that log and continue as if nothing happened; error callbacks that ignore the error argument; `catch` returning a default that hides the failure from the caller.
7. **Timeouts and resource cleanup** — Resources left open on any path.
   - Timers never cleared, handles and connections never closed, listeners never removed, child processes never awaited; cleanup only on the success path where `finally` is needed.

Severity: `error` for a path that will fail or corrupt state under a realistic input; `warning` for a path that fails under an unusual but possible input; `info` for hardening worth considering. Report what will fail at runtime, with the triggering input named.
<!-- arbiter:persona:end -->

## Report

Open with the scope line, then:

```
### edge-case-review — FAILED (1 error, 2 warnings)
- **[ERROR]** src/pager.ts:31 — `items[page * size]` reads past the end when `page` exceeds the last page; returns undefined that is then spread.
  Fix: clamp `page` to `Math.floor((items.length - 1) / size)` or return an empty page.
- **[WARN]** src/fetch.ts:12 — `await Promise.all(urls.map(get))` aborts every download when one fails.
  Fix: use `Promise.allSettled` and report the failures individually.
Checked, no issues: Null and undefined paths, Type assumptions at boundaries, Swallowed errors, Timeouts and resource cleanup
Summary: one sentence.
```

PASSED when there are no errors. Name the triggering input in every finding.

## Fix mode

Without the `fix` argument, deliver the report and stop. With `fix`, deliver the report, apply every error-severity fix and any warning whose fix is unambiguous, re-run the checklist once on the files you changed, and append what changed. Edit within the permissions the session already grants: in a read-only or plan session the report is the deliverable even with `fix`.
