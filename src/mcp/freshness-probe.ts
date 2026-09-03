/**
 * A cached, non-blocking answer to "is the index missing files?".
 *
 * `mast_search` needs this to warn a caller that a zero-hit result may mean
 * "not indexed" rather than "not present" — the severity-zero failure this
 * package is built around. What it cannot do is pay for it: a `fusedSearch`
 * costs ~4ms, a `measureFreshness` walk ~183ms on a 14k-file tree (measured
 * 2026-09-02), so answering the question on the request path would make search
 * ~45x slower for a warning that is almost always "no".
 *
 * So the probe inverts it. `peekUnindexed` returns the last-known count
 * synchronously and schedules a refresh behind the caller when the value has
 * aged past the TTL. The first search of a session gets `null` — unknown, no
 * warning — and every later one gets an answer that is at most `ttlMs` old.
 * `server.ts` primes it at startup so that window is usually already closed.
 *
 * The cost is amortised, NOT eliminated, and it is worth being exact about
 * which: `measureFreshness` -> `walkProject` globs asynchronously but then
 * `statSync`s every hit in a synchronous loop, so a refresh occupies the event
 * loop for part of its duration. A search that lands mid-refresh can be
 * delayed by that much. One such window per `ttlMs`, rather than one walk per
 * search, is the whole of the improvement — do not read "background" as
 * "free".
 *
 * Deliberately NOT a reindex: no `structure.lock` is taken and nothing is
 * written, so the probe cannot contend with a concurrent `runIndex` or with
 * another reader (E7 measured 35-88.5% JIT failure under reader-vs-reader
 * contention). It reads, it counts, it reports.
 */

import type { Db } from '../graph/db.js';
import type { ResolvedConfig } from '../store/config.js';
import { measureFreshness, type IndexFreshness } from '../indexer/freshness.js';

/** How long a measurement stays authoritative before the next peek refreshes it. */
export const DEFAULT_FRESHNESS_TTL_MS = 30_000;

export interface FreshnessProbe {
  /**
   * Files on disk that the index has never seen, as of the last completed
   * measurement — or `null` when none has completed yet.
   *
   * Never blocks, never throws, never awaits. May schedule a background
   * refresh as a side effect. `null` means *unknown*, which callers must
   * render as silence rather than as zero.
   */
  peekUnindexed(): number | null;

  /**
   * Discard the cached value and re-measure on the next peek.
   *
   * Called after this process reindexes: the previous count is not merely old,
   * it is wrong in the direction that produces a false warning about files
   * that were just indexed.
   */
  invalidate(): void;

  /** Start a measurement now if none is in flight. Used to prime at startup. */
  refresh(): void;

  /** Resolves when the in-flight measurement settles — success or failure. */
  settled(): Promise<void>;
}

export interface FreshnessProbeOptions {
  readonly ttlMs?: number;
  /** Injected for tests (§4.4); production reads the real clock. */
  readonly now?: () => number;
  /** Injected for tests (§4.4); production walks the project. */
  readonly measure?: (config: ResolvedConfig, db: Db) => Promise<IndexFreshness>;
}

export function createFreshnessProbe(
  config: ResolvedConfig,
  db: Db,
  options: FreshnessProbeOptions = {},
): FreshnessProbe {
  const ttlMs = options.ttlMs ?? DEFAULT_FRESHNESS_TTL_MS;
  const now = options.now ?? Date.now;
  const measure = options.measure ?? measureFreshness;

  let unindexed: number | null = null;
  /** `null` = never measured or invalidated; otherwise the clock at settlement. */
  let settledAt: number | null = null;
  let inFlight: Promise<void> | null = null;

  function refresh(): void {
    if (inFlight !== null) return;
    inFlight = measure(config, db)
      .then((result) => {
        unindexed = result.unindexed;
      })
      .catch(() => {
        // Swallowed by contract: a failed walk (a directory removed mid-walk, a
        // permission error) must not reject into a search handler or replace a
        // good answer with a wrong one. The last value stands and the stamp
        // below backs the retry off by a full TTL rather than re-walking on
        // every peek.
      })
      .finally(() => {
        settledAt = now();
        inFlight = null;
      });
  }

  return {
    peekUnindexed(): number | null {
      const isExpired = settledAt === null || now() - settledAt >= ttlMs;
      if (isExpired) refresh();
      return unindexed;
    },

    invalidate(): void {
      unindexed = null;
      settledAt = null;
    },

    refresh,

    async settled(): Promise<void> {
      await inFlight;
    },
  };
}
