// The cached freshness probe, and the two properties that make it safe to call
// from `mast_search`.
//
// 1. It NEVER blocks a search. `fusedSearch` is ~4ms on a small tree; a
//    `measureFreshness` walk is ~183ms on a 14k-file monorepo (measured
//    2026-09-02). A probe that awaited its own measurement would make the first
//    search of every window 45x slower, so `peekUnindexed` returns the
//    last-known answer synchronously and refreshes behind it.
// 2. A failing measurement is never fatal and never poisons the cache. The
//    probe is advisory — it exists to warn that the index may be missing files.
//    Turning that warning into a thrown search is strictly worse than not
//    warning at all.
import { describe, it, expect, vi } from 'vitest';
import type { IndexFreshness } from '../../indexer/freshness.js';
import type { ResolvedConfig } from '../../store/config.js';
import type { Db } from '../../graph/db.js';
import { createFreshnessProbe } from '../freshness-probe.js';

const CONFIG = {} as unknown as ResolvedConfig;
const DB = {} as unknown as Db;

function freshness(unindexed: number): IndexFreshness {
  return { stale: 0, unindexed, deleted: 0, total: unindexed, walked: unindexed };
}

/** A measure function whose settlement this test controls. */
function controllable() {
  const calls: Array<{ resolve: (f: IndexFreshness) => void; reject: (e: Error) => void }> = [];
  const measure = vi.fn(
    () => new Promise<IndexFreshness>((resolve, reject) => { calls.push({ resolve, reject }); }),
  );
  return { measure, calls };
}


describe('createFreshnessProbe', () => {
  it('returns null before any measurement has completed', () => {
    const { measure } = controllable();
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => 0 });

    expect(probe.peekUnindexed()).toBeNull();
  });

  it('returns the measured count once the first measurement settles', async () => {
    const { measure, calls } = controllable();
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => 0 });

    probe.peekUnindexed();
    calls[0]?.resolve(freshness(3));
    await probe.settled();

    expect(probe.peekUnindexed()).toBe(3);
  });

  it('does not re-measure within the ttl', async () => {
    const { measure, calls } = controllable();
    let clock = 0;
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => clock, ttlMs: 5_000 });
    probe.peekUnindexed();
    calls[0]?.resolve(freshness(1));
    await probe.settled();

    clock = 4_999;
    probe.peekUnindexed();

    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('re-measures once the ttl has elapsed', async () => {
    const { measure, calls } = controllable();
    let clock = 0;
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => clock, ttlMs: 5_000 });
    probe.peekUnindexed();
    calls[0]?.resolve(freshness(1));
    await probe.settled();

    clock = 5_000;
    probe.peekUnindexed();

    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent peeks into one measurement', () => {
    const { measure } = controllable();
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => 0 });

    probe.peekUnindexed();
    probe.peekUnindexed();
    probe.peekUnindexed();

    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the last good value when a measurement fails', async () => {
    const { measure, calls } = controllable();
    let clock = 0;
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => clock, ttlMs: 1_000 });
    probe.peekUnindexed();
    calls[0]?.resolve(freshness(7));
    await probe.settled();

    clock = 1_000;
    probe.peekUnindexed();
    calls[1]?.reject(new Error('walk failed'));
    await probe.settled();

    expect(probe.peekUnindexed()).toBe(7);
  });

  it('backs off for a full ttl after a failed measurement rather than retrying on every peek', async () => {
    const { measure, calls } = controllable();
    let clock = 0;
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => clock, ttlMs: 1_000 });
    probe.peekUnindexed();
    calls[0]?.reject(new Error('walk failed'));
    await probe.settled();

    clock = 500;
    probe.peekUnindexed();
    probe.peekUnindexed();

    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('reports unknown rather than a stale count after invalidate', async () => {
    // After a reindex the previous count is wrong, and "wrong" here means
    // warning about files that were just indexed. Unknown suppresses the
    // warning; the next measurement restores it if it is still true.
    const { measure, calls } = controllable();
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => 0 });
    probe.peekUnindexed();
    calls[0]?.resolve(freshness(4));
    await probe.settled();

    probe.invalidate();

    expect(probe.peekUnindexed()).toBeNull();
  });

  it('measures again after invalidate even inside the ttl', async () => {
    const { measure, calls } = controllable();
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => 0, ttlMs: 60_000 });
    probe.peekUnindexed();
    calls[0]?.resolve(freshness(4));
    await probe.settled();

    probe.invalidate();
    probe.peekUnindexed();

    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('settled() resolves even when the measurement rejects', async () => {
    const { measure, calls } = controllable();
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => 0 });
    probe.peekUnindexed();
    calls[0]?.reject(new Error('walk failed'));

    await expect(probe.settled()).resolves.toBeUndefined();
  });

  it('primes the cache through settled() so the first search never pays the walk', async () => {
    const { measure, calls } = controllable();
    const probe = createFreshnessProbe(CONFIG, DB, { measure, now: () => 0 });

    probe.refresh();
    calls[0]?.resolve(freshness(2));
    await probe.settled();

    expect(probe.peekUnindexed()).toBe(2);
  });
});
