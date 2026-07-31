import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { createFileLockMetricsSink, type LockMetricsSink } from './lockMetrics.js';

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
  /**
   * Label identifying the calling workflow in lock metrics (e.g.
   * `'index-run'`, `'jit-staleness'`) — the signal that distinguishes a
   * whole-run hold from a per-file JIT re-parse. Defaults to `'unknown'`.
   */
  caller?: string;
  /**
   * Injection seam (§4.4) for lock metrics — tests pass an in-memory fake so
   * they can assert on recorded events without touching the filesystem.
   * Production call sites omit this and get the default JSONL sink for
   * `stateDir` (see {@link createFileLockMetricsSink}).
   */
  sink?: LockMetricsSink;
}

/**
 * Acquire an advisory write lock for the given lock type.
 *
 * Returns a release function. Always `await release()` in a finally block.
 * The returned function is wrapped to record hold-duration lock metrics on
 * release — this covers direct callers (e.g. the JIT re-parse path in
 * `mcp/staleness.ts`) as well as callers that go through {@link withLock}.
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
  const {
    maxRetries = 5,
    retryIntervalMs = 1_000,
    caller = 'unknown',
    sink = createFileLockMetricsSink(stateDir),
  } = options;
  const marker = markerPath(stateDir, type);
  const attemptStartMs = Date.now();

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const release = await lockfile.lock(marker, { stale: STALE_MS, retries: 0 });
      sink.record({ kind: 'acquired', type, caller, waitMs: Date.now() - attemptStartMs, timestamp: Date.now() });

      const acquiredAtMs = Date.now();
      return async () => {
        await release();
        sink.record({ kind: 'released', type, caller, holdMs: Date.now() - acquiredAtMs, timestamp: Date.now() });
      };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise<void>((res) => setTimeout(res, retryIntervalMs));
      }
    }
  }

  sink.record({ kind: 'failed', type, caller, waitMs: Date.now() - attemptStartMs, timestamp: Date.now() });
  throw new Error(
    `Could not acquire ${type} lock after ${maxRetries + 1} attempt(s): ${String(lastError)}`,
  );
}

// Lock directories currently held by this process. A single signal handler
// removes ALL of them on shutdown — a per-`withLock` handler would race when
// two locks are held (structure + vectors), because the first handler's
// `process.exit` pre-empts the others, leaking the second lock until its stale
// timeout. One registry + one handler also avoids piling up signal listeners.
const heldLockDirs = new Set<string>();
let signalHandlerInstalled = false;

function installSignalHandlerOnce(): void {
  if (signalHandlerInstalled) return;
  signalHandlerInstalled = true;
  const onSignal = (): never => {
    // release() is async and can't be awaited in a signal handler, so remove
    // every held lock directory synchronously as a best-effort fallback.
    for (const dir of heldLockDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    process.exit(1);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

/**
 * Run `fn` while holding the given lock.
 *
 * The lock's directory is tracked in a process-wide registry that a single
 * SIGTERM/SIGINT handler cleans up on shutdown, so an interrupted process does
 * not leave `<type>.lock` behind for every lock it held.
 */
export async function withLock<T>(
  stateDir: string,
  type: LockType,
  options: AcquireOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(stateDir, type, options);

  const lockDir = markerPath(stateDir, type) + '.lock';
  heldLockDirs.add(lockDir);
  installSignalHandlerOnce();

  try {
    return await fn();
  } finally {
    heldLockDirs.delete(lockDir);
    await release();
  }
}
