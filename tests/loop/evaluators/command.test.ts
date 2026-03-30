import { describe, it, expect } from 'vitest'
import { evaluateCommand } from '../../../src/loop/evaluators/command.js'
import type { CompletionCriteria } from '../../../src/core/types.js'

function makeCriteria(command: string): CompletionCriteria {
  return {
    id: 'test-cmd',
    type: 'command',
    description: 'Test command',
    required: true,
    config: { command },
  }
}

describe('evaluateCommand', () => {
  it('passes on exit 0', async () => {
    const result = await evaluateCommand(makeCriteria('true'), '/tmp')
    expect(result.passed).toBe(true)
    expect(result.criteriaId).toBe('test-cmd')
  })

  it('fails on non-zero exit', async () => {
    const result = await evaluateCommand(makeCriteria('false'), '/tmp')
    expect(result.passed).toBe(false)
    expect(result.feedback).toContain('Command failed')
  })

  it('captures stderr/stdout in feedback', async () => {
    const result = await evaluateCommand(
      makeCriteria('echo "some output" && exit 1'),
      '/tmp',
    )
    expect(result.passed).toBe(false)
    expect(result.feedback).toContain('some output')
  })

  it('records duration', async () => {
    const result = await evaluateCommand(makeCriteria('true'), '/tmp')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})
