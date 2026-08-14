/**
 * E1-FTS instrument — the four write-phase spans, and arm G's delete skip.
 *
 * Registration: IMPLEMENTATION_PLAN.md § E1-FTS PRE-REGISTRATION (2026-08-14).
 *
 * The hypothesis under test there is that `DELETE FROM chunk_fts WHERE
 * file_path = ?` is a full table scan (FTS5's `xBestIndex` will not consume an
 * equality constraint on an ordinary column, `sqlite3.c:260775-260860`) that on
 * a cold build matches zero rows every time — quadratic and entirely wasted.
 *
 * What this file pins is the INSTRUMENT, not the hypothesis: that the spans are
 * attributed to the statements they claim to measure, that they tile without
 * double-counting, and — the load-bearing one — that arm G's skip leaves the
 * finished database identical on a cold build, which is the whole reason arm G
 * is confound-free where the cut arm F was not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { populateFile, newWriteSpans, type WriteSpansMs } from '../populate.js';
import type { FileIndexData } from '../populate.js';
import type { Chunk, SymbolRecord } from '../../ast/types.js';
import type { IdentifierRow } from '../../ast/extractor.js';

function makeChunks(filePath: string, count: number): Chunk[] {
  return Array.from({ length: count }, (_, i) => ({
    chunk_id: `${filePath}:${i}`,
    file_path: filePath,
    start_line: i * 2 + 1,
    end_line: i * 2 + 2,
    content: `function f${i}() { return ${i}; }`,
    chunk_type: 'function' as const,
    symbol_name: `f${i}`,
    parent_symbol: null,
    is_exported: true,
    language: 'typescript' as const,
    file_mtime: 1_700_000_000,
  }));
}

function makeSymbols(count: number): SymbolRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `s${i}`,
    kind: 'function',
    line: i + 1,
    isExported: true,
    declarationHash: null,
    bodyHash: null,
  }));
}

function makeIdentifierRows(filePath: string, count: number): IdentifierRow[] {
  return Array.from({ length: count }, (_, i) => ({
    chunk_id: `${filePath}:${i}`,
    identifiers: `f${i} return`,
  }));
}

function fileData(filePath: string, mtime = 1_700_000_000, count = 40): Omit<FileIndexData, 'edges'> {
  return {
    filePath,
    language: 'typescript',
    mtime,
    chunks: makeChunks(filePath, count),
    imports: [],
    symbols: makeSymbols(count),
    identifierRows: makeIdentifierRows(filePath, count),
  };
}

/** Every FTS row the two virtual tables hold, in a stable order — arm G's identity claim. */
async function ftsContent(db: Db): Promise<{
  chunk: { content: string; symbol_name: string | null; chunk_id: string; file_path: string }[];
  identifier: { identifiers: string; chunk_id: string; file_path: string }[];
}> {
  const chunk = await db
    .selectFrom('chunk_fts')
    .select(['content', 'symbol_name', 'chunk_id', 'file_path'])
    .orderBy('chunk_id')
    .execute();
  const identifier = await db
    .selectFrom('identifier_fts')
    .select(['identifiers', 'chunk_id', 'file_path'])
    .orderBy('chunk_id')
    .execute();
  return { chunk, identifier };
}

