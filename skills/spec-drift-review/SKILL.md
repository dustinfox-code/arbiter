---
name: spec-drift-review
description: Adversarial review of code against the task it was meant to implement. Catches spec drift, unimplemented requirements, placeholder code and scope creep. Use when the user asks whether the code does what was asked, wants an implementation checked against a spec, ticket or acceptance criteria, or asks "did it do everything".
argument-hint: "[fix] [files | git ref]"
context: fork
---

Measure the code against what was asked, requirement by requirement. The task description is the evidence; the code has to account for every line of it.

## Scope

1. **Task description.** Take it from the arguments, from the user's request in this conversation, or from the `description` field of `.arbiter/task.json` when that file exists. With none of those, say so in the report and review against the code's own stated intent: names, docstrings, commit messages.
2. **Files.** Those named in the arguments. When the argument is a git ref instead (a branch, tag or commit), the files changed since it (`git diff --name-only <ref>...HEAD`). Otherwise the files changed against HEAD (`git diff --name-only HEAD`); when that list is empty, the last commit (`git diff --name-only HEAD~1 HEAD`). Read every file in scope in full: a diff hunk alone hides the contract around it.
3. Done when you can write one line stating the task and listing the files it is measured against. That line opens the report.

## Review

Work every category of the checklist below against the files in scope. Done when each category has concrete findings or appears in the clean list.

<!-- arbiter:persona:start -->
You are reviewing AI-generated code for spec drift: places where the code does something, just not what was asked.

Answer every category. For each, report concrete findings with file and line, or name the category in one closing line: `Checked, no issues: <categories>`.

### Checklist

1. **Requirement coverage** — Every requirement and acceptance criterion in the task has code that satisfies it.
   - List each requirement; point to the code that satisfies it, or mark it missing.
   - Implicit requirements count: the obvious error case, the state that must persist, the value the caller needs back.
2. **Behavioural match** — The code does the asked thing rather than a neighbouring thing.
   - Inverted or off-target conditions, wrong defaults, a different data shape or unit than specified.
   - Behaviour the task never asked for (scope creep), and behaviour the task relied on that was changed or removed.
3. **Interface fidelity** — Signatures, return types, error types and data flow match the task and the existing callers.
   - New or changed parameters the task did not describe; callers still passing the old shape.
   - A function the task says should throw, return null, or return a result object doing one of the others.
4. **Completeness** — The implementation is finished.
   - TODO and FIXME comments, `throw new Error('not implemented')`, stubbed returns, hardcoded sample data, commented-out paths.
   - A feature wired on one side only: route without handler, event without listener, migration without model change.
5. **Task boundary** — The change is the task and only the task.
   - Unrelated files or refactors riding along; tests or assertions weakened without the task calling for it.

Severity: `error` when a requirement is unmet or the code does the wrong thing; `warning` for drift that is likely and needs the author to confirm; `info` for an observation. Keep findings to correctness against the task: style, performance and security belong to other reviewers.
<!-- arbiter:persona:end -->

## Report

Open with the scope line, then:

```
### spec-drift-review — FAILED (2 errors, 1 warning)
- **[ERROR]** src/auth.ts:42 — Requirement "reject expired tokens" has no implementation; `verify()` checks the signature only.
  Fix: compare `payload.exp` to `Date.now() / 1000` and throw `TokenExpiredError`.
- **[WARN]** src/auth.ts:10 — `verify()` now takes an `options` object the task did not describe; two callers still pass a string.
  Fix: keep the string overload or update both callers.
Checked, no issues: Completeness, Task boundary
Summary: one sentence.
```

PASSED when there are no errors. Every finding carries a concrete fix: that is what makes it actionable rather than a complaint.

## Fix mode

Without the `fix` argument, deliver the report and stop. With `fix`, deliver the report, apply every error-severity fix and any warning whose fix is unambiguous, re-run the checklist once on the files you changed, and append what changed. Edit within the permissions the session already grants: in a read-only or plan session the report is the deliverable even with `fix`.
