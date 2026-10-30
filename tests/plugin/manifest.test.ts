import { describe, it, expect } from 'vitest'
import { readFile, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { hookCommand } from '../../src/core/agent-config.js'

const root = process.cwd()

describe('Claude Code plugin manifest', () => {
  it('lists every skill folder, and nothing else', async () => {
    const plugin = JSON.parse(await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf-8')) as { skills: string[]; name: string }
    const folders = (await readdir(join(root, 'skills'), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => `./skills/${e.name}`).sort()
    expect([...plugin.skills].sort()).toEqual(folders)
    expect(plugin.name).toBe('arbiter')
  })

  it('keeps plugin.json and package.json on the same version', async () => {
    const plugin = JSON.parse(await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf-8')) as { version: string }
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8')) as { version: string }
    expect(plugin.version).toBe(pkg.version)
  })

  it('wires the Stop hook to the same command init writes for Claude', async () => {
    const hooks = JSON.parse(await readFile(join(root, 'hooks', 'hooks.json'), 'utf-8')) as {
      hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }> }
    }
    expect(hooks.hooks.Stop).toHaveLength(1)
    expect(hooks.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: hookCommand('claude'), timeout: 120 })
    expect(hookCommand('claude')).toMatch(/^npx arbiter-cc@\d+\.\d+\.\d+ check$/)
  })

  it('marketplace.json points at this repo as a single-plugin marketplace', async () => {
    const m = JSON.parse(await readFile(join(root, '.claude-plugin', 'marketplace.json'), 'utf-8')) as { name: string; plugins: Array<{ name: string; source: string }> }
    const plugin = JSON.parse(await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf-8')) as { name: string }
    expect(m.plugins).toHaveLength(1)
    expect(m.plugins[0].name).toBe(plugin.name)
    expect(m.plugins[0].source).toBe('./')
    await expect(access(join(root, m.plugins[0].source, '.claude-plugin', 'plugin.json'))).resolves.toBeUndefined()
  })
})
