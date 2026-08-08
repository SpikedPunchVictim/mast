import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  countTokens,
  estimateFullFileBound,
  FULL_FILE_BOUND_CACHE_LIMIT,
  FULL_FILE_TOKENIZE_BUDGET_PER_CALL,
  BYTES_PER_TOKEN_ESTIMATE,
  __seedFullFileCacheForTests,
  type FullFileReader,
} from '../tokenizer.js';

// ---------------------------------------------------------------------------
// estimateFullFileBound (§14.2 — the "naive Read of every result file" bound)
//
// Every test gets its own temp directory so absolute paths never collide with
// another test's entries in the module-level token cache. Tests that exercise
// the per-call tokenization budget (F8 — "cap the work, not the cache") use a
// fully in-memory fake reader instead of real files, both to keep control over
// exact byte sizes for the size-estimate math and to avoid real disk I/O for
// the thousands of paths the budget/eviction tests need.
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mast-fullfilebound-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('estimateFullFileBound', () => {
  it('sums tokenizer counts over the full contents of the referenced files', () => {
    const aContent = 'export const a = 1;\n';
    const bContent = 'export function b(): number {\n  return 2;\n}\n';
    writeFileSync(join(dir, 'a.ts'), aContent);
    writeFileSync(join(dir, 'b.ts'), bContent);

    const bound = estimateFullFileBound(['a.ts', 'b.ts'], dir);

    expect(bound).toBe(countTokens(aContent) + countTokens(bContent));
    expect(bound).toBeGreaterThan(0);
  });

  it('counts a repeated file path once (dedup)', () => {
    const content = 'export const a = 1;\n';
    writeFileSync(join(dir, 'a.ts'), content);

    const once = estimateFullFileBound(['a.ts'], dir);
    const repeated = estimateFullFileBound(['a.ts', 'a.ts', 'a.ts'], dir);

    expect(repeated).toBe(once);
  });

  it('contributes 0 for a missing file without throwing, while still counting the rest', () => {
    const content = 'export const a = 1;\n';
    writeFileSync(join(dir, 'a.ts'), content);

    const bound = estimateFullFileBound(['a.ts', 'does-not-exist.ts'], dir);

    expect(bound).toBe(countTokens(content));
  });

  it('never throws even when every referenced file is missing', () => {
    expect(() => estimateFullFileBound(['nope-a.ts', 'nope-b.ts'], dir)).not.toThrow();
    expect(estimateFullFileBound(['nope-a.ts', 'nope-b.ts'], dir)).toBe(0);
  });

  it('skips re-reading a file on a second call when its mtime is unchanged (cache hit)', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    const fixedMtime = statSync(join(dir, 'a.ts')).mtimeMs / 1_000;
    const fixedSize = statSync(join(dir, 'a.ts')).size;

    let readCalls = 0;
    let statCalls = 0;
    const reader: FullFileReader = {
      readFile: (p) => {
        readCalls++;
        return readFileSync(p, 'utf8');
      },
      stat: (_p) => {
        statCalls++;
        return { mtimeSeconds: fixedMtime, sizeBytes: fixedSize };
      },
    };

    estimateFullFileBound(['a.ts'], dir, reader);
    estimateFullFileBound(['a.ts'], dir, reader);

    // The mtime is checked on every call (to detect edits) but the file
    // content is only ever read — and tokenized — once while the mtime holds.
    expect(statCalls).toBe(2);
    expect(readCalls).toBe(1);
  });

  it('re-reads a file whose mtime changed since the cached entry', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');

    let mtime = 1_000;
    let readCalls = 0;
    const reader: FullFileReader = {
      readFile: (p) => {
        readCalls++;
        return readFileSync(p, 'utf8');
      },
      stat: (_p) => ({ mtimeSeconds: mtime, sizeBytes: 21 }),
    };

    estimateFullFileBound(['a.ts'], dir, reader);
    mtime = 2_000; // simulate an on-disk edit between calls
    estimateFullFileBound(['a.ts'], dir, reader);

    expect(readCalls).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Per-call tokenization budget (F8 — eval/GITNEXUS_COMPARISON.md §13.7):
  // estimateFullFileBound() referenced all 1,334 project files on every
  // mast_project_skeleton call, each fully read + tokenized (~24ms/file),
  // costing ~28s/call. Cache misses beyond FULL_FILE_TOKENIZE_BUDGET_PER_CALL
  // are now size-estimated instead of exactly tokenized.
  // -------------------------------------------------------------------------

  it('tokenizes exactly the per-call budget of uncached paths; the rest are size-estimated', () => {
    const budget = FULL_FILE_TOKENIZE_BUDGET_PER_CALL;
    const extra = 3;
    const totalPaths = budget + extra;
    const paths = Array.from({ length: totalPaths }, (_, i) => `f${i}.ts`);

    // Deterministic per-index content/size so both the exact-tokenizer path
    // and the size-estimate path can be predicted precisely.
    const contentFor = (i: number): string => `export const v${i} = ${'x'.repeat(i)};\n`;
    const sizeFor = (i: number): number => Buffer.byteLength(contentFor(i), 'utf8');
    const indexOf = (absPath: string): number => Number(/f(\d+)\.ts$/.exec(absPath)![1]);

    let readCalls = 0;
    const reader: FullFileReader = {
      readFile: (p) => {
        readCalls++;
        return contentFor(indexOf(p));
      },
      stat: (p) => ({ mtimeSeconds: 1, sizeBytes: sizeFor(indexOf(p)) }),
    };

    const bound = estimateFullFileBound(paths, '/fake-root-budget', reader);

    expect(readCalls).toBe(budget);

    let expected = 0;
    for (let i = 0; i < totalPaths; i++) {
      expected +=
        i < budget
          ? countTokens(contentFor(i))
          : Math.ceil(sizeFor(i) / BYTES_PER_TOKEN_ESTIMATE);
    }
    expect(bound).toBe(expected);
  });

  it('cache hits are free and do not consume the per-call budget', () => {
    const budget = FULL_FILE_TOKENIZE_BUDGET_PER_CALL;
    const warmPaths = Array.from({ length: 5 }, (_, i) => `warm${i}.ts`);
    const coldPaths = Array.from({ length: 40 }, (_, i) => `cold${i}.ts`);

    let readCalls = 0;
    const reader: FullFileReader = {
      readFile: (p) => {
        readCalls++;
        return `export const v = "${p}";\n`;
      },
      stat: (_p) => ({ mtimeSeconds: 1, sizeBytes: 100 }),
    };

    // Pre-warm: cache all 5 warm paths (well under budget).
    estimateFullFileBound(warmPaths, '/fake-root-cache-hits', reader);
    readCalls = 0; // only the mixed second call is under test from here

    estimateFullFileBound([...warmPaths, ...coldPaths], '/fake-root-cache-hits', reader);

    // The 5 warm paths hit the cache for free; the budget applies only to the
    // 40 cold paths, capping exact reads at `budget` regardless of the hits.
    expect(readCalls).toBe(budget);
  });

  it('does not cache a size-estimated path: it re-stats every call and converts to exact once budget reaches it', () => {
    const budget = FULL_FILE_TOKENIZE_BUDGET_PER_CALL;
    const fillerPaths = Array.from({ length: budget }, (_, i) => `filler${i}.ts`);
    const targetPath = 'beyond-budget.ts';
    const targetContent = 'export const target = 1;\n';

    let statCallsForTarget = 0;
    let readCallsForTarget = 0;
    const reader: FullFileReader = {
      readFile: (p) => {
        if (p.endsWith(targetPath)) readCallsForTarget++;
        return targetContent;
      },
      stat: (p) => {
        if (p.endsWith(targetPath)) statCallsForTarget++;
        return { mtimeSeconds: 1, sizeBytes: 40 };
      },
    };

    // Call 1: fillers exhaust the budget; the target falls beyond it and is
    // size-estimated, not cached.
    estimateFullFileBound([...fillerPaths, targetPath], '/fake-root-not-cached', reader);
    expect(statCallsForTarget).toBe(1);
    expect(readCallsForTarget).toBe(0);

    // Call 2: target alone is well under budget — becomes an exact, cached read.
    estimateFullFileBound([targetPath], '/fake-root-not-cached', reader);
    expect(statCallsForTarget).toBe(2);
    expect(readCallsForTarget).toBe(1);

    // Call 3: now a cache hit — mtime is still checked, but no further read.
    estimateFullFileBound([targetPath], '/fake-root-not-cached', reader);
    expect(statCallsForTarget).toBe(3);
    expect(readCallsForTarget).toBe(1);
  });

  it('converges to fully-exact caching across repeated calls, then stops calling readFile entirely', () => {
    const budget = FULL_FILE_TOKENIZE_BUDGET_PER_CALL;
    const totalPaths = budget + 8; // deliberately not a multiple of the budget
    const paths = Array.from({ length: totalPaths }, (_, i) => `f${i}.ts`);

    let totalReadCalls = 0;
    const readPathsSeen = new Set<string>();
    const reader: FullFileReader = {
      readFile: (p) => {
        totalReadCalls++;
        readPathsSeen.add(p);
        return 'export const v = 1;\n';
      },
      stat: (_p) => ({ mtimeSeconds: 1, sizeBytes: 40 }),
    };

    estimateFullFileBound(paths, '/fake-root-converge', reader);
    expect(readPathsSeen.size).toBe(budget); // round 1: first 32 become exact
    expect(totalReadCalls).toBe(budget);

    estimateFullFileBound(paths, '/fake-root-converge', reader);
    expect(readPathsSeen.size).toBe(totalPaths); // round 2: the remaining 8 converge
    expect(totalReadCalls).toBe(totalPaths);

    const readCallsAfterRound2 = totalReadCalls;
    estimateFullFileBound(paths, '/fake-root-converge', reader);
    // round 3: every path is a cache hit — readFile is never called again.
    expect(totalReadCalls).toBe(readCallsAfterRound2);
  });

  it('a missing file consumes no budget; an unreadable file (stat ok, read fails) wastes its granted slot', () => {
    const budget = FULL_FILE_TOKENIZE_BUDGET_PER_CALL;
    const realContent = 'export const v = 1;\n';

    // A missing file's stat() throws before the budget check is ever reached,
    // so it must not steal a slot from the `budget` real files behind it.
    const missingPath = 'missing.ts';
    const realPaths = Array.from({ length: budget }, (_, i) => `real${i}.ts`);

    let readCallsA = 0;
    const readerA: FullFileReader = {
      readFile: (_p) => {
        readCallsA++;
        return realContent;
      },
      stat: (p) => {
        if (p.endsWith(missingPath)) throw new Error('ENOENT');
        return { mtimeSeconds: 1, sizeBytes: 40 };
      },
    };

    const boundA = estimateFullFileBound([missingPath, ...realPaths], '/fake-root-missing', readerA);
    expect(readCallsA).toBe(budget); // the missing file did not consume a slot
    expect(boundA).toBe(budget * countTokens(realContent));

    // An unreadable file (stat succeeds, readFile throws) DOES consume the
    // slot it was granted — the simplest honest rule: a failed read wastes
    // the budget grant rather than freeing it for the next path. So only
    // `budget - 1` of the real files behind it get exact treatment.
    const unreadablePath = 'unreadable.ts';
    let readCallsB = 0;
    const readerB: FullFileReader = {
      readFile: (p) => {
        readCallsB++;
        if (p.endsWith(unreadablePath)) throw new Error('EACCES');
        return realContent;
      },
      stat: (_p) => ({ mtimeSeconds: 1, sizeBytes: 40 }),
    };

    const boundB = estimateFullFileBound([unreadablePath, ...realPaths], '/fake-root-unreadable', readerB);
    expect(readCallsB).toBe(budget); // 1 failed attempt + (budget - 1) successes
    const exactCount = budget - 1;
    const estimatedCount = realPaths.length - exactCount;
    expect(boundB).toBe(
      exactCount * countTokens(realContent) +
        estimatedCount * Math.ceil(40 / BYTES_PER_TOKEN_ESTIMATE),
    );
  });

  it('evicts the oldest entry once the raised cache bound is exceeded', () => {
    // Seeding via __seedFullFileCacheForTests (not real calls through
    // estimateFullFileBound) is deliberate: countTokens profiles at ~22ms
    // per call *regardless of content length* (a fixed per-invocation
    // floor — see the doc comment on __seedFullFileCacheForTests), so
    // driving FULL_FILE_BOUND_CACHE_LIMIT (8192) real reads through the
    // public API to populate this test would cost ~3 minutes. Seeding goes
    // through the same cacheTouch() insert-and-evict-oldest path production
    // code uses, against the real, unmodified exported constant — only the
    // (here irrelevant) cost of real tokenization is skipped.
    const seedRoot = '/fake-root-evict-seed';
    for (let i = 0; i < FULL_FILE_BOUND_CACHE_LIMIT; i++) {
      __seedFullFileCacheForTests(join(seedRoot, `seed${i}.ts`), 1, 1);
    }

    let readCalls = 0;
    const reader: FullFileReader = {
      readFile: (_p) => {
        readCalls++;
        return 'export const v = 1;\n';
      },
      stat: (_p) => ({ mtimeSeconds: 1, sizeBytes: 40 }),
    };

    // The cache sits exactly at its bound (8192 entries, no eviction yet).
    // One genuine call for a brand-new path pushes it to 8193 — one over —
    // which should evict the oldest seeded entry (seed0).
    const bound = estimateFullFileBound(['new.ts'], seedRoot, reader);
    expect(readCalls).toBe(1);
    expect(bound).toBe(countTokens('export const v = 1;\n'));

    // Evicted: re-querying seed0 forces a real read again.
    estimateFullFileBound(['seed0.ts'], seedRoot, reader);
    expect(readCalls).toBe(2);

    // Survives: the most-recently-seeded entry is still cache-hit, no read.
    readCalls = 0;
    estimateFullFileBound([`seed${FULL_FILE_BOUND_CACHE_LIMIT - 1}.ts`], seedRoot, reader);
    expect(readCalls).toBe(0);
  });
});
