#!/usr/bin/env node
// Keep .claude-plugin/plugin.json's version and the pinned hook command in
// hooks/hooks.json equal to package.json's version. Claude Code uses the
// plugin version to tell installed users an update exists, and the hook
// pins the exact CLI version it runs, so all three must move together.
// Runs from `npm version`; by hand: node scripts/sync-plugin-version.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
const pluginPath = resolve(ROOT, '.claude-plugin', 'plugin.json')
const hooksPath = resolve(ROOT, 'hooks', 'hooks.json')
const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'))
const hooksRaw = readFileSync(hooksPath, 'utf-8')
const pinned = hooksRaw.match(/arbiter-cc@([^\s"]+) check/)?.[1]

const drift = []
if (plugin.version !== pkg.version) drift.push(`plugin.json is ${plugin.version}`)
if (pinned !== pkg.version) drift.push(`hooks/hooks.json pins ${pinned ?? 'nothing'}`)

if (drift.length === 0) {
  console.log(`plugin.json and hooks/hooks.json already at ${pkg.version}`)
  process.exit(0)
}
if (check) {
  console.error(`${drift.join('; ')} but package.json is ${pkg.version}; run: node scripts/sync-plugin-version.mjs`)
  process.exit(1)
}
plugin.version = pkg.version
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n')
writeFileSync(hooksPath, hooksRaw.replace(/arbiter-cc@[^\s"]+ check/, `arbiter-cc@${pkg.version} check`))
console.log(`plugin.json and hooks/hooks.json -> ${pkg.version}`)
// When invoked by `npm version`, stage the change so it lands in the version commit.
try {
  execFileSync('git', ['add', pluginPath, hooksPath], { stdio: 'ignore', cwd: ROOT })
} catch {
  // Not a git checkout, or git unavailable: fine
}
