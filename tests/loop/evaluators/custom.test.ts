import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluateCustom } from '../../../src/loop/evaluators/custom.js'
import type { CompletionCriteria } from '../../../src/core/types.js'

describe('evaluateCustom', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'arbiter-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('passes when custom evaluator returns { passed: true }', async () => {
    await writeFile(
      join(tempDir, 'evaluator.mjs'),
      'export default async () => ({ passed: true })',
    )
    const criteria: CompletionCriteria = {
      id: 'custom-check',
      type: 'custom',
      description: 'Custom check',
      required: true,
      config: { path: 'evaluator.mjs' },
    }
    const result = await evaluateCustom(criteria, tempDir)
    expect(result.passed).toBe(true)
  })

  it('fails when custom evaluator returns { passed: false, feedback }', async () => {
    await writeFile(
      join(tempDir, 'evaluator.mjs'),
      'export default async () => ({ passed: false, feedback: "things are bad" })',
    )
    const criteria: CompletionCriteria = {
      id: 'custom-check',
      type: 'custom',
      description: 'Custom check',
      required: true,
      config: { path: 'evaluator.mjs' },
    }
    const result = await evaluateCustom(criteria, tempDir)
    expect(result.passed).toBe(false)
    expect(result.feedback).toBe('things are bad')
  })

  it('fails when module does not exist', async () => {
    const criteria: CompletionCriteria = {
      id: 'custom-check',
      type: 'custom',
      description: 'Custom check',
      required: true,
      config: { path: 'nonexistent.mjs' },
    }
    const result = await evaluateCustom(criteria, tempDir)
    expect(result.passed).toBe(false)
    expect(result.feedback).toContain('Custom evaluator error')
  })

  it('fails when path is missing from config', async () => {
    const criteria: CompletionCriteria = {
      id: 'custom-check',
      type: 'custom',
      description: 'Custom check',
      required: true,
      config: {},
    }
    const result = await evaluateCustom(criteria, tempDir)
    expect(result.passed).toBe(false)
    expect(result.feedback).toContain('missing "path"')
  })
})
