import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initLockMarkers, withLock, acquireLock } from '../lock.js';
import type { LockEvent, LockMetricsSink } from '../lockMetrics.js';

const OPTS = { maxRetries: 3, retryIntervalMs: 20 } as const;

/**
 * In-memory fake sink (§5.3 "fakes over mocks") — lets tests assert on
 * recorded lock events without touching the filesystem.
 */
function fakeSink(): { sink: LockMetricsSink; events: LockEvent[] } {
  const events: LockEvent[] = [];
  return { sink: { record: (event) => { events.push(event); } }, events };
}

describe('withLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-lock-'));
    initLockMarkers(dir);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('releases the lock so it can be re-acquired', async () => {
    const order: string[] = [];
    await withLock(dir, 'structure', OPTS, async () => { order.push('a'); });
    await withLock(dir, 'structure', OPTS, async () => { order.push('b'); });
    expect(order).toEqual(['a', 'b']);
  });

  it('holds the two lock types concurrently and releases both', async () => {
    await withLock(dir, 'structure', OPTS, async () => {
      await withLock(dir, 'vectors', OPTS, async () => {
        // both held here
      });
    });
    // Both were released — each type can be re-acquired afterwards.
    await withLock(dir, 'structure', OPTS, async () => {});
    await withLock(dir, 'vectors', OPTS, async () => {});
    expect(true).toBe(true);
  });

  it('releases the lock even when fn throws', async () => {
    await expect(
      withLock(dir, 'structure', OPTS, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    // Not left locked.
    await withLock(dir, 'structure', OPTS, async () => {});
  });
});

// ---------------------------------------------------------------------------
// Lock metrics — step 0 instrumentation for the whole-run-hold P0
// (GITNEXUS_COMPARISON.md §13.7 step 0). Covers both entry points:
// `withLock` (index/embed/checker-resolver) and `acquireLock` used directly
// by the JIT staleness path (`mcp/staleness.ts:56`), which is the exact path
// where the P0 symptom appears.
// ---------------------------------------------------------------------------
describe('lock metrics', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-lock-metrics-'));
    initLockMarkers(dir);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records an acquired event then a released event, in that order, for withLock', async () => {
    const { sink, events } = fakeSink();
    await withLock(dir, 'structure', { ...OPTS, caller: 'index-run', sink }, async () => {});

    expect(events.map((e) => e.kind)).toEqual(['acquired', 'released']);
    expect(events[0]).toMatchObject({ kind: 'acquired', type: 'structure', caller: 'index-run' });
    expect(events[1]).toMatchObject({ kind: 'released', type: 'structure', caller: 'index-run' });
  });

  it('records hold duration ordered with how long fn() actually ran (no wall-clock exact match)', async () => {
    const { sink, events } = fakeSink();

    await withLock(dir, 'structure', { ...OPTS, caller: 'short', sink }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await withLock(dir, 'structure', { ...OPTS, caller: 'long', sink }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    const released = events.filter((e): e is Extract<LockEvent, { kind: 'released' }> => e.kind === 'released');
    expect(released).toHaveLength(2);
    // Ordering, not exact values — resilient to a loaded CI machine.
    expect(released[1]!.holdMs).toBeGreaterThan(released[0]!.holdMs);
  });

  it('wraps the release function returned directly by acquireLock, so hold duration is captured on the JIT path', async () => {
    const { sink, events } = fakeSink();
    const release = await acquireLock(dir, 'structure', { ...OPTS, caller: 'jit-staleness', sink });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await release();

    const released = events.filter((e) => e.kind === 'released');
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ kind: 'released', type: 'structure', caller: 'jit-staleness' });
    expect((released[0] as Extract<LockEvent, { kind: 'released' }>).holdMs).toBeGreaterThanOrEqual(0);
  });

  it('records a failed event (not a released event) when all retries are exhausted', async () => {
    const holderRelease = await acquireLock(dir, 'structure', { maxRetries: 0 });
    try {
      const { sink, events } = fakeSink();
      await expect(
        acquireLock(dir, 'structure', { maxRetries: 0, retryIntervalMs: 5, caller: 'jit-staleness', sink }),
      ).rejects.toThrow();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'failed', type: 'structure', caller: 'jit-staleness' });
    } finally {
      await holderRelease();
    }
  });

  it('defaults the caller label to "unknown" when callers omit it', async () => {
    const { sink, events } = fakeSink();
    await withLock(dir, 'structure', { ...OPTS, sink }, async () => {});
    expect(events[0]).toMatchObject({ caller: 'unknown' });
  });
});
