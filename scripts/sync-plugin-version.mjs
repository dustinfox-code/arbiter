#!/usr/bin/env node
// Keep .claude-plugin/plugin.json's version equal to package.json's.
// Claude Code uses the plugin version to tell installed users an update
// exists, so the two must move together. Runs from `npm version` and can be
// run by hand: node scripts/sync-plugin-version.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const check = process.argv.includes('--check')
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
const pluginPath = '.claude-plugin/plugin.json'
const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'))

if (plugin.version === pkg.version) {
  console.log(`plugin.json already at ${pkg.version}`)
  process.exit(0)
}
if (check) {
  console.error(`plugin.json is ${plugin.version} but package.json is ${pkg.version}; run: node scripts/sync-plugin-version.mjs`)
  process.exit(1)
}
plugin.version = pkg.version
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n')
console.log(`plugin.json -> ${pkg.version}`)
// When invoked by `npm version`, stage the change so it lands in the version commit.
try {
  execFileSync('git', ['add', pluginPath], { stdio: 'ignore' })
} catch {
  // Not a git checkout, or git unavailable: fine
}
