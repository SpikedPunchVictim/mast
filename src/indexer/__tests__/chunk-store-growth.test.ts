import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase } from '../../graph/db.js';
import { SqliteChunkStore } from '../../store/sqliteChunkStore.js';

// ---------------------------------------------------------------------------
// M1 growth regression (eval/GITNEXUS_COMPARISON.md §15.1, IMPLEMENTATION_PLAN.md
// Stage 2's Tests row: "a version-manifest-count assertion is meaningless
// post-migration — replace with an O(N) row-count/growth assertion").
//
// The defect this replaces: LanceDB's `chunks.lance` kept a NEW manifest
// version on every `countRows`+`delete`+`add` write, so REPEATED writes to the
// same corpus (incremental reindexes, in-place edits) grew `_versions/` file
// count without bound — 2,756 manifests / 176 MB over 9.4 MB of actual data
// (§14.1). The `chunks` table has no version history: a write is a real
// SQLite DELETE+INSERT, so N writes to the SAME content produce the SAME row
// count, not N times as many rows/manifests.
// ---------------------------------------------------------------------------

const CHURN_FILE = 'churn.ts';
const STABLE_FILES = ['a.ts', 'b.ts', 'c.ts'];

function churnSource(n: number): string {
  return `export function churn(): number {\n  return ${n};\n}\n`;
}

describe('chunks table growth is O(current content), not O(writes) — M1', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mast-growth-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('row count stays exactly equal to current live chunks across 10 rewrites of one file', async () => {
    for (const f of STABLE_FILES) {
      writeFileSync(join(dir, f), `export function ${f.replace('.ts', '')}(): number { return 1; }\n`);
    }
    writeFileSync(join(dir, CHURN_FILE), churnSource(0));
    const config = resolveConfig({ projectRoot: dir });

    await runIndex(config, { incremental: false });

    // Each of the 4 files declares exactly one exported function -> exactly
    // one chunk each. This count must hold after every subsequent rewrite —
    // it is the O(N)-not-O(N^2) proof: row count tracks CURRENT content, not
    // the number of writes ever performed against it.
    const EXPECTED_TOTAL = STABLE_FILES.length + 1;

    const sizesAfterEachRewrite: number[] = [];
    for (let i = 1; i <= 10; i++) {
      // Rewrite the SAME file with different content each time — the exact
      // access pattern (repeated in-place edits) that grew chunks.lance's
      // manifest count without bound pre-migration.
      writeFileSync(join(dir, CHURN_FILE), churnSource(i));
      await runIndex(config, { incremental: true });

      const db = openDatabase(config.resolved_state_dir);
      // Checkpoint WAL into the main file so the size measurement below
      // reflects committed content, not an artifact of how much WAL is
      // pending flush at the moment of measurement.
      await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(db);
      const chunkStore = new SqliteChunkStore(db);
      const total = await chunkStore.chunkCount();
      await db.destroy();

      expect(total).toBe(EXPECTED_TOTAL);
      sizesAfterEachRewrite.push(statSync(join(config.resolved_state_dir, 'graph.db')).size);
    }

    // Storage-side corroboration: byte size after 10 rewrites of unchanged-
    // shape content must not have grown anywhere near linearly with the
    // rewrite count (Lance's manifest growth WAS linear-to-superlinear in
    // write count, per store-spike.json's R1 finding). A generous 3x bound
    // (vs. the first measured size) distinguishes "bounded" from "unbounded
    // accumulation" without being sensitive to SQLite's own page-size
    // rounding noise.
    const first = sizesAfterEachRewrite[0]!;
    const last = sizesAfterEachRewrite[sizesAfterEachRewrite.length - 1]!;
    expect(last).toBeLessThan(first * 3);
  });

  it('row count grows linearly with unique files across successive incremental adds, not with run count', async () => {
    const config = resolveConfig({ projectRoot: dir });
    writeFileSync(join(dir, 'f0.ts'), 'export function f0(): number { return 1; }\n');
    await runIndex(config, { incremental: false });

    // Add one new file per incremental run, 5 times — each run's chunk total
    // must increase by exactly 1 (the new file's chunk), never more, proving
    // no accumulation from the PREVIOUS runs' writes re-landing extra rows.
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(dir, `f${i}.ts`), `export function f${i}(): number { return ${i}; }\n`);
      await runIndex(config, { incremental: true });

      const db = openDatabase(config.resolved_state_dir);
      const total = await new SqliteChunkStore(db).chunkCount();
      await db.destroy();

      expect(total).toBe(i + 1);
    }
  });
});
