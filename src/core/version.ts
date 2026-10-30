import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

let cached: string | undefined

/** This package's own version, read from package.json two levels up (works from src/ and dist/). */
export function packageVersion(): string {
  if (cached) return cached
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf-8')) as { version: string }
  cached = pkg.version
  return cached
}
