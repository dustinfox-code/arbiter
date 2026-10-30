---
name: tautological-test-review
description: Review of AI-generated tests for tests that cannot fail: tautologies, mocked units under test, missing or weak assertions, requirements with no test, brittle coupling to implementation. Use when the user asks whether the tests are real, wants test quality checked, or says the tests pass suspiciously easily.
argument-hint: "[fix] [files | git ref]"
context: fork
---

A test earns its place by failing when the implementation is wrong. For every test, ask what change to the code would make it fail; a test with no such change is the finding.

## Scope

1. **Files.** Test files named in the arguments. When the argument is a git ref instead (a branch, tag or commit), the test files changed since it (`git diff --name-only <ref>...HEAD`). Otherwise the test files changed against HEAD (`git diff --name-only HEAD`); when that list is empty, the last commit (`git diff --name-only HEAD~1 HEAD`). For each test file, also read the unit it tests.
2. **Task description.** From the arguments, the conversation, or the `description` field of `.arbiter/task.json` when present. It is the list of requirements the tests have to cover. Without it, derive the requirements from the unit's public interface and say so.
3. Done when you can open the report with one line naming the test files, the units under test, and the requirement source.

## Review

Work every category of the checklist below. Done when each category has concrete findings or appears in the clean list.

<!-- arbiter:persona:start -->
You are reviewing AI-generated tests for tests that pass regardless of whether the implementation is correct.

Answer every category. For each, report concrete findings with file and line, or name the category in one closing line: `Checked, no issues: <categories>`.

### Checklist

1. **Tautology** — The test asserts what it set up.
   - The unit under test is mocked, so the assertion checks the mock; an assertion on a value the test itself hardcoded; a test of a constant or a type.
2. **Assertion presence and strength** — The test observes a meaningful outcome.
   - Tests with no assertion, or only `toBeDefined`, `toBeTruthy`, `not.toThrow`; a snapshot as the sole assertion on logic; assertions inside a conditional or after an early return that can skip them; `expect.assertions` missing where an async rejection is the point.
3. **Requirement coverage** — Each stated requirement has a test that exercises it.
   - Error handling, validation failures, empty inputs and boundary values named in the task but tested nowhere; a happy-path-only suite for a function whose contract is mostly error cases.
4. **Mutation check** — The test fails when the code is wrong.
   - Mentally replace the return value with a constant, invert each condition, delete each guard: name the tests that would still pass.
5. **Brittle coupling** — The test depends on how rather than what.
   - Assertions on private methods, internal call order, exact log strings or mock call counts in place of observable behaviour; `.only` or `.skip` left behind.
6. **Test hygiene** — Tests that interfere with each other.
   - Shared mutable state across tests, order dependence, fake timers or spies never restored, async tests missing `await` so failures surface after the test has passed.

Severity: `error` for a test that cannot fail or a stated requirement with no test; `warning` for a weak or brittle test; `info` for hygiene. Each finding names the assertion or test case to add or change.
<!-- arbiter:persona:end -->

## Report

Open with the scope line, then:

```
### tautological-test-review — FAILED (2 errors)
- **[ERROR]** tests/auth.test.ts:14 — `verify` is mocked to return `{ ok: true }` and the test asserts `result.ok === true`; the real `verify` is never run.
  Fix: call the real `verify` with a token signed by the test key and assert on the decoded payload.
- **[ERROR]** tests/auth.test.ts — Task requires "reject expired tokens"; no test passes an expired token.
  Fix: add a case with `exp` in the past expecting `TokenExpiredError`.
Checked, no issues: Assertion presence and strength, Mutation check, Brittle coupling, Test hygiene
Summary: one sentence.
```

PASSED when there are no errors.

## Fix mode

Without the `fix` argument, deliver the report and stop. With `fix`, deliver the report, apply every error-severity fix and any warning whose fix is unambiguous, run the test suite, re-run the checklist once on the files you changed, and append what changed. Edit within the permissions the session already grants: in a read-only or plan session the report is the deliverable even with `fix`.
