import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ArbiterConfig, DEFAULT_CONFIG } from './types.js'

/**
 * Deep-merge source into target. Only handles plain objects and arrays —
 * sufficient for the ArbiterConfig shape.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const srcVal = source[key]
    const tgtVal = (result as Record<string, unknown>)[key]
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      ;(result as Record<string, unknown>)[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      )
    } else if (srcVal !== undefined) {
      ;(result as Record<string, unknown>)[key] = srcVal
    }
  }
  return result
}

/**
 * Load Arbiter config from `.arbiter/config.json` under the given cwd.
 * Missing file → all defaults. Malformed JSON → throws.
 */
export async function loadConfig(cwd: string): Promise<ArbiterConfig> {
  const configPath = join(cwd, '.arbiter', 'config.json')
  try {
    const raw = await readFile(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ArbiterConfig>
    return deepMerge(
      { ...DEFAULT_CONFIG } as ArbiterConfig & Record<string, unknown>,
      parsed as Record<string, unknown>,
    ) as ArbiterConfig
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_CONFIG, critic: { ...DEFAULT_CONFIG.critic } }
    }
    throw new Error(
      `Failed to parse .arbiter/config.json: ${(err as Error).message}`,
    )
  }
}
