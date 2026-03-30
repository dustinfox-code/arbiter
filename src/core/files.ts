import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Validate that a resolved path is within the given base directory.
 */
export function isPathContained(base: string, target: string): boolean {
  const resolvedBase = resolve(base)
  const resolvedTarget = resolve(target)
  return resolvedTarget.startsWith(resolvedBase + sep) || resolvedTarget === resolvedBase
}

/**
 * Resolve which files to include as context. Validates that all paths stay
 * within cwd. Supports 'git-diff' to auto-gather changed files.
 */
export async function resolveContextFiles(
  files: unknown,
  cwd: string,
): Promise<{ path: string; content: string }[]> {
  if (!files) return []

  if (files === 'git-diff') {
    try {
      const output = execFileSync('git', ['diff', '--name-only', 'HEAD~1'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      const paths = output.split('\n').filter(Boolean)
      return resolveContextFiles(paths, cwd)
    } catch {
      return []
    }
  }

  if (Array.isArray(files)) {
    const results: { path: string; content: string }[] = []
    for (const raw of files) {
      if (typeof raw !== 'string') {
        results.push({ path: String(raw), content: '[Skipped: non-string path]' })
        continue
      }
      const filePath = raw
      const resolvedPath = resolve(cwd, filePath)
      if (!isPathContained(cwd, resolvedPath)) {
        results.push({ path: filePath, content: `[Skipped: path escapes project directory]` })
        continue
      }
      try {
        const content = await readFile(resolvedPath, 'utf-8')
        results.push({ path: filePath, content })
      } catch {
        results.push({ path: filePath, content: `[File not readable: ${filePath}]` })
      }
    }
    return results
  }

  return []
}