describe('write spans — the four directly-timed regions of the write phase', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-spans-'));
    db = openDatabase(dir);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts every span at zero', () => {
    expect(newWriteSpans()).toEqual({ fts_del: 0, fts_ins: 0, commit: 0, rest: 0, txn: 0, lock: 0 });
  });

  // AMENDMENT 1 (2026-08-14, pre-run). The four registered spans left a
  // per-FILE constant unattributed — connection checkout, two `busy_timeout`
  // pragmas and `BEGIN IMMEDIATE`. Measured at 0.72 ms/file, that is ~33% of
  // T1's write phase and ~2% of T9's, so the registered tiling gate would have
  // voided the cheapest rung — the one that anchors the exponent — while
  // passing the rung where the answer is least in doubt.
  it('attributes the per-file transaction machinery to its own span', async () => {
    const spans = newWriteSpans();
    await populateFile(db, fileData('a.ts'), { spans });
    expect(spans.txn).toBeGreaterThan(0);
  });

  it('records all five spans for a populated file', async () => {
    const spans = newWriteSpans();
    await populateFile(db, fileData('a.ts'), { spans });

    for (const key of ['fts_del', 'fts_ins', 'commit', 'rest', 'txn'] as const) {
      expect([key, spans[key] >= 0 && Number.isFinite(spans[key])]).toEqual([key, true]);
    }
    // `rest` covers the guard SELECT, the files row and 40 chunks + 40 symbols;
    // it cannot be a no-op even on a clock with sub-microsecond resolution.
    expect(spans.rest).toBeGreaterThan(0);
  });

  it('accumulates across files rather than reporting only the last one', async () => {
    const spans = newWriteSpans();
    await populateFile(db, fileData('a.ts'), { spans });
    const afterFirst: WriteSpansMs = { ...spans };

    await populateFile(db, fileData('b.ts'), { spans });

    for (const key of ['fts_del', 'fts_ins', 'commit', 'rest', 'txn'] as const) {
      expect([key, spans[key] >= afterFirst[key]]).toEqual([key, true]);
    }
    expect(spans.rest).toBeGreaterThan(afterFirst.rest);
  });

  // The registration forbids computing any span by subtraction. The check that
  // matters for that is not "do they sum to the total" — it is that they never
  // sum to MORE than the wall time they are carved out of, which is what a
  // double-counted (nested) region would produce.
  it('never sums to more than the wall time it is carved out of', async () => {
    const spans = newWriteSpans();
    const started = performance.now();
    await populateFile(db, fileData('a.ts', 1_700_000_000, 400), { spans });
    const wall = performance.now() - started;

    const total = spans.fts_del + spans.fts_ins + spans.commit + spans.rest + spans.txn;
    expect([total <= wall, total, wall]).toEqual([true, total, wall]);
  });

  it('leaves the accumulator untouched when no spans object is passed', async () => {
    // The production path takes no accumulator at all, so the timers must not
    // be reachable from it — this is what keeps `mast index` free of the cost.
    const result = await populateFile(db, fileData('a.ts'));
    expect(result.written).toBe(true);
  });
});

describe('skipFtsDeletes — arm G, the causal test and the fix rehearsal', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-armg-'));
    db = openDatabase(dir);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  // Arm F ("skip FTS5 writes entirely") was cut because it shrinks the database
  // ~69% and E1-AB established write time is coupled to database size — it would
  // have confounded "FTS work removed" with "smaller database" in the direction
  // that flatters a positive result. Arm G's whole claim to being confound-free
  // is THIS: on a cold build the skipped deletes matched nothing, so the finished
  // database is identical. If this test ever fails, the arm is invalid.
  it('produces identical FTS content to the default path on a cold build', async () => {
    await populateFile(db, fileData('a.ts'), { skipFtsDeletes: true });
    await populateFile(db, fileData('b.ts'), { skipFtsDeletes: true });
    const skipped = await ftsContent(db);

    const dir2 = mkdtempSync(join(tmpdir(), 'mast-armg-ctl-'));
    const control = openDatabase(dir2);
    try {
      await populateFile(control, fileData('a.ts'));
      await populateFile(control, fileData('b.ts'));
      expect(skipped).toEqual(await ftsContent(control));
    } finally {
      await control.destroy();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('attributes zero to fts_del when the deletes did not run', async () => {
    // Pins the timer to the DELETEs specifically. A timer that had drifted onto
    // a neighbouring statement would keep reporting time here.
    const spans = newWriteSpans();
    await populateFile(db, fileData('a.ts'), { spans, skipFtsDeletes: true });

    expect(spans.fts_del).toBe(0);
    expect(spans.fts_ins).toBeGreaterThan(0);
  });

  // The reason this flag is named `unsafe` at the CLI and refused on the
  // incremental path. Recorded as a test so that nobody promotes it to a
  // performance option without meeting the evidence for why it is not one.
  it('leaves stale FTS rows behind when a file is re-indexed — why it is eval-only', async () => {
    await populateFile(db, fileData('a.ts', 1_700_000_000, 3), { skipFtsDeletes: true });
    await populateFile(db, fileData('a.ts', 1_700_000_100, 3), { skipFtsDeletes: true });

    const rows = await db.selectFrom('chunk_fts').select('chunk_id').execute();
    expect(rows).toHaveLength(6); // 3 stale + 3 fresh — the index is now wrong

    const guarded = await db
      .selectFrom('chunks')
      .select('chunk_id')
      .where('file_path', '=', 'a.ts')
      .execute();
    expect(guarded).toHaveLength(3); // the ordinary table still replaced correctly
  });

  it('replaces FTS rows normally when the flag is absent', async () => {
    await populateFile(db, fileData('a.ts', 1_700_000_000, 3));
    await populateFile(db, fileData('a.ts', 1_700_000_100, 3));

    const rows = await db.selectFrom('chunk_fts').select('chunk_id').execute();
    expect(rows).toHaveLength(3);
  });
});
