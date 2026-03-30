import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../../src/core/config.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

describe('loadConfig', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'arbiter-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns defaults when no config file exists', async () => {
    const config = await loadConfig(tempDir)
    expect(config.maxIterations).toBe(DEFAULT_CONFIG.maxIterations)
    expect(config.checkpointDir).toBe(DEFAULT_CONFIG.checkpointDir)
    expect(config.llmModel).toBe(DEFAULT_CONFIG.llmModel)
    expect(config.critic.enabled).toBe(false)
  })

  it('merges partial config with defaults', async () => {
    await mkdir(join(tempDir, '.arbiter'), { recursive: true })
    await writeFile(
      join(tempDir, '.arbiter', 'config.json'),
      JSON.stringify({ maxIterations: 10 }),
    )
    const config = await loadConfig(tempDir)
    expect(config.maxIterations).toBe(10)
    expect(config.checkpointDir).toBe(DEFAULT_CONFIG.checkpointDir)
  })

  it('deep-merges nested critic config', async () => {
    await mkdir(join(tempDir, '.arbiter'), { recursive: true })
    await writeFile(
      join(tempDir, '.arbiter', 'config.json'),
      JSON.stringify({ critic: { enabled: true } }),
    )
    const config = await loadConfig(tempDir)
    expect(config.critic.enabled).toBe(true)
    expect(config.critic.personas).toEqual(DEFAULT_CONFIG.critic.personas)
  })

  it('throws on malformed JSON', async () => {
    await mkdir(join(tempDir, '.arbiter'), { recursive: true })
    await writeFile(join(tempDir, '.arbiter', 'config.json'), '{ bad json')
    await expect(loadConfig(tempDir)).rejects.toThrow('Failed to parse')
  })
})
