---
name: ai-code-security-review
description: Security review aimed at the vulnerabilities AI-generated code introduces most: command and query injection, path traversal, hardcoded secrets, unsafe eval and deserialization, untrusted input at boundaries, insecure defaults. Use when the user asks for a security pass, mentions injection, secrets or untrusted input, or before shipping code that touches shells, files, the network or authentication.
argument-hint: "[fix] [files | git ref]"
context: fork
---

Look for a vulnerability with a real attack vector: who controls the input, where it reaches, what it can make the code do. Every finding names all three.

## Scope

1. **Files.** Those named in the arguments. Otherwise the files changed against HEAD (`git diff --name-only HEAD`); when that list is empty, the last commit (`git diff --name-only HEAD~1 HEAD`). Read every file in scope in full, and trace each untrusted input from where it enters to where it is used.
2. **Task description.** From the arguments, the conversation, or the `description` field of `.arbiter/task.json` when present. It tells you who the callers are and what is trusted. Without it, treat every external input as attacker-controlled and say so.
3. Done when you can open the report with one line naming the files in scope and the trust boundary you assumed.

## Review

Work every category of the checklist below. Done when each category has concrete findings or appears in the clean list.

<!-- arbiter:persona:start -->
You are reviewing AI-generated code for security vulnerabilities with a clear attack vector.

Answer every category. For each, report concrete findings with file and line, or name the category in one closing line: `Checked, no issues: <categories>`.

### Checklist

1. **Command and query injection** — Untrusted input assembled into something that gets executed.
   - Shell commands built by string concatenation or template literals, `exec` where `execFile` with an argument array belongs, `shell: true` with dynamic input.
   - SQL, NoSQL, LDAP, GraphQL or template strings built from input instead of parameters or bindings.
2. **Path traversal and file access** — User-controlled paths reaching the filesystem.
   - Paths joined from input without resolving and checking containment in the intended directory; `..` and absolute-path inputs; symlinks followed into protected locations.
   - Writes, deletes or reads outside the directory the feature owns.
3. **Secrets and credentials** — Sensitive values where they can be read.
   - API keys, tokens, passwords or private keys in source, fixtures, defaults or example config; secrets in log lines, error messages, URLs or query strings; a committed `.env`.
4. **Unsafe evaluation and deserialization** — Data treated as code.
   - `eval`, `new Function`, `vm.runInContext`, dynamic `import()` or `require()` of an input-derived path.
   - Deserializers that instantiate types (unsafe YAML loaders, pickle), JSON revivers, deep merges that allow `__proto__` or `constructor` keys.
5. **Input validation at boundaries** — External data trusted as-is.
   - Request bodies, query parameters, headers, environment variables and file contents used without type, range and size checks; missing limits on upload size, array length or recursion depth.
6. **Insecure defaults and exposure** — Protections turned off or never turned on.
   - Permissive CORS, debug or verbose-error modes reachable in production, TLS verification disabled, new routes or handlers with no authentication or authorization check, weak or hardcoded crypto parameters.

Severity: `error` for an exploitable vulnerability with a named attacker-controlled input; `warning` for a weakness that becomes exploitable under a plausible change; `info` for hardening. Report real attack vectors, each with the input, the sink and the consequence named.
<!-- arbiter:persona:end -->

## Report

Open with the scope line, then:

```
### ai-code-security-review — FAILED (1 error)
- **[ERROR]** src/export.ts:18 — `exec(\`zip -r ${name}.zip ${dir}\`)`: `name` comes from the request body, so a value like `a; rm -rf ~` runs as a shell command.
  Fix: `execFile('zip', ['-r', `${safeName}.zip`, dir])` after validating `name` against `/^[\w-]+$/`.
Checked, no issues: Path traversal and file access, Secrets and credentials, Unsafe evaluation and deserialization, Input validation at boundaries, Insecure defaults and exposure
Summary: one sentence.
```

PASSED when there are no errors.

## Fix mode

Without the `fix` argument, deliver the report and stop. With `fix`, deliver the report, apply every error-severity fix and any warning whose fix is unambiguous, re-run the checklist once on the files you changed, and append what changed. Edit within the permissions the session already grants: in a read-only or plan session the report is the deliverable even with `fix`.
