import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

export type LockType = 'structure' | 'vectors';

const STALE_MS = 10_000;

/** Returns the path of the marker file that proper-lockfile uses as its lock target. */
function markerPath(stateDir: string, type: LockType): string {
  return join(stateDir, type);
}

/**
 * Ensure the marker files required by proper-lockfile exist in `stateDir`.
 * Must be called during `mast init` before any lock can be acquired.
 */
export function initLockMarkers(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  for (const type of ['structure', 'vectors'] as const) {
    writeFileSync(markerPath(stateDir, type), '', { flag: 'a' });
  }
}

export interface AcquireOptions {
  /** Number of additional retries after the first attempt (default: 5). */
  maxRetries?: number;
  /** Milliseconds between retries (default: 1000). */
  retryIntervalMs?: number;
}

/**
 * Acquire an advisory write lock for the given lock type.
 *
 * Returns a release function. Always `await release()` in a finally block.
 *
 * Per spec §7.6:
 * - CLI commands: maxRetries=1, retryIntervalMs=2000 (2s total)
 * - mast_reindex / mast serve startup: maxRetries=5, retryIntervalMs=1000
 * - JIT re-parse from read tools: maxRetries=3, retryIntervalMs=100
 *
 * @throws if the lock cannot be acquired after all retries.
 */
export async function acquireLock(
  stateDir: string,
  type: LockType,
  options: AcquireOptions = {},
): Promise<() => Promise<void>> {
  const { maxRetries = 5, retryIntervalMs = 1_000 } = options;
  const marker = markerPath(stateDir, type);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const release = await lockfile.lock(marker, { stale: STALE_MS, retries: 0 });
      return release;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise<void>((res) => setTimeout(res, retryIntervalMs));
      }
    }
  }

  throw new Error(
    `Could not acquire ${type} lock after ${maxRetries + 1} attempt(s): ${String(lastError)}`,
  );
}

/**
 * Run `fn` while holding the given lock.
 * The lock is released in a finally block regardless of outcome.
 */
export async function withLock<T>(
  stateDir: string,
  type: LockType,
  options: AcquireOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(stateDir, type, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
