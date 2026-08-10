import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase, type Db } from '../../graph/db.js';
import { searchFts, searchIdentifiers, countIdentifierMatches } from '../fts.js';

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

  // F10 (Stage 3): countIdentifierMatches shares searchIdentifiers' phrase-quoted
  // MATCH expression (via a private helper, no duplicated quoting logic) but
  // returns an uncapped count(*) — the raw number collectPotentialMatchCandidates
  // reports when the capped fetch comes back full.
  it('countIdentifierMatches returns the uncapped match count for a real identifier', async () => {
    // SRC's one chunk (the handleLogin function) is the only row whose
    // identifier bag contains 'handleLogin'.
    expect(await countIdentifierMatches(db, 'handleLogin')).toBe(1);
  });

  it('countIdentifierMatches returns 0 for an empty term or a term with no matches', async () => {
    expect(await countIdentifierMatches(db, '')).toBe(0);
    expect(await countIdentifierMatches(db, 'zzzNoSuchIdentifier')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F5 — qualified compounds actually reach identifier_fts through the real
// pipeline (populateFile), and the phrase-quoted query in searchIdentifiers
// matches the adjacent tokens unicode61 produces from a literal "Class.method"
// string (identifier_fts' tokenizer treats '.' as a separator — see
// graph/db.ts's identifier_fts DDL).
// ---------------------------------------------------------------------------

describe('searchIdentifiers — qualified compounds (F5)', () => {
  let dir: string;
  let db: Db;

  // Declaration site: `UserRepository.findByEmail` is self-discoverable from
  // its own method chunk (F5's "declaration typically appears" claim).
  const DECL_SRC = `export class UserRepository {
  findByEmail(): void {}
}
`;
  // Mention site: a field_type-resolved call to the SAME qualified name, in
  // a different file/chunk.
  const CALLER_SRC = `export class AuthService {
  constructor(private readonly repo: UserRepository) {}
  check(): void { this.repo.findByEmail(); }
}
`;
  // Cross-class precision fixture: this chunk's bag contains the unrelated
  // bare token 'Foo' (from an unused constructor-param-property annotation)
  // and, separately, the qualified compound 'Bar.close' (from the resolved
  // call below) — but 'Foo' and 'close' are never adjacent in the bag, and
  // no 'Foo.close' compound is ever emitted (nothing calls `this.f...`).
  const PRECISION_SRC = `export class Caller {
  constructor(private readonly b: Bar, private readonly f: Foo) {}
  run(): void {
    this.b.close();
  }
}
`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mast-fts-qualified-'));
    writeFileSync(join(dir, 'repo.ts'), DECL_SRC);
    writeFileSync(join(dir, 'auth.ts'), CALLER_SRC);
    writeFileSync(join(dir, 'precision.ts'), PRECISION_SRC);
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a phrase query for a qualified method name matches both the declaration chunk and the qualified-mention chunk', async () => {
    const rows = await searchIdentifiers(db, 'UserRepository.findByEmail');
    const chunkIds = [...new Set(rows.map((r) => r.chunk_id))];
    expect(chunkIds.length).toBeGreaterThanOrEqual(2);

    const chunks = await db
      .selectFrom('chunks')
      .select(['file_path', 'symbol_name'])
      .where('chunk_id', 'in', chunkIds)
      .execute();
    expect(chunks.some((c) => c.file_path === 'repo.ts' && c.symbol_name === 'UserRepository.findByEmail')).toBe(true);
    expect(chunks.some((c) => c.file_path === 'auth.ts' && c.symbol_name === 'AuthService.check')).toBe(true);
  });

  it('does NOT match a chunk whose bag has only an unrelated bare token plus a different class\'s qualified compound (cross-class precision)', async () => {
    // Nothing in the corpus ever emits a 'Foo.close' compound, and the bare
    // 'Foo'/'close' tokens in precision.ts's bag are not adjacent — the
    // phrase query must return nothing.
    expect(await searchIdentifiers(db, 'Foo.close')).toEqual([]);

    // The real compound 'Bar.close' — emitted for the SAME chunk — must match.
    const barRows = await searchIdentifiers(db, 'Bar.close');
    expect(barRows.length).toBeGreaterThan(0);
    const barChunks = await db
      .selectFrom('chunks')
      .select(['file_path', 'symbol_name'])
      .where('chunk_id', 'in', barRows.map((r) => r.chunk_id))
      .execute();
    expect(barChunks.some((c) => c.file_path === 'precision.ts' && c.symbol_name === 'Caller.run')).toBe(true);
  });
});
