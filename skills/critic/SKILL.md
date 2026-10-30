---
name: critic
description: Adversarial code review that runs five independent reviewers in parallel, each in its own context: spec drift, edge cases, security, hallucinated APIs, tautological tests. Use when the user asks for an adversarial, thorough or critic review, wants AI-generated code checked before merging, or asks what the AI got wrong.
argument-hint: "[fix] [files | git ref] [personas=spec-drift-review,edge-case-review,...]"
---

Five reviewers, five fresh contexts, one aggregate. Each persona sees only the code and the task, so a mistake the author's context would rationalise gets caught by a reader who never saw the reasoning.

The personas, each its own skill:

- `spec-drift-review`: does the code do what was asked?
- `edge-case-review`: what input or state breaks it at runtime?
- `ai-code-security-review`: what can an attacker make it do?
- `hallucinated-api-review`: does every package, method and option exist?
- `tautological-test-review`: would the tests fail if the code were wrong?

## Scope

1. **Files.** Those named in the arguments. When the argument is a git ref instead (a branch, tag or commit), the files changed since it (`git diff --name-only <ref>...HEAD`). Otherwise the files changed against HEAD (`git diff --name-only HEAD`); when that list is empty, the last commit (`git diff --name-only HEAD~1 HEAD`). Resolve this once, here, so every persona reviews the same list.
2. **Task description.** From the arguments, the conversation, or the `description` field of `.arbiter/task.json` when present. Without one, pass "no task description; review for general correctness" so each persona says so.
3. **Personas.** All five, unless `personas=` names a subset.
4. Done when you have one scope line: the task, the file list, and the persona list. It opens the report.

## Dispatch

Call the Skill tool once per persona, in the same message so they run concurrently, passing the scope line and the task description as the arguments. Pass no `fix` argument to the personas: fixing is this skill's job after aggregation, so five reviewers never edit the same file at once.

Where the Skill tool is absent, load each persona skill by name from wherever this skill came from and run it in its own subagent with the same scope. Where there is no subagent facility, run the five one after another in this context, each as a complete pass over its own checklist.

Done when every persona has returned a report, or has been recorded as failed to run with the reason.

## Aggregate

Present each persona's report under its own `###` heading, verbatim. Keep them separate: a finding is not reranked or merged across personas, because each measures a different axis and one axis must not mask another. Close with:

```
---
spec-drift-review: 1 error, 0 warnings · edge-case-review: 0 errors, 2 warnings · ai-code-security-review: 0 · hallucinated-api-review: 0 · tautological-test-review: 2 errors, 0 warnings
critic: FAILED (3 errors, 2 warnings across 5 personas)
```

FAILED when any persona reported an error. Done when the totals line is written.

## Fix mode

Without the `fix` argument, deliver the aggregate and stop. With `fix`: deliver the aggregate first, then apply every error-severity fix and any warning whose fix is unambiguous. When two personas flag the same lines, make one change that satisfies both. Then call the Skill tool with "critic" once more, without `fix`, on the files you changed, and append the before and after totals. Edit within the permissions the session already grants: in a read-only or plan session the aggregate is the deliverable even with `fix`.
