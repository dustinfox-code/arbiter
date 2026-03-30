import { describe, it, expect } from 'vitest'
import { CriteriaEvaluator } from '../../src/loop/evaluator.js'
import type { CompletionCriteria } from '../../src/core/types.js'

describe('CriteriaEvaluator', () => {
  it('evaluates multiple criteria and returns results in order', async () => {
    const criteria: CompletionCriteria[] = [
      {
        id: 'cmd-pass',
        type: 'command',
        description: 'Should pass',
        required: true,
        config: { command: 'true' },
      },
      {
        id: 'cmd-fail',
        type: 'command',
        description: 'Should fail',
        required: true,
        config: { command: 'false' },
      },
    ]

    const evaluator = new CriteriaEvaluator('/tmp', 'claude-sonnet-4-20250514')
    const results = await evaluator.evaluate(criteria)

    expect(results).toHaveLength(2)
    expect(results[0].criteriaId).toBe('cmd-pass')
    expect(results[0].passed).toBe(true)
    expect(results[1].criteriaId).toBe('cmd-fail')
    expect(results[1].passed).toBe(false)
  })

  it('isolates evaluator failures — one error does not block others', async () => {
    const criteria: CompletionCriteria[] = [
      {
        id: 'good',
        type: 'command',
        description: 'Should pass',
        required: true,
        config: { command: 'true' },
      },
      {
        id: 'bad-type',
        type: 'nonexistent' as any,
        description: 'Unknown type',
        required: true,
        config: {},
      },
    ]

    const evaluator = new CriteriaEvaluator('/tmp', 'claude-sonnet-4-20250514')
    const results = await evaluator.evaluate(criteria)

    expect(results).toHaveLength(2)
    expect(results[0].passed).toBe(true)
    expect(results[1].passed).toBe(false)
    expect(results[1].feedback).toContain('Unknown criteria type')
  })
})
