/**
 * Arm identity for the E1-PHASE mechanism A/B.
 *
 * The A/B's entire content is "arm A and arm B differed in `cache_size` /
 * `mmap_size` and in nothing else". If the flag silently failed to reach the
 * connection, both arms would run identically and the A/B would report a clean
 * null — a result that flatters no hypothesis and is therefore easy to accept
 * without checking. This program's §6 rule is that such a result deserves MORE
 * scrutiny, so the seam is verified rather than assumed.
 *
 * These tests run the real `runIndex` and read the pragmas back off the
 * connection it actually used. The pragmas are connection-scoped — a second
 * handle opened afterwards reports its own defaults and would "confirm" a
 * pragma that was never applied — so the read-back has to happen inside
 * `runIndex`, which is why `IndexResult` carries it.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Sqlite from 'better-sqlite3';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';

describe('runIndex — the SQLite tuning pragmas actually in force', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-pragma-'));
    writeFileSync(join(dir, 'a.ts'), 'export function a(): number { return 1; }\n');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reports the tuning options it was given, in the pragmas\' own units', async () => {
    const config = resolveConfig({ projectRoot: dir });

    const result = await runIndex(config, {
      incremental: false,
      dbOptions: { cacheSizeKib: 65_536, mmapSizeBytes: 268_435_456 },
    });

    expect(result.appliedPragmas).toEqual({
      cache_size: -65_536,
      mmap_size: 268_435_456,
    });
  });

  // The control arm. Compared against a bare better-sqlite3 connection rather
  // than hardcoded numbers, so the assertion states the contract ("runIndex set
  // neither pragma") instead of restating SQLite's current defaults.
  it('reports SQLite\'s own defaults when given no tuning options', async () => {
    const probePath = join(dir, 'bare-defaults.db');
    const bare = new Sqlite(probePath);
    const defaults = {
      cache_size: bare.pragma('cache_size', { simple: true }) as number,
      mmap_size: bare.pragma('mmap_size', { simple: true }) as number,
    };
    bare.close();
    rmSync(probePath, { force: true });

    const config = resolveConfig({ projectRoot: dir });

    const result = await runIndex(config, { incremental: false });

    expect(result.appliedPragmas).toEqual(defaults);
  });
});
