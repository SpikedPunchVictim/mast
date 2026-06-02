import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initLockMarkers, withLock } from '../lock.js';

const OPTS = { maxRetries: 3, retryIntervalMs: 20 } as const;

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
