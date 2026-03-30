#!/usr/bin/env node

import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { TaskContextManager } from './core/task-manager.js'
import { CheckpointManager } from './core/checkpoint-manager.js'
import { loadConfig } from './core/config.js'
import { runHook } from './core/hook.js'
import { DEFAULT_CONFIG } from './core/types.js'
import type { CompletionCriteria } from './core/types.js'
import { runCritic } from './critic/runner.js'

// ── Argument parsing ──────────────────────────────────────────────

interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }

  return { positional, flags }
}

// ── Commands ──────────────────────────────────────────────────────

async function handleInit(cwd: string): Promise<void> {
  // 1. Create .arbiter/ directory
  const arbiterDir = join(cwd, '.arbiter')
  await mkdir(arbiterDir, { recursive: true })

  // 2. Write default config.json
  const configPath = join(arbiterDir, 'config.json')
  try {
    await access(configPath)
    console.log('.arbiter/config.json already exists — skipping')
  } catch {
    await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
    console.log('Created .arbiter/config.json')
  }

  // 3. Wire stop hook into .claude/settings.json
  const claudeDir = join(cwd, '.claude')
  await mkdir(claudeDir, { recursive: true })
  const settingsPath = join(claudeDir, 'settings.json')

  let settings: Record<string, unknown> = {}
  try {
    const raw = await readFile(settingsPath, 'utf-8')
    settings = JSON.parse(raw) as Record<string, unknown>
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Warning: Could not parse ${settingsPath} — creating new file`)
    }
  }

  // Ensure hooks.Stop structure exists
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {}
  }
  const hooks = settings.hooks as Record<string, unknown>
  if (!Array.isArray(hooks.Stop)) {
    hooks.Stop = []
  }
  const stopHooks = hooks.Stop as Array<Record<string, unknown>>

  // Check if arbiter hook already present
  const alreadyWired = stopHooks.some((entry) => {
    const innerHooks = entry.hooks
    if (!Array.isArray(innerHooks)) return false
    return innerHooks.some((h: Record<string, unknown>) =>
      typeof h.command === 'string' && h.command.includes('arbiter-cc'),
    )
  })

  if (alreadyWired) {
    console.log('Stop hook already wired in .claude/settings.json — skipping')
  } else {
    stopHooks.push({
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: 'npx arbiter-cc check',
          timeout: 120,
        },
      ],
    })
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    console.log('Wired stop hook into .claude/settings.json')
  }

  // 4. Append to .gitignore if it exists
  const gitignorePath = join(cwd, '.gitignore')
  try {
    let content = ''
    try {
      content = await readFile(gitignorePath, 'utf-8')
    } catch {
      // .gitignore doesn't exist — nothing to append to
    }

    if (content) {
      const lines: string[] = []
      if (!content.includes('.arbiter/checkpoints/')) {
        lines.push('.arbiter/checkpoints/')
      }
      if (!content.includes('.arbiter/task.json')) {
        lines.push('.arbiter/task.json')
      }
      if (lines.length > 0) {
        const suffix = content.endsWith('\n') ? '' : '\n'
        await writeFile(gitignorePath, content + suffix + lines.join('\n') + '\n', 'utf-8')
        console.log('Updated .gitignore')
      } else {
        console.log('.gitignore already has arbiter entries — skipping')
      }
    }
  } catch {
    // No .gitignore — that's fine
  }

  // 5. Print CLAUDE.md snippet
  console.log('\n── Add this to your CLAUDE.md ──────────────────────────\n')
  console.log(`## Arbiter

This project uses Arbiter to enforce task completion before stopping.

When you finish a task, Arbiter's stop hook evaluates whether all
required criteria are met. If they aren't, you'll receive a structured
feedback message explaining what's still failing. Address the failures
and complete the work — do not try to stop until Arbiter allows it.

If you believe a criterion is incorrectly failing due to an environment
issue (not a code issue), say so explicitly in your response before
stopping so the developer can investigate.

Current task status: run \`arbiter-cc task status\` to check.`)
  console.log('\n────────────────────────────────────────────────────────\n')
  console.log('Arbiter initialized. Run `arbiter-cc task start "<description>"` to begin.')
}

