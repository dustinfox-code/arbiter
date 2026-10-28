import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HookInterface, runHook } from '../../src/core/hook.js'
import type { TaskContext, CompletionCriteria } from '../../src/core/types.js'

describe('HookInterface', () => {
  let tempDir: string
  let hook: HookInterface

  // Capture process.stdout/stderr writes
  let stdoutData: string
  let stderrData: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'arbiter-test-'))
    await mkdir(join(tempDir, '.arbiter'), { recursive: true })
    await writeFile(
      join(tempDir, '.arbiter', 'config.json'),
      JSON.stringify({ taskFile: '.arbiter/task.json', checkpointDir: '.arbiter/checkpoints' }),
    )
    hook = new HookInterface()
    stdoutData = ''
    stderrData = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutData += data
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrData += data
      return true
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    process.exitCode = undefined
    await rm(tempDir, { recursive: true, force: true })
  })

  async function loadTask(): Promise<TaskContext> {
    const raw = await readFile(join(tempDir, '.arbiter', 'task.json'), 'utf-8')
    return JSON.parse(raw) as TaskContext
  }

  function payloadFor(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: tempDir,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      ...overrides,
    })
  }

  const failingCriteria: CompletionCriteria[] = [
    {
      id: 'cmd-fail',
      type: 'command',
      description: 'Should fail',
      required: true,
      config: { command: 'echo "broken" && exit 1' },
    },
  ]

  function writeTask(task: TaskContext): Promise<void> {
    return writeFile(
      join(tempDir, '.arbiter', 'task.json'),
      JSON.stringify(task, null, 2),
    )
  }

  function makeTask(overrides?: Partial<TaskContext>): TaskContext {
    return {
      id: 'test-task',
      description: 'Test task',
      criteria: [
        {
          id: 'cmd-pass',
          type: 'command',
          description: 'Should pass',
          required: true,
          config: { command: 'true' },
        },
      ],
      status: 'pending',
      iteration: 0,
      maxIterations: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      checkpoints: [],
      metadata: {},
      ...overrides,
    }
  }

  it('proceeds when no task exists', async () => {
    const result = await hook.run({ cwd: tempDir, stdinData: '' })
    expect(result.decision).toBe('proceed')
    expect(stderrData).toContain('No active task')
  })

  it('proceeds when task is already complete', async () => {
    await writeTask(makeTask({ status: 'complete' }))
    const result = await hook.run({ cwd: tempDir, stdinData: '' })
    expect(result.decision).toBe('proceed')
    expect(stderrData).toContain('already complete')
  })

  it('proceeds when task is already failed', async () => {
    await writeTask(makeTask({ status: 'failed' }))
    const result = await hook.run({ cwd: tempDir, stdinData: '' })
    expect(result.decision).toBe('proceed')
  })

  it('marks task failed when max iterations reached', async () => {
    await writeTask(makeTask({ iteration: 5, maxIterations: 5, status: 'running' }))
    const result = await hook.run({ cwd: tempDir, stdinData: '' })
    expect(result.decision).toBe('proceed')
    expect(stderrData).toContain('Max iterations')

    const raw = await readFile(join(tempDir, '.arbiter', 'task.json'), 'utf-8')
    const task = JSON.parse(raw) as TaskContext
    expect(task.status).toBe('failed')
  })

  it('marks task complete when all required criteria pass', async () => {
    await writeTask(makeTask())
    const result = await hook.run({ cwd: tempDir, stdinData: '' })
    expect(result.decision).toBe('proceed')
    expect(result.passedCriteria).toContain('cmd-pass')
    expect(stderrData).toContain('task complete')

    const raw = await readFile(join(tempDir, '.arbiter', 'task.json'), 'utf-8')
    const task = JSON.parse(raw) as TaskContext
    expect(task.status).toBe('complete')
    expect(task.iteration).toBe(1)
  })

  it('loops when required criteria fail, carrying the feedback on the result', async () => {
    await writeTask(makeTask({ criteria: failingCriteria }))
    const result = await hook.run({ cwd: tempDir, stdinData: '' })
    expect(result.decision).toBe('loop')
    expect(result.failedCriteria).toContain('cmd-fail')
    expect(result.feedback).toContain('Criteria Not Met')
    expect(result.feedback).toContain('Iteration 1/5')
    expect(result.feedback).toContain('broken')
    // run() never writes the decision itself — runHook does, via the agent adapter
    expect(stdoutData).toBe('')
  })

  describe('runHook transport', () => {
    it('blocks via JSON on stdout with the full feedback as reason, exit 0', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      await runHook({ cwd: tempDir, stdinData: '' })

      expect(process.exitCode).toBe(0)
      const parsed = JSON.parse(stdoutData) as { decision: string; reason: string }
      expect(parsed.decision).toBe('block')
      // This is the regression: the model reads `reason`, so the criteria detail must be here
      expect(parsed.reason).toContain('Criteria Not Met')
      expect(parsed.reason).toContain('[cmd-fail]')
      expect(parsed.reason).toContain('broken')
    })

    it('allows the stop with no stdout and exit 0 when criteria pass', async () => {
      await writeTask(makeTask())
      await runHook({ cwd: tempDir, stdinData: '' })
      expect(process.exitCode).toBe(0)
      expect(stdoutData).toBe('')
    })

    it('speaks Cursor: followup_message, from a Cursor-shaped payload', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      const cursorPayload = JSON.stringify({ conversation_id: 'c1', generation_id: 'g1', workspace_roots: [tempDir], status: 'completed', loop_count: 0 })
      await runHook({ stdinData: cursorPayload, agent: 'cursor' })
      expect(process.exitCode).toBe(0)
      const parsed = JSON.parse(stdoutData) as Record<string, string>
      expect(Object.keys(parsed)).toEqual(['followup_message'])
      expect(parsed.followup_message).toContain('[cmd-fail]')
      const task = await loadTask()
      expect((task.metadata.lastStop as { sessionId: string; promptId: string }).sessionId).toBe('c1')
      expect((task.metadata.lastStop as { sessionId: string; promptId: string }).promptId).toBe('g1')
    })

    it('speaks Gemini: decision deny', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      await runHook({ cwd: tempDir, stdinData: payloadFor(), agent: 'gemini' })
      const parsed = JSON.parse(stdoutData) as { decision: string; reason: string }
      expect(parsed.decision).toBe('deny')
      expect(parsed.reason).toContain('Criteria Not Met')
    })

    it('speaks Codex and Copilot: decision block', async () => {
      for (const agent of ['codex', 'copilot'] as const) {
        stdoutData = ''
        await writeTask(makeTask({ criteria: failingCriteria }))
        await runHook({ cwd: tempDir, stdinData: '', agent })
        expect(JSON.parse(stdoutData).decision, agent).toBe('block')
      }
    })

    it('exits 1 (non-blocking) on a malformed payload', async () => {
      await writeTask(makeTask())
      await runHook({ cwd: tempDir, stdinData: '{not json' })
      expect(process.exitCode).toBe(1)
      expect(stdoutData).toBe('')
      expect(stderrData).toContain('Failed to parse')
    })
  })

  describe('idempotency per stop event', () => {
    it('replays the cached decision for the same session and prompt without re-evaluating', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))

      const first = await hook.run({ stdinData: payloadFor({ prompt_id: 'p1' }) })
      expect(first.decision).toBe('loop')
      expect(first.iteration).toBe(1)
      expect(first.replayed).toBeUndefined()

      const second = await hook.run({ stdinData: payloadFor({ prompt_id: 'p1' }) })
      expect(second.decision).toBe('loop')
      expect(second.iteration).toBe(1)
      expect(second.replayed).toBe(true)
      expect(second.feedback).toBe(first.feedback)
      expect(stderrData).toContain('Replaying')

      expect((await loadTask()).iteration).toBe(1)

      // A new prompt is a new stop: evaluate again
      const third = await hook.run({ stdinData: payloadFor({ prompt_id: 'p2' }) })
      expect(third.replayed).toBeUndefined()
      expect(third.iteration).toBe(2)
    })

    it('a later stop in the same turn (stop_hook_active flips) is evaluated, not replayed', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      const first = await hook.run({ stdinData: payloadFor({ prompt_id: 'p1', stop_hook_active: false }) })
      expect(first.iteration).toBe(1)
      // Agent was blocked, did work, stops again: same session, same prompt, flag now true
      const second = await hook.run({ stdinData: payloadFor({ prompt_id: 'p1', stop_hook_active: true }) })
      expect(second.replayed).toBeUndefined()
      expect(second.iteration).toBe(2)
    })

    it('a later stop with a different assistant message is evaluated, not replayed', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      await hook.run({ stdinData: payloadFor({ prompt_id: 'p1', stop_hook_active: true, last_assistant_message: 'tried once' }) })
      const next = await hook.run({ stdinData: payloadFor({ prompt_id: 'p1', stop_hook_active: true, last_assistant_message: 'tried twice' }) })
      expect(next.replayed).toBeUndefined()
      expect(next.iteration).toBe(2)
      const same = await hook.run({ stdinData: payloadFor({ prompt_id: 'p1', stop_hook_active: true, last_assistant_message: 'tried twice' }) })
      expect(same.replayed).toBe(true)
      expect(same.iteration).toBe(2)
    })

    it('falls back to a time window when prompt_id is absent', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))

      const first = await hook.run({ stdinData: payloadFor(), replayWindowMs: 1000 })
      const second = await hook.run({ stdinData: payloadFor(), replayWindowMs: 1000 })
      expect(first.iteration).toBe(1)
      expect(second.replayed).toBe(true)

      await new Promise(r => setTimeout(r, 1300))
      const third = await hook.run({ stdinData: payloadFor(), replayWindowMs: 1000 })
      expect(third.replayed).toBeUndefined()
      expect(third.iteration).toBe(2)
    })

    it('does not replay across sessions', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      await hook.run({ stdinData: payloadFor({ session_id: 'a', prompt_id: 'p1' }) })
      const other = await hook.run({ stdinData: payloadFor({ session_id: 'b', prompt_id: 'p1' }) })
      expect(other.replayed).toBeUndefined()
      expect(other.iteration).toBe(2)
    })

    it('never caches a hand-run check with no payload', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      await hook.run({ cwd: tempDir, stdinData: '' })
      const again = await hook.run({ cwd: tempDir, stdinData: '' })
      expect(again.replayed).toBeUndefined()
      expect(again.iteration).toBe(2)
    })

    it('two concurrent hooks for one stop evaluate exactly once', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      const payload = payloadFor({ prompt_id: 'p1' })

      const [a, b] = await Promise.all([
        new HookInterface().run({ stdinData: payload }),
        new HookInterface().run({ stdinData: payload }),
      ])

      expect(a.decision).toBe('loop')
      expect(b.decision).toBe('loop')
      expect(a.feedback).toBe(b.feedback)
      expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1)
      expect((await loadTask()).iteration).toBe(1)
    })

    it('fails open (error, not block) if the lock cannot be acquired in time', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      await writeFile(join(tempDir, '.arbiter', 'task.json.lock'), '{"pid":1}')
      const result = await hook.run({ stdinData: payloadFor(), lockTimeoutMs: 150 })
      expect(result.decision).toBe('error')
      expect(stderrData).toContain('failing open')
      expect((await loadTask()).iteration).toBe(0)
    })

    it('gives the iteration back when evaluation crashes', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      // An unreadable checkpoint directory makes the checkpoint write throw
      await writeFile(join(tempDir, '.arbiter', 'checkpoints'), 'not a directory')
      await expect(hook.run({ cwd: tempDir, stdinData: '' })).rejects.toThrow()
      const task = await loadTask()
      expect(task.iteration).toBe(0)
      expect(task.status).toBe('pending')
    })

    it('records stop_hook_active with the last stop', async () => {
      await writeTask(makeTask({ criteria: failingCriteria }))
      await hook.run({ stdinData: payloadFor({ prompt_id: 'p1', stop_hook_active: true }) })
      const task = await loadTask()
      const last = task.metadata.lastStop as { stopHookActive: boolean; sessionId: string; promptId: string }
      expect(last.stopHookActive).toBe(true)
      expect(last.sessionId).toBe('sess-1')
      expect(last.promptId).toBe('p1')
      expect(stderrData).toContain('continuing from an earlier stop hook')
    })
  })

  it('writes a checkpoint on evaluation', async () => {
    await writeTask(makeTask())
    await hook.run({ cwd: tempDir, stdinData: '' })

    const raw = await readFile(join(tempDir, '.arbiter', 'task.json'), 'utf-8')
    const task = JSON.parse(raw) as TaskContext
    expect(task.checkpoints).toHaveLength(1)
    expect(task.checkpoints[0].iteration).toBe(1)
  })

  it('parses stdin payload and uses its cwd', async () => {
    await writeTask(makeTask())
    const payload = JSON.stringify({
      session_id: 'test-session',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: tempDir,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    })
    const result = await hook.run({ stdinData: payload })
    // Should still work since payload.cwd points to tempDir
    expect(result.decision).toBe('proceed')
  })

  it('non-blocking warnings do not cause loop', async () => {
    const mixedCriteria: CompletionCriteria[] = [
      {
        id: 'cmd-pass',
        type: 'command',
        description: 'Required - passes',
        required: true,
        config: { command: 'true' },
      },
      {
        id: 'cmd-warn',
        type: 'command',
        description: 'Optional - fails',
        required: false,
        config: { command: 'false' },
      },
    ]
    await writeTask(makeTask({ criteria: mixedCriteria }))
    const result = await hook.run({ cwd: tempDir, stdinData: '' })
    expect(result.decision).toBe('proceed')
    expect(result.passedCriteria).toContain('cmd-pass')
    expect(result.failedCriteria).toContain('cmd-warn')
  })
})
