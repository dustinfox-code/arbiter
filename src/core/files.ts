import { readFile, stat, readdir, realpath } from 'node:fs/promises'
import { resolve, sep, join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const MAX_FILE_BYTES = 1_024_000 // 1 MB — skip files larger than this

/** Common directories/patterns to skip when gathering all files. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.arbiter', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.output', '__pycache__', '.venv', 'vendor',
])

const IGNORED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2',
  '.ttf', '.eot', '.mp3', '.mp4', '.zip', '.tar', '.gz', '.lock',
])

/**
 * Validate that a resolved path is within the given base directory.
 */
export function isPathContained(base: string, target: string): boolean {
  const resolvedBase = resolve(base)
  const resolvedTarget = resolve(target)
  return resolvedTarget.startsWith(resolvedBase + sep) || resolvedTarget === resolvedBase
}

/**
 * Recursively collect all source file paths under a directory,
 * skipping ignored directories and binary/non-text extensions.
 */
async function collectAllFiles(dir: string, base: string, depth = 0): Promise<string[]> {
  if (depth > 20) return [] // Prevent infinite recursion from circular symlinks
  const results: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results // Permission denied or other filesystem error — skip
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      results.push(...await collectAllFiles(fullPath, base, depth + 1))
    } else if (entry.isFile()) {
      const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop()!.toLowerCase() : ''
      if (IGNORED_EXTENSIONS.has(ext)) continue
      results.push(relative(base, fullPath))
    }
  }
  return results
}

/**
 * Resolve which files to include as context. Validates that all paths stay
 * within cwd. Supports 'git-diff' to auto-gather changed files and 'all'
 * to gather every source file in the project.
 */
export async function resolveContextFiles(
  files: unknown,
  cwd: string,
): Promise<{ path: string; content: string }[]> {
  if (!files) return []

  if (files === 'git-diff') {
    // Validate cwd is a real absolute path (no injection via cwd)
    const resolvedCwd = resolve(cwd)
    try {
      const output = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
        cwd: resolvedCwd,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      const paths = output.split('\n').filter(Boolean)
      if (paths.length === 0) return []
      return resolveContextFiles(paths, cwd)
    } catch {
      return []
    }
  }

  if (files === 'all') {
    try {
      const paths = await collectAllFiles(cwd, cwd)
      if (paths.length === 0) return []
      return resolveContextFiles(paths, cwd)
    } catch {
      return []
    }
  }

  if (Array.isArray(files)) {
    const results: { path: string; content: string }[] = []
    // Resolve cwd symlinks once outside the loop
    const realCwd = await realpath(cwd).catch(() => cwd)
    for (const raw of files) {
      if (typeof raw !== 'string') {
        results.push({ path: String(raw), content: '[Skipped: non-string path]' })
        continue
      }
      const filePath = raw
      const resolvedPath = resolve(cwd, filePath)
      // Resolve symlinks before containment check to prevent traversal
      let realResolvedPath: string
      try {
        realResolvedPath = await realpath(resolvedPath)
      } catch {
        // File doesn't exist or can't resolve — containment check on original
        realResolvedPath = resolvedPath
      }
      if (!isPathContained(realCwd, realResolvedPath)) {
        results.push({ path: filePath, content: `[Skipped: path escapes project directory]` })
        continue
      }
      try {
        // Single try-catch around both stat and read to handle TOCTOU race
        const info = await stat(resolvedPath)
        if (info.size > MAX_FILE_BYTES) {
          results.push({ path: filePath, content: `[Skipped: file too large (${Math.round(info.size / 1024)}KB, limit ${Math.round(MAX_FILE_BYTES / 1024)}KB)]` })
          continue
        }
        const content = await readFile(resolvedPath, 'utf-8')
        results.push({ path: filePath, content })
      } catch {
        // Handles both stat failure (deleted between checks) and read failure
        results.push({ path: filePath, content: `[File not readable: ${filePath}]` })
      }
    }
    return results
  }

  return []
}