async function handleTaskStart(cwd: string, args: ParsedArgs): Promise<void> {
  const description = args.positional[0]
  if (!description) {
    console.error('Usage: arbiter-cc task start "<description>" [--max-iterations <n>] [--force]')
    process.exitCode = 1
    return
  }

  const taskManager = new TaskContextManager(cwd)
  const existing = await taskManager.load()

  if (existing && !args.flags.force) {
    console.error(`Error: A task already exists (status: ${existing.status}, iteration ${existing.iteration}/${existing.maxIterations}).`)
    console.error(`  Description: ${existing.description}`)
    console.error(`\nRun 'arbiter-cc task clear' first, or use --force to replace it.`)
    process.exitCode = 1
    return
  }

  if (existing && args.flags.force) {
    await taskManager.clear()
  }

  const maxIterationsStr = args.flags['max-iterations']
  const maxIterationsRaw = typeof maxIterationsStr === 'string' && /^\d+$/.test(maxIterationsStr)
    ? parseInt(maxIterationsStr, 10)
    : typeof maxIterationsStr === 'string'
      ? NaN
      : DEFAULT_CONFIG.maxIterations
  if (isNaN(maxIterationsRaw) || maxIterationsRaw < 1 || maxIterationsRaw > 100 || !Number.isInteger(maxIterationsRaw)) {
    console.error('--max-iterations must be a positive integer')
    process.exitCode = 1
    return
  }
  const maxIterations = maxIterationsRaw

  const defaultCriteria: CompletionCriteria[] = [
    {
      id: 'tests-pass',
      type: 'tests-pass',
      description: 'All tests pass',
      required: true,
      config: { command: 'npm test' },
    },
    {
      id: 'no-ts-errors',
      type: 'no-ts-errors',
      description: 'No TypeScript compilation errors',
      required: true,
      config: {},
    },
  ]

  const task = await taskManager.create(description, defaultCriteria, maxIterations)
  console.log(`Task created: ${task.id}`)
  console.log(`  Description: ${description}`)
  console.log(`  Max iterations: ${maxIterations}`)
  console.log(`  Default criteria: tests-pass, no-ts-errors`)
  console.log(`\nEdit .arbiter/task.json to customize criteria for this task.`)
}

async function handleTaskStatus(cwd: string): Promise<void> {
  const taskManager = new TaskContextManager(cwd)
  const task = await taskManager.load()

  if (!task) {
    console.log('No active task.')
    return
  }

  console.log(`Task: ${task.description}`)
  console.log(`  ID: ${task.id}`)
  console.log(`  Status: ${task.status}`)
  console.log(`  Iteration: ${task.iteration}/${task.maxIterations}`)
  console.log(`  Created: ${task.createdAt}`)
  console.log(`  Updated: ${task.updatedAt}`)

  if (task.checkpoints.length > 0) {
    const last = task.checkpoints[task.checkpoints.length - 1]
    console.log(`\n  Last checkpoint (iteration ${last.iteration}):`)
    console.log(`    Passed: ${last.passedIds.length} (${last.passedIds.join(', ') || 'none'})`)
    console.log(`    Failed: ${last.failedIds.length} (${last.failedIds.join(', ') || 'none'})`)
  } else {
    console.log('\n  No checkpoints yet.')
  }

  console.log(`\n  Criteria:`)
  for (const c of task.criteria) {
    console.log(`    - [${c.id}] ${c.description} (${c.required ? 'required' : 'optional'})`)
  }
}

async function handleTaskClear(cwd: string): Promise<void> {
  const taskManager = new TaskContextManager(cwd)
  await taskManager.clear()
  console.log('Task cleared.')
}

async function handleCheck(cwd: string): Promise<void> {
  await runHook({ cwd })
}

