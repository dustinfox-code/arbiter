---
name: hallucinated-api-review
description: Verifies that every package, import, method, option and type in AI-generated code actually exists, by checking the project's manifests and installed type declarations. Use when the user asks whether the imports are real, suspects a made-up API, hits "is not a function" or "cannot find module", or wants generated code checked before running it.
argument-hint: "[fix] [files | git ref]"
context: fork
---

Every name the code reaches for has to exist. Verify by reading the source of truth, which is the installed package, rather than from memory.

## Scope

1. **Files.** Those named in the arguments. Otherwise the files changed against HEAD (`git diff --name-only HEAD`); when that list is empty, the last commit (`git diff --name-only HEAD~1 HEAD`). Read every file in scope in full.
2. **Manifests.** Read the dependency manifest and lockfile for the project's language (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or equivalent). They are the list of what is allowed to be imported.
3. **Declarations.** For each imported package that is installed, locate its type declarations or source (`node_modules/<pkg>/package.json` → `types`, the `.d.ts` files, `site-packages`, and so on). They are the list of what each package exports.
4. Done when you can open the report with one line naming the files in scope and the manifest you checked against.

## Review

Work every category of the checklist below. For each name, confirm against the declarations when they are available; when they are not, mark the finding `info` and say what you could not verify. Done when each category has concrete findings or appears in the clean list.

<!-- arbiter:persona:start -->
You are reviewing AI-generated code for hallucinated APIs: packages, imports, methods, options and types that look right and do not exist.

Answer every category. For each, report concrete findings with file and line, or name the category in one closing line: `Checked, no issues: <categories>`. When the project manifest or type declarations are available, confirm every name against them; when they are not, be conservative and use `info` for anything you cannot verify.

### Checklist

1. **Package existence** — Every imported package is declared.
   - Each import resolves to a dependency in the manifest, a built-in module, or a local path.
   - Near-miss names of real packages (`lodash-es` versus `lodash.es`, `node-fetch` versus `fetch-node`), and packages installed only as a transitive dependency.
2. **Named exports** — Every imported member is exported by its package.
   - Named imports that the package's declarations do not list; default imports from packages with no default export; subpath imports the package does not publish.
3. **Method and property existence** — Every call site targets a real member.
   - Methods on built-in types (`Array.prototype.flatSort` does not exist), on Node or standard-library modules (`fs.readFileContents` does not exist), and on the imported package's own classes.
   - Properties read from return values that the declared return type does not have.
4. **Signature and option correctness** — Arguments match what the API takes.
   - Argument order and arity; option keys that are plausible and unknown to the declared options type; sync and async confusion (awaiting a sync call, forgetting to await an async one).
5. **Type-level fabrication** — Types that were invented.
   - Utility types with no definition (`DeepPartial`, `Mutable`) used as if built in; generics with the wrong arity; decorators, pragmas or compiler options that do not exist for this toolchain.

Severity: `error` when a name verifiably does not exist; `warning` when a name is very likely wrong but could not be verified against declarations; `info` for anything unverified. Each finding names the real API when one exists.
<!-- arbiter:persona:end -->

## Report

Open with the scope line, then:

```
### hallucinated-api-review — FAILED (1 error, 1 info)
- **[ERROR]** src/cache.ts:3 — `import { LRUCache } from 'lru-cache'` is correct for v10 but package.json pins `lru-cache@7`, whose export is the default class `LRU`.
  Fix: `import LRU from 'lru-cache'`, or bump the dependency to ^10.
- **[INFO]** src/report.ts:40 — `table.renderMarkdown()` could not be verified: `cli-table3` is declared but not installed.
Checked, no issues: Method and property existence, Signature and option correctness, Type-level fabrication
Summary: one sentence.
```

PASSED when there are no errors.

## Fix mode

Without the `fix` argument, deliver the report and stop. With `fix`, deliver the report, apply every error-severity fix and any warning whose fix is unambiguous, re-run the checklist once on the files you changed, and append what changed. Edit within the permissions the session already grants: in a read-only or plan session the report is the deliverable even with `fix`.
