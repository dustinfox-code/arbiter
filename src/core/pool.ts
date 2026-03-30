/**
 * Run async tasks with bounded concurrency. Each task is a thunk that
 * returns a promise. Results are returned in the same order as input tasks.
 */
export async function pooled<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      // Safe: JS is single-threaded, so nextIndex++ completes atomically before the await below
      const i = nextIndex++
      results[i] = await tasks[i]()
    }
  }

  const workerCount = Math.min(concurrency, tasks.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