async function handleCheckpoints(cwd: string, args: ParsedArgs): Promise<void> {
  const config = await loadConfig(cwd)
  const checkpointManager = new CheckpointManager(cwd, config.checkpointDir)

  const restoreId = args.flags.restore as string | undefined
  if (restoreId) {
    const checkpoint = await checkpointManager.getById(restoreId)
    if (!checkpoint) {
      console.error(`Checkpoint not found: ${restoreId}`)
      process.exitCode = 1
      return
    }

    if (!checkpoint.gitHash) {
      console.error('Cannot restore: no git hash recorded for this checkpoint.')
      process.exitCode = 1
      return
    }

    // Validate git hash format to prevent command injection
    if (!/^[a-f0-9]{40}$/.test(checkpoint.gitHash)) {
      console.error(`Invalid git hash format: ${checkpoint.gitHash}`)
      process.exitCode = 1
      return
    }

    const { execFileSync } = await import('node:child_process')

    // Verify hash exists in repository before checkout
    try {
      execFileSync('git', ['cat-file', '-e', checkpoint.gitHash], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      console.error(`Git hash not found in repository: ${checkpoint.gitHash.slice(0, 8)}`)
      process.exitCode = 1
      return
    }

    console.log(`Restoring to checkpoint ${checkpoint.id} (git hash: ${checkpoint.gitHash.slice(0, 8)})`)
    try {
      execFileSync('git', ['checkout', checkpoint.gitHash], {
        cwd,
        stdio: 'inherit',
      })
      console.log('Restored.')
    } catch {
      console.error('git checkout failed. You may need to commit or stash your changes first.')
      process.exitCode = 1
    }
    return
  }

  const checkpoints = await checkpointManager.list()
  if (checkpoints.length === 0) {
    console.log('No checkpoints.')
    return
  }

  console.log('Checkpoints:\n')
  for (const cp of checkpoints) {
    const hash = cp.gitHash ? ` (${cp.gitHash.slice(0, 8)})` : ''
    console.log(
      `  [${cp.iteration}] ${cp.id}${hash}  passed: ${cp.passedIds.length}  failed: ${cp.failedIds.length}  ${cp.timestamp}`,
    )
  }
}

async function handleReview(cwd: string, args: ParsedArgs): Promise<void> {
  const config = await loadConfig(cwd)

  // Determine personas: --personas flag (comma-separated) or config default
  const personaIds = typeof args.flags.personas === 'string'
    ? args.flags.personas.split(',').map(s => s.trim()).filter(Boolean)
    : config.critic.personas

  // Determine files: --all flag reviews everything, --files overrides,
  // default is git-diff (files changed in working tree vs HEAD)
  let files: string[] | 'git-diff' | 'all' = 'git-diff'
  if (args.flags.all) {
    files = 'all'
  } else if (typeof args.flags.files === 'string') {
    if (args.flags.files === 'git-diff') {
      files = 'git-diff'
    } else if (args.flags.files === 'all') {
      files = 'all'
    } else {
      files = args.flags.files.split(',').map(s => s.trim()).filter(Boolean)
    }
  }

  // Try to load task description for context (optional)
  const taskManager = new TaskContextManager(cwd)
  const task = await taskManager.load()
  const taskDescription = task?.description ?? 'No task description available — review the code for general quality.'

  console.log(`Arbiter Critic Review`)
  console.log(`=====================\n`)
  console.log(`Personas: ${personaIds.join(', ')}`)
  console.log(`Files: ${typeof files === 'string' ? files : files.join(', ')}`)
  console.log(`Task: ${taskDescription}\n`)

  const result = await runCritic({
    cwd,
    taskDescription,
    files,
    personaIds,
    customPersonas: config.critic.customPersonas,
    llmModel: config.llmModel,
    failOnWarnings: config.critic.failOnWarnings,
  })

  // Print findings grouped by persona
  for (const r of result.results) {
    const status = r.passed ? 'PASSED' : 'FAILED'
    const errors = r.findings.filter(f => f.severity === 'error')
    const warnings = r.findings.filter(f => f.severity === 'warning')
    const infos = r.findings.filter(f => f.severity === 'info')

    const counts: string[] = []
    if (errors.length) counts.push(`${errors.length} error(s)`)
    if (warnings.length) counts.push(`${warnings.length} warning(s)`)
    if (infos.length) counts.push(`${infos.length} info`)
    const countStr = counts.length ? ` (${counts.join(', ')})` : ''

    console.log(`${r.persona} — ${status}${countStr}`)

    if (r.findings.length === 0) {
      console.log('  No findings.\n')
      continue
    }

    for (const group of [
      { label: 'ERROR', items: errors },
      { label: 'WARN', items: warnings },
      { label: 'INFO', items: infos },
    ]) {
      for (const f of group.items) {
        const loc = f.location ? ` ${f.location}` : ''
        console.log(`  ${group.label}${loc} — ${f.message}`)
        if (f.suggestion) {
          console.log(`         Fix: ${f.suggestion}`)
        }
      }
    }
    console.log()
  }

  // Summary
  const totalErrors = result.results.reduce((n, r) => n + r.findings.filter(f => f.severity === 'error').length, 0)
  const totalWarnings = result.results.reduce((n, r) => n + r.findings.filter(f => f.severity === 'warning').length, 0)
  console.log('---')
  console.log(`${totalErrors} error(s), ${totalWarnings} warning(s) across ${result.results.length} persona(s)`)

  if (!result.passed) {
    process.exitCode = 1
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cwd = process.cwd()
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [command, subcommand, ...rest] = positional

  switch (command) {
    case 'init':
      await handleInit(cwd)
      break

    case 'task':
      switch (subcommand) {
        case 'start':
          await handleTaskStart(cwd, {
            positional: rest,
            flags,
          })
          break
        case 'status':
          await handleTaskStatus(cwd)
          break
        case 'clear':
          await handleTaskClear(cwd)
          break
        default:
          console.error('Usage: arbiter-cc task <start|status|clear>')
          process.exitCode = 1
      }
      break

    case 'check':
      await handleCheck(cwd)
      break

    case 'checkpoints':
      await handleCheckpoints(cwd, { positional: rest, flags })
      break

    case 'review':
      await handleReview(cwd, { positional: rest, flags })
      break

    default:
      console.log(`arbiter-cc — Loop agent and critic for Claude Code

Commands:
  init                          Initialize Arbiter in the current project
  task start "<description>"    Start a new task with default criteria
  task status                   Show current task state
  task clear                    Remove the active task
  check                         Manually trigger stop hook evaluation
  checkpoints                   List all checkpoints
  checkpoints --restore <id>    Restore to a checkpoint
  review                        Run adversarial critic review

Flags:
  --max-iterations <n>          Max loop iterations (default: 5)
  --force                       Force task start, replacing existing task
  --personas <list>             Comma-separated personas for review
  --files <list|git-diff|all>   Files to review (default: git-diff)
  --all                         Review all project files (shorthand for --files all)`)
      if (command) {
        process.exitCode = 1
      }
  }
}

main().catch((err) => {
  console.error(`Arbiter error: ${(err as Error).message}`)
  process.exitCode = 1
})
