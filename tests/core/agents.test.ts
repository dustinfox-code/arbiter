import { describe, it, expect } from 'vitest'
import { emitForAgent, parseAgentId, AGENT_IDS } from '../../src/core/agents.js'
import type { HookResult } from '../../src/core/types.js'

function result(overrides: Partial<HookResult>): HookResult {
  return {
    decision: 'proceed',
    iteration: 1,
    passedCriteria: [],
    failedCriteria: [],
    summary: 'summary',
    ...overrides,
  }
}

describe('emitForAgent', () => {
  it('proceed → silent, exit 0', () => {
    expect(emitForAgent(result({ decision: 'proceed' }), 'claude')).toEqual({ stdout: '', exitCode: 0 })
  })

  it('error → silent, exit 1 so the agent treats it as non-blocking', () => {
    expect(emitForAgent(result({ decision: 'error' }), 'claude')).toEqual({ stdout: '', exitCode: 1 })
  })

  it('loop → Claude block JSON with feedback as reason, exit 0', () => {
    const out = emitForAgent(result({ decision: 'loop', feedback: '## Arbiter: Criteria Not Met\n- [x] y' }), 'claude')
    expect(out.exitCode).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual({ decision: 'block', reason: '## Arbiter: Criteria Not Met\n- [x] y' })
  })

  it('loop without feedback falls back to the summary', () => {
    const out = emitForAgent(result({ decision: 'loop', summary: '2 failed' }), 'claude')
    expect(JSON.parse(out.stdout).reason).toBe('2 failed')
  })

  it('defaults to claude', () => {
    const out = emitForAgent(result({ decision: 'loop', feedback: 'f' }))
    expect(JSON.parse(out.stdout).decision).toBe('block')
  })
})

describe('parseAgentId', () => {
  it('accepts every known id', () => {
    for (const id of AGENT_IDS) expect(parseAgentId(id)).toBe(id)
  })

  it('rejects unknown ids and lists the valid ones', () => {
    expect(() => parseAgentId('vim')).toThrow(/Unknown agent "vim"/)
    expect(() => parseAgentId('vim')).toThrow(/claude/)
    expect(() => parseAgentId(undefined)).toThrow()
  })
})
