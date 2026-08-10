import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase, type Db } from '../../graph/db.js';
import { SqliteChunkStore } from '../../store/sqliteChunkStore.js';
import { collectPotentialMatchCandidates } from '../potential-matches.js';

// ---------------------------------------------------------------------------
// F10 (Stage 3, IMPLEMENTATION_PLAN.md) — `collectPotentialMatchCandidates`
// silently capped its `identifier_fts` fetch at `limit` with no signal that
// the cap was hit (eval/GITNEXUS_COMPARISON.md M4: `isUndefined` reported 50
// candidates when the real identifier_fts match count was 71). These tests
// drive the collector with an explicit small `limit` (5) against 7 real
// matching chunks — manufacturing 51+ fixtures for the production default
// would be disproportionate; see tools.test.ts's negative-only coverage at
// the production cap for why that's an acceptable budget call (§5.5).
// ---------------------------------------------------------------------------

// Seven distinct top-level functions so each becomes its own chunk (mirrors
// tools.test.ts's MATH_SRC convention of one function per chunk), each
// mentioning the same bare identifier so all seven produce an identifier_fts
// row for it. Not a call (`needleTarget()`) — a call would risk sensitivity to
// unrelated call-resolution behavior this test does not want to depend on;
// `collectPotentialMatchCandidates` only cares that the identifier appears in
// the chunk's identifier bag.
const MENTIONS_SRC = Array.from(
  { length: 7 },
  (_, i) => `export function mention${i}(): void {\n  const marker = needleTarget;\n}\n`,
).join('\n');

describe('collectPotentialMatchCandidates — F10 truncation signal', () => {
  let dir: string;
  let db: Db;
  let chunkStore: SqliteChunkStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mast-potential-matches-'));
    writeFileSync(join(dir, 'mentions.ts'), MENTIONS_SRC);
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
    chunkStore = new SqliteChunkStore(db);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('caps candidates at the injected limit AND reports the real uncapped match count when the fetch comes back full', async () => {
    const result = await collectPotentialMatchCandidates(db, chunkStore, 'needleTarget', [], 5);
    expect(result.candidates).toHaveLength(5);
    expect(result.truncatedMatchCount).toBe(7);
  });

  it('reports no truncation signal when the fetch comes back under the cap', async () => {
    const result = await collectPotentialMatchCandidates(db, chunkStore, 'needleTarget', [], 10);
    expect(result.candidates).toHaveLength(7);
    expect(result.truncatedMatchCount).toBeUndefined();
  });

  it('reports no truncation signal when the symbol has no matches at all', async () => {
    const result = await collectPotentialMatchCandidates(db, chunkStore, 'zzzNoSuchIdentifier', [], 5);
    expect(result.candidates).toHaveLength(0);
    expect(result.truncatedMatchCount).toBeUndefined();
  });
});
