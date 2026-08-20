import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { createFileLockMetricsSink, type LockMetricsSink } from './lockMetrics.js';

// Stage 7.1 (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion") removed
// the 'vectors' lock type along with runEmbed, its only acquirer — 'structure'
// is the only lock type left. Kept as a union of one (rather than a bare
// string) so call sites' `type: LockType` parameters need no signature change.
export type LockType = 'structure';

const STALE_MS = 10_000;

/**
 * Thrown when the lock was taken away while this process still believed it
 * held it — another process judged it stale and stole it, or the lock
 * directory was removed underneath us.
 *
 * It is thrown at RELEASE, not when the compromise is detected, because
 * proper-lockfile detects it inside an `fs.stat` callback on a timer: there is
 * no caller on the stack to receive it there, which is exactly why the
 * library's default handler (`onCompromised: (err) => { throw err; }`,
 * `lib/lockfile.js`) reached the process as an uncaught exception and killed
 * it — measured: `ECOMPROMISED ENOENT`, exit code 7, with no
 * `uncaughtException` handler anywhere in `src`.
 *
 * **What this does and does not fix.** It converts a process kill into a
 * failed operation the caller can retry, and it stops a run that was not
 * exclusive from reporting success. It does NOT stop the work already in
 * flight: by the time the compromise is detected, `fn` is mid-execution and
 * nothing here can interrupt it. Doing that needs an `AbortSignal` threaded
 * through `withLock` and honoured by every write phase, which is a design
 * change, not a patch. The exposure is bounded: SQLite writes go through
 * `populateFile`'s `BEGIN IMMEDIATE` transaction and stay serialised whatever
 * this advisory lock believes, so what is actually at risk is the plain-JSON
 * `file_manifest.json` / `index.json` writes this lock exists to coordinate —
 * and a run that fails here is re-run, which rewrites both.
 */
export class LockCompromisedError extends Error {
  /** The underlying proper-lockfile error (`ECOMPROMISED`). */
  readonly reason: unknown;

  constructor(type: LockType, reason: unknown) {
    super(
      `The ${type} lock was compromised while held — another process took it, so this run was ` +
      `not exclusive and its result must not be trusted. Re-run the operation. Cause: ${String(reason)}`,
    );
    this.name = 'LockCompromisedError';
    this.reason = reason;
  }
}

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
  for (const type of ['structure'] as const) {
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
  /**
   * Override the staleness window (default {@link STALE_MS}). proper-lockfile
   * derives its refresh interval as `stale / 2`, so this is the only way to
   * make a compromise observable inside a test's patience — production call
   * sites never set it.
   */
  staleMs?: number;
}

/**
 * Acquire an advisory write lock for the given lock type.
 *
 * Returns a release function. Always `await release()` in a finally block.
 * The returned function is wrapped to record hold-duration lock metrics on
 * release — this covers direct callers as well as callers that go through
 * {@link withLock}.
 *
 * Per spec §7.6:
 * - CLI commands: maxRetries=1, retryIntervalMs=2000 (2s total)
 * - mast_reindex / mast serve startup: maxRetries=5, retryIntervalMs=1000
 *
 * **F11 (`IMPLEMENTATION_PLAN.md` "Replace fail-fast advisory locking")
 * narrowed this lock's role**: the JIT re-parse path (`mcp/staleness.ts`'s
 * `checkAndRefreshIfStale`) no longer calls `acquireLock` at all — it relies
 * on `populateFile`'s own `BEGIN IMMEDIATE` transaction
 * (`graph/populate.ts`) plus a dedicated short `busy_timeout` instead. This
 * lock is now acquired only by coarse writers: `mast index` / the startup
 * reindex, `mast_reindex`, and the manifest/`index.json` phase (plain-JSON
 * `writeFileSync`, which SQLite can never coordinate) — see `populateFile`'s
 * doc comment for the full design rationale.
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
    staleMs = STALE_MS,
  } = options;
  const marker = markerPath(stateDir, type);
  const attemptStartMs = Date.now();

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // `onCompromised` must RECORD, never throw. The library invokes it from
      // an `fs.stat` callback with no caller on the stack, so its default
      // (rethrow) becomes an uncaught exception — see {@link LockCompromisedError}.
      let compromise: unknown = null;
      const release = await lockfile.lock(marker, {
        stale: staleMs,
        retries: 0,
        onCompromised: (err: unknown) => { compromise = err; },
      });
      sink.record({ kind: 'acquired', type, caller, waitMs: Date.now() - attemptStartMs, timestamp: Date.now() });

      const acquiredAtMs = Date.now();
      return async () => {
        // proper-lockfile marks a compromised lock released and drops it from
        // its registry BEFORE calling the handler (`setLockAsCompromised`), so
        // calling `release()` now only yields `ERELEASED` — there is nothing
        // left of ours to release.
        if (compromise === null) await release();
        // Recorded either way: the hold duration is real, and losing it would
        // make the metrics under-report exactly the runs worth looking at.
        sink.record({ kind: 'released', type, caller, holdMs: Date.now() - acquiredAtMs, timestamp: Date.now() });
        if (compromise !== null) throw new LockCompromisedError(type, compromise);
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
// removes ALL of them on shutdown — a per-`withLock` handler would race if
// more than one lock were held at once, because the first handler's
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
 *
 * @throws {LockCompromisedError} if the lock was taken away while `fn` ran.
 *   `fn` still completed — see that error's doc for what is and is not
 *   guaranteed. If `fn` itself threw, that error is thrown instead.
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

  // `release` can now throw ({@link LockCompromisedError}), so it cannot sit in
  // a bare `finally` — a throw there would mask a failure `fn` itself raised,
  // and `fn`'s own error is the better diagnosis when both happen.
  type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
  let outcome: Outcome;
  try {
    outcome = { ok: true, value: await fn() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  heldLockDirs.delete(lockDir);
  try {
    await release();
  } catch (releaseError) {
    if (!outcome.ok) throw outcome.error;
    throw releaseError;
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
