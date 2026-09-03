/**
 * A cached, non-blocking answer to "is the index missing files?".
 *
 * `mast_search` needs this to warn a caller that a zero-hit result may mean
 * "not indexed" rather than "not present" — the severity-zero failure this
 * package is built around. What it cannot do is pay for it *at scale*, and the
 * cost is worth stating with its corpus attached, because it inverts:
 *
 *   - This repository, 213 files walked (medians, measured 2026-09-03):
 *     `fusedSearch` 15.3 ms, `measureFreshness` 7.6 ms. The walk is CHEAPER
 *     than the search. On a tree this size the probe buys nothing.
 *   - A 14k-file monorepo: `measureFreshness` ~183 ms (measured 2026-09-02).
 *
 * That is the whole argument, and it is about scaling, not about a ratio.
 * `measureFreshness` is O(files in the tree) and a search is O(matches), so the
 * walk overtakes the query as the tree grows and then keeps going. The probe
 * exists for the trees where that has already happened.
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
   * that were just indexed. A measurement already in flight is *superseded* —
   * it is allowed to finish, and its result is discarded rather than cached,
   * because it was reading the pre-reindex tree.
   */
  invalidate(): void;

  /** Start a measurement now if none is in flight. Used to prime at startup. */
  refresh(): void;

  /**
   * Resolves when the in-flight measurement settles — success or failure.
   *
   * Settling is not the same as caching a value: a measurement superseded by
   * `invalidate()` settles with its result discarded, leaving `peekUnindexed`
   * at `null` until the next peek starts a clean one.
   */
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
  /**
   * Bumped by `invalidate()`. A measurement that started under an older
   * generation was reading a tree this process has since reindexed, so its
   * count is not merely old — it is wrong in the exact direction that warns
   * about files that now ARE indexed. Gating on the generation is what makes
   * `invalidate()` mean "discard", rather than "discard unless a walk happens
   * to be in flight, in which case adopt its stale answer and stamp it fresh
   * for a full TTL".
   */
  let generation = 0;

  function refresh(): void {
    // Still coalesced across generations: a superseded walk is left to finish
    // and its result dropped, rather than disowned and replaced immediately.
    // Disowning would let one walk per `invalidate()` run concurrently, and
    // `measureFreshness` holds the event loop in a synchronous `statSync` loop
    // (see the header) — under a watch-driven edit loop that is worse than the
    // laziness. The cache is left `null` (unknown -> silence, never a wrong
    // warning) and the next peek starts a clean measurement.
    if (inFlight !== null) return;
    const startedAt = generation;
    inFlight = measure(config, db)
      .then((result) => {
        if (startedAt !== generation) return;
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
        inFlight = null;
        // A superseded walk must NOT stamp the cache fresh. Leaving `settledAt`
        // null keeps the value expired, so the next peek re-measures instead of
        // serving `null` for a full TTL.
        if (startedAt !== generation) return;
        settledAt = now();
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
      generation += 1;
    },

    refresh,

    async settled(): Promise<void> {
      await inFlight;
    },
  };
}
