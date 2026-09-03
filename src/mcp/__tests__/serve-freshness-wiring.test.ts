// The freshness probe's two production call sites, neither of which had a test
// until now (D055's review). The probe itself is unit-tested in
// freshness-probe.test.ts; correct in isolation and wired wrong is the failure
// this file exists to catch.
//
// `serve()` is not called directly here. It opens a real stdio transport and a
// real database, so a test that drove it would be asserting on the transport,
// not on the ordering. The ordering was extracted into `reindexAndRemeasure`
// precisely so it could be tested at the layer it lives at (§5.5), and the
// end-to-end wiring is covered by the integration suite.
import { describe, it, expect, vi } from 'vitest';
import type { ResolvedConfig } from '../../store/config.js';
import type { FreshnessProbe } from '../freshness-probe.js';
import { reindexAndRemeasure } from '../server.js';

const CONFIG = {} as unknown as ResolvedConfig;

function spyProbe(): FreshnessProbe & {
  readonly calls: readonly string[];
} {
  const calls: string[] = [];
  return {
    calls,
    peekUnindexed: () => null,
    invalidate: () => { calls.push('invalidate'); },
    refresh: () => { calls.push('refresh'); },
    settled: () => Promise.resolve(),
  };
}

describe('reindexAndRemeasure — the ordering serve() depends on', () => {
  it('invalidates the cached count after a successful reindex', async () => {
    const probe = spyProbe();
    const runIndexFn = vi.fn(() => Promise.resolve({}));

    await reindexAndRemeasure(CONFIG, probe, { incremental: true, runIndexFn });

    expect(runIndexFn).toHaveBeenCalledWith(CONFIG, { incremental: true });
    expect(probe.calls).toEqual(['invalidate']);
  });

  /**
   * D060. The watch batch used to invalidate on the success path only. A batch
   * fires *because* files on disk changed, and `runIndex` losing
   * `structure.lock` to a concurrent writer is an ordinary outcome — so the
   * failure path is the one where the cached count is most certainly wrong,
   * and it was the one that kept it.
   */
  it('invalidates even when the reindex throws', async () => {
    const probe = spyProbe();
    const runIndexFn = vi.fn(() => Promise.reject(new Error('structure.lock held')));

    await expect(
      reindexAndRemeasure(CONFIG, probe, { incremental: true, runIndexFn }),
    ).rejects.toThrow('structure.lock held');

    expect(probe.calls).toEqual(['invalidate']);
  });

  /**
   * `WatchScheduler` requeues a batch on rejection and drops it after N
   * consecutive failures. Swallowing here would turn a retried batch into a
   * silently abandoned one.
   */
  it('propagates the failure so the watch scheduler can requeue', async () => {
    const probe = spyProbe();
    const boom = new Error('boom');

    await expect(
      reindexAndRemeasure(CONFIG, probe, { incremental: true, runIndexFn: () => Promise.reject(boom) }),
    ).rejects.toBe(boom);
  });

  it('primes the cache when asked, so the first search of a session is not blind', async () => {
    const probe = spyProbe();

    await reindexAndRemeasure(CONFIG, probe, {
      incremental: false, prime: true, runIndexFn: () => Promise.resolve({}),
    });

    // Order matters: refreshing before invalidating would bump the generation
    // out from under the measurement it just started (D055).
    expect(probe.calls).toEqual(['invalidate', 'refresh']);
  });

  it('primes on the startup failure path too — a failed startup index is exactly when the drift is real', async () => {
    const probe = spyProbe();

    await expect(reindexAndRemeasure(CONFIG, probe, {
      incremental: false, prime: true, runIndexFn: () => Promise.reject(new Error('nope')),
    })).rejects.toThrow();

    expect(probe.calls).toEqual(['invalidate', 'refresh']);
  });

  it('does not prime for a watch batch, leaving the next peek to coalesce a burst', async () => {
    const probe = spyProbe();

    await reindexAndRemeasure(CONFIG, probe, { incremental: true, runIndexFn: () => Promise.resolve({}) });

    expect(probe.calls).not.toContain('refresh');
  });

  it('passes the full-vs-incremental choice through unchanged', async () => {
    const probe = spyProbe();
    const runIndexFn = vi.fn(() => Promise.resolve({}));

    await reindexAndRemeasure(CONFIG, probe, { incremental: false, runIndexFn });

    expect(runIndexFn).toHaveBeenCalledWith(CONFIG, { incremental: false });
  });
});
