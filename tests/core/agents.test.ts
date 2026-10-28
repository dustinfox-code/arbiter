import { describe, it, expect } from 'vitest'
import { emitForAgent, normalizeStopPayload, parseAgentId, AGENT_IDS, AGENT_INFO } from '../../src/core/agents.js'
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

  it('codex and copilot share the Claude block shape', () => {
    for (const agent of ['codex', 'copilot'] as const) {
      const out = emitForAgent(result({ decision: 'loop', feedback: 'f' }), agent)
      expect(out.exitCode).toBe(0)
      expect(JSON.parse(out.stdout)).toEqual({ decision: 'block', reason: 'f' })
    }
  })

  it('gemini uses decision: deny', () => {
    const out = emitForAgent(result({ decision: 'loop', feedback: 'f' }), 'gemini')
    expect(JSON.parse(out.stdout)).toEqual({ decision: 'deny', reason: 'f' })
  })

  it('cursor uses followup_message', () => {
    const out = emitForAgent(result({ decision: 'loop', feedback: 'f' }), 'cursor')
    expect(JSON.parse(out.stdout)).toEqual({ followup_message: 'f' })
  })

  it('proceed and error are silent for every agent', () => {
    for (const agent of AGENT_IDS) {
      expect(emitForAgent(result({ decision: 'proceed' }), agent)).toEqual({ stdout: '', exitCode: 0 })
      expect(emitForAgent(result({ decision: 'error' }), agent)).toEqual({ stdout: '', exitCode: 1 })
    }
  })

  it('every agent has info with an event and a verification flag', () => {
    for (const agent of AGENT_IDS) {
      expect(AGENT_INFO[agent].event).toBeTruthy()
      expect(typeof AGENT_INFO[agent].verified).toBe('boolean')
    }
    expect(AGENT_INFO.claude.verified).toBe(true)
    expect(AGENT_INFO.codex.verified).toBe(false)
    expect(AGENT_INFO.gemini.configPath).toBeNull()
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

describe('normalizeStopPayload', () => {
  it('leaves a Claude/Codex payload as it is', () => {
    const p = normalizeStopPayload({ session_id: 's', cwd: '/w', prompt_id: 'p', stop_hook_active: true, extra: 1 })
    expect(p.session_id).toBe('s')
    expect(p.cwd).toBe('/w')
    expect(p.prompt_id).toBe('p')
    expect(p.stop_hook_active).toBe(true)
    expect(p.extra).toBe(1)
  })

  it('maps Codex turn_id to prompt_id', () => {
    expect(normalizeStopPayload({ session_id: 's', turn_id: 't1' }).prompt_id).toBe('t1')
  })

  it('maps Copilot camelCase fields', () => {
    const p = normalizeStopPayload({ sessionId: 'cs', cwd: '/w', transcriptPath: '/t', stopReason: 'end_turn' })
    expect(p.session_id).toBe('cs')
    expect(p.transcript_path).toBe('/t')
    expect(p.prompt_id).toBeUndefined()
  })

  it('maps Cursor conversation_id, generation_id and workspace_roots', () => {
    const p = normalizeStopPayload({ conversation_id: 'c', generation_id: 'g', workspace_roots: ['/root', '/other'], loop_count: 2 })
    expect(p.session_id).toBe('c')
    expect(p.prompt_id).toBe('g')
    expect(p.cwd).toBe('/root')
    expect(p.stop_hook_active).toBe(false)
  })

  it('yields an empty session_id when no alias is present, so nothing is cached', () => {
    expect(normalizeStopPayload({ foo: 'bar' }).session_id).toBe('')
  })
})
