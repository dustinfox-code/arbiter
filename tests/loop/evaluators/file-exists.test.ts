import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluateFileExists } from '../../../src/loop/evaluators/file-exists.js'
import type { CompletionCriteria } from '../../../src/core/types.js'

describe('evaluateFileExists', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'arbiter-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('passes when file exists', async () => {
    await writeFile(join(tempDir, 'test.txt'), 'content')
    const criteria: CompletionCriteria = {
      id: 'file-check',
      type: 'file-exists',
      description: 'test.txt exists',
      required: true,
      config: { path: 'test.txt' },
    }
    const result = await evaluateFileExists(criteria, tempDir)
    expect(result.passed).toBe(true)
  })

  it('fails when file does not exist', async () => {
    const criteria: CompletionCriteria = {
      id: 'file-check',
      type: 'file-exists',
      description: 'missing.txt exists',
      required: true,
      config: { path: 'missing.txt' },
    }
    const result = await evaluateFileExists(criteria, tempDir)
    expect(result.passed).toBe(false)
    expect(result.feedback).toContain('File not found')
  })

  it('fails with feedback when path is missing from config', async () => {
    const criteria: CompletionCriteria = {
      id: 'file-check',
      type: 'file-exists',
      description: 'check something',
      required: true,
      config: {},
    }
    await expect(evaluateFileExists(criteria, tempDir)).rejects.toThrow(
      "file-exists criteria requires a 'path' config field (string)"
    )
  })
})
