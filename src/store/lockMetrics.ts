import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LockType } from './lock.js';

// ---------------------------------------------------------------------------
// Lock timing instrumentation — GITNEXUS_COMPARISON.md §13.7 step 0.
//
// MAST_SPEC.md:824 asserts lock holding is per-file-parse (10-50ms), not
// per-tool-call. `runIndex` (indexer/index.ts:46) violates this by wrapping
// an entire index run in `withLock`. This module makes the violation
// measurable: wait time before acquisition, whether acquisition ultimately
// failed, and how long the lock was actually held.
//
// WHY a JSONL file sink instead of the `metrics`/`metrics_daily` tables in
// `graph/db.ts` (src/telemetry/metrics.ts): those tables require an open
// `Db` (a Kysely handle over better-sqlite3), and `store/lock.ts` has no
// access to one — `runIndex` calls `withLock` *before* it opens the
// database (indexer/index.ts:46-47), which is exactly the call site this
// instrumentation exists to observe. Threading a `Db` into `lock.ts` would
// also invert the package's existing dependency direction: nothing under
// `store/` currently imports from `graph/` (graph depends on store, not the
// reverse), and `graph/db.ts` is a heavier, higher-level module than the
// lock primitive. A flat JSONL file in `stateDir` needs no such dependency,
// survives across the separate CLI processes used to capture the baseline
// (`mast init` then `mast index`, or a concurrent `mast serve` + JIT call),
// and is trivially greppable/`JSON.parse`-per-line for the baseline capture.
// ---------------------------------------------------------------------------

/**
 * A single lock lifecycle event.
 *
 * `acquired` and `failed` are recorded synchronously with the outcome of an
 * acquisition attempt (including retry backoff) — `waitMs` covers the full
 * attempt, from first try to acquisition or final failure. `released` is
 * recorded when the caller's release function completes and carries the
 * hold duration, i.e. wall-clock time between acquisition and release.
 */
export type LockEvent =
  | {
      readonly kind: 'acquired';
      readonly type: LockType;
      readonly caller: string;
      readonly waitMs: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'released';
      readonly type: LockType;
      readonly caller: string;
      readonly holdMs: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'failed';
      readonly type: LockType;
      readonly caller: string;
      readonly waitMs: number;
      readonly timestamp: number;
    };

/**
 * Sink for lock lifecycle events.
 *
 * A role interface (§4.3) so tests can inject an in-memory fake instead of
 * touching the filesystem (§4.4) — the only production implementation is
 * {@link createFileLockMetricsSink}.
 */
export interface LockMetricsSink {
  /** Must never throw — a metrics failure must never break lock acquisition/release. */
  record(event: LockEvent): void;
}

const LOCK_METRICS_FILENAME = 'lock-metrics.jsonl';

/**
 * Default sink: appends one JSON line per event to `<stateDir>/lock-metrics.jsonl`.
 *
 * Synchronous and best-effort: lock acquire/release happens rarely relative
 * to read-tool traffic (near-zero overhead on the hot path), and a write
 * failure (e.g. read-only state dir) is swallowed rather than surfaced,
 * matching the fire-and-forget discipline `telemetry/metrics.ts` already
 * uses for tool-call metrics.
 */
export function createFileLockMetricsSink(stateDir: string): LockMetricsSink {
  const path = join(stateDir, LOCK_METRICS_FILENAME);
  return {
    record(event: LockEvent): void {
      try {
        appendFileSync(path, JSON.stringify(event) + '\n');
      } catch {
        // Best-effort — see module WHY-comment.
      }
    },
  };
}
