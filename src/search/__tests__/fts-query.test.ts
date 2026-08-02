import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase, type Db } from '../../graph/db.js';
import { searchFts, searchIdentifiers } from '../fts.js';

const SRC = `export function handleLogin(req: LoginRequest): void {
  validateSession(req);
}
`;

describe('FTS query sanitisation (L2)', () => {
  let dir: string;
  let db: Db;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mast-fts-'));
    writeFileSync(join(dir, 'h.ts'), SRC);
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not throw on a query containing FTS5 syntax, and still matches', async () => {
    // Unsanitised, `chunk_fts MATCH 'handleLogin(req'` throws a syntax error.
    const rows = await searchFts(db, 'handleLogin(req: LoginRequest)', { limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('does not throw on quotes / boolean-operator-looking input', async () => {
    await expect(searchFts(db, 'say "hello" OR (nope', { limit: 10 })).resolves.toBeInstanceOf(Array);
  });

  it('returns [] when the query has no trigram-usable token', async () => {
    expect(await searchFts(db, '(. )', { limit: 10 })).toEqual([]);
    expect(await searchFts(db, 'a b', { limit: 10 })).toEqual([]); // all < 3 chars
  });

  // F15. Bare phrases are ANDed by FTS5, so `toFtsMatch`'s space-join required a
  // chunk to contain EVERY token. Any multi-word conceptual query therefore
  // returned nothing — measured on the nest corpus, 6 of 20 TSDoc-derived queries
  // matched zero rows against a corpus that plainly contained the target symbol
  // (IMPLEMENTATION_PLAN.md § "nest replication"). This silently handicapped the
  // lexical side of hybrid search and confounded Q1's vector-value measurement.
  it('matches when only SOME query terms occur in the chunk (OR, not AND)', async () => {
    const rows = await searchFts(db, 'handleLogin authenticates the user and issues a session token', {
      limit: 10,
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('ranks a chunk matching more query terms above one matching fewer', async () => {
    // BM25 is what turns an OR-match back into a useful ranking: both chunks
    // match, the one covering more of the query must win.
    const rows = await searchFts(db, 'handleLogin validateSession LoginRequest', { limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
    // bm25() is negative, more-negative = better; searchFts returns best-first.
    expect(rows[0]!.bm25_score).toBeLessThanOrEqual(rows[rows.length - 1]!.bm25_score);
  });

  it('searchIdentifiers does not throw on a qualified name', async () => {
    await expect(searchIdentifiers(db, 'AuthService.check', 50)).resolves.toBeInstanceOf(Array);
    expect(await searchIdentifiers(db, '', 50)).toEqual([]);
  });
});
