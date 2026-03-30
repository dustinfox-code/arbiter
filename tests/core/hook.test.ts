import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HookInterface } from '../../src/core/hook.js'
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
    await rm(tempDir, { recursive: true, force: true })
  })

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

  it('loops when required criteria fail', async () => {
    const failingCriteria: CompletionCriteria[] = [
      {
        id: 'cmd-fail',
        type: 'command',
        description: 'Should fail',
        required: true,
        config: { command: 'echo "broken" && exit 1' },
      },
    ]
    await writeTask(makeTask({ criteria: failingCriteria }))
    const result = await hook.run({ cwd: tempDir, stdinData: '' })
    expect(result.decision).toBe('loop')
    expect(result.failedCriteria).toContain('cmd-fail')
    expect(stdoutData).toContain('Criteria Not Met')
    expect(stdoutData).toContain('Iteration 1/5')
    expect(stdoutData).toContain('broken')
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
