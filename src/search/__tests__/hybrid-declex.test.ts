// Stage 6.2 — fuses ranker D (`../declex.ts`, declaration-exact) into
// `hybridSearch` as a third RRF input, behind the `declaration_exact_ranker`
// kill-switch (absent/false at the function layer = OFF; see hybrid.ts's
// `HybridSearchConfig.declaration_exact_ranker` for why the function default
// is OFF even though the product default in `MastConfig` is ON).
//
// The fusion under test must byte-match the measured reconstruction in
// `eval/declex-rank-check.mjs`'s `reconstructWithRankerD` (lines 161-211):
// `searchRankerD(db, query, { limit: candidateLimit })` feeds a third
// rank map into the same RRF sum FTS and vectors already feed.
//
// Fixture convention mirrors `declex.test.ts` (Gate B): a real `openDatabase`
// handle over a temp dir, chunks inserted directly into the `chunks` table
// with the shape the AST extractor produces. Unlike `declex.test.ts` (which
// calls `searchRankerD` directly and never touches FTS), these tests also
// need to control FTS discoverability per chunk, so a second helper inserts
// the matching `chunk_fts` row (shape taken from `graph/populate.ts:187-203`)
// only for chunks that must be reachable by BM25 — a chunk that skips this
// helper is, by construction, an FTS miss, which is exactly the "content
// doesn't contain the query tokens" condition these tests need to isolate
// what the flag alone controls.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../../graph/db.js';
import { SqliteChunkStore } from '../../store/sqliteChunkStore.js';
import { hybridSearch } from '../hybrid.js';

// ---------------------------------------------------------------------------
// Fixture (fresh temp db per test — each test's fixture controls exactly
// which ranker(s) reach which chunk, so sharing state across tests would
// risk cross-test symbol/token collisions).
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Db;
let chunkStore: SqliteChunkStore;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-hybrid-declex-'));
  db = openDatabase(tmpDir);
  chunkStore = new SqliteChunkStore(db);
});

afterEach(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert one row into `chunks`, same shape the AST extractor produces
 * (declex.test.ts's own convention, typescript.ts:280-330). */
async function insertChunk(o: {
  chunk_id: string;
  chunk_type: string;
  symbol_name: string | null;
  parent_symbol?: string | null;
  file_path?: string;
  content?: string;
}): Promise<void> {
  await db.insertInto('chunks').values({
    chunk_id: o.chunk_id,
    file_path: o.file_path ?? 'a.ts',
    start_line: 1,
    end_line: 2,
    content: o.content ?? 'x',
    chunk_type: o.chunk_type,
    symbol_name: o.symbol_name,
    parent_symbol: o.parent_symbol ?? null,
    is_exported: 1,
    language: 'typescript',
    file_mtime: 0,
  }).execute();
}

/** Insert the matching `chunk_fts` row (graph/populate.ts:187-203's own
 * insert shape) — call only for chunks that must be FTS-discoverable. */
async function insertFts(o: {
  chunk_id: string;
  symbol_name: string | null;
  file_path?: string;
  content: string;
}): Promise<void> {
  await db.insertInto('chunk_fts').values({
    content: o.content,
    symbol_name: o.symbol_name,
    chunk_id: o.chunk_id,
    file_path: o.file_path ?? 'a.ts',
  }).execute();
}

const hybridConfig = { rrf_k: 60 };

// ---------------------------------------------------------------------------
// 1. FLAG OFF (absent) — D never fires, absent === explicit false
// ---------------------------------------------------------------------------

describe('hybridSearch — declaration_exact_ranker OFF (absent/false)', () => {
  it('a symbol-name-matched, content-missed chunk stays out of the window; absent and explicit-false runs are identical', async () => {
    // "ScanCodeChord" is D-eligible (contains an uppercase letter) and would
    // full-match this chunk's own symbol_name, but the indexed CONTENT never
    // mentions it — an FTS miss by construction.
    await insertChunk({ chunk_id: 'anchor', chunk_type: 'function', symbol_name: 'ScanCodeChord', content: 'handles a keyboard shortcut binding' });
    await insertFts({ chunk_id: 'anchor', symbol_name: 'ScanCodeChord', content: 'handles a keyboard shortcut binding' });

    const absent = await hybridSearch(db, { query: 'ScanCodeChord' }, hybridConfig, chunkStore);
    const explicitFalse = await hybridSearch(
      db,
      { query: 'ScanCodeChord' },
      { ...hybridConfig, declaration_exact_ranker: false },
      chunkStore,
    );

    expect(absent.results.some((r) => r.symbol_name === 'ScanCodeChord')).toBe(false);
    expect(absent.results).toHaveLength(0);
    expect(explicitFalse.results).toEqual(absent.results);
    expect(explicitFalse.mode).toBe(absent.mode);
  });
});

// ---------------------------------------------------------------------------
// 2. FLAG ON — D fires and the anchor enters the window
// ---------------------------------------------------------------------------

describe('hybridSearch — declaration_exact_ranker ON, D fires', () => {
  it('the same symbol-name-matched chunk enters the window through RRF', async () => {
    await insertChunk({ chunk_id: 'anchor', chunk_type: 'function', symbol_name: 'ScanCodeChord', content: 'handles a keyboard shortcut binding' });
    await insertFts({ chunk_id: 'anchor', symbol_name: 'ScanCodeChord', content: 'handles a keyboard shortcut binding' });

    const { results } = await hybridSearch(
      db,
      { query: 'ScanCodeChord' },
      { ...hybridConfig, declaration_exact_ranker: true },
      chunkStore,
    );

    expect(results.some((r) => r.symbol_name === 'ScanCodeChord')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. FLAG ON, D silent — no eligible terms in the query
// ---------------------------------------------------------------------------

describe('hybridSearch — declaration_exact_ranker ON, D silent (no eligible terms)', () => {
  it('an all-lowercase prose query produces results identical to the flag-off run', async () => {
    // deriveEligiblePrimaryTerms finds nothing in an all-lowercase query, so D
    // contributes zero rows regardless of the flag — the measured invariant
    // (D-silent implies the row is identical to L).
    await insertChunk({ chunk_id: 'prose', chunk_type: 'function', symbol_name: 'handler', content: 'binds a shortcut handler for input events' });
    await insertFts({ chunk_id: 'prose', symbol_name: 'handler', content: 'binds a shortcut handler for input events' });

    const off = await hybridSearch(db, { query: 'binds a shortcut handler' }, hybridConfig, chunkStore);
    const on = await hybridSearch(
      db,
      { query: 'binds a shortcut handler' },
      { ...hybridConfig, declaration_exact_ranker: true },
      chunkStore,
    );

    expect(on.results).toEqual(off.results);
    expect(on.mode).toBe(off.mode);
  });
});

// ---------------------------------------------------------------------------
// 4. RRF additivity — a chunk in both FTS and D outranks a D-only chunk
// ---------------------------------------------------------------------------

describe('hybridSearch — RRF additivity when D and FTS agree', () => {
  it('a chunk present in both FTS and D ranks above an otherwise-equal chunk present in D only', async () => {
    await insertChunk({ chunk_id: 'both', chunk_type: 'function', symbol_name: 'UniqueTokenAlpha', content: 'function UniqueTokenAlpha() { return 1; }' });
    await insertFts({ chunk_id: 'both', symbol_name: 'UniqueTokenAlpha', content: 'function UniqueTokenAlpha() { return 1; }' });

    // D-eligible (uppercase) but its content never mentions the token — an
    // FTS miss, so this chunk reaches the window through D alone.
    await insertChunk({ chunk_id: 'donly', chunk_type: 'function', symbol_name: 'UniqueTokenBeta', content: 'an unrelated function body' });
    await insertFts({ chunk_id: 'donly', symbol_name: 'UniqueTokenBeta', content: 'an unrelated function body' });

    const { results } = await hybridSearch(
      db,
      { query: 'UniqueTokenAlpha UniqueTokenBeta' },
      { ...hybridConfig, declaration_exact_ranker: true },
      chunkStore,
    );

    const bothResult = results.find((r) => r.symbol_name === 'UniqueTokenAlpha');
    const donlyResult = results.find((r) => r.symbol_name === 'UniqueTokenBeta');
    expect(bothResult).toBeDefined();
    expect(donlyResult).toBeDefined();
    expect(bothResult!.rank).toBeLessThan(donlyResult!.rank);
  });
});

// ---------------------------------------------------------------------------
// 5. Dedup interplay — shell/method collapse still applies to D-sourced pairs
// ---------------------------------------------------------------------------

describe('hybridSearch — dedup interplay with D-sourced candidates', () => {
  it('shell/method dedup still collapses a class shell and its method when both are reached only through D', async () => {
    // 'Bar' (not the task's literal lowercase 'bar') because ranker D's
    // primary-arm eligibility gate requires an uppercase letter, underscore,
    // dollar sign, or digit-adjacent letter (declex.ts's isEligiblePrimaryTerm)
    // — a bare lowercase term never reaches D. Capitalizing the method segment
    // keeps both the shell ('Foo', full match) and the method ('Foo.Bar',
    // segment match on 'Bar') D-eligible from the same query, which is the
    // scenario this test needs: both chunks reached purely through D.
    await insertChunk({ chunk_id: 'shell', chunk_type: 'class_shell', symbol_name: 'Foo', file_path: 'foo.ts' });
    await insertChunk({ chunk_id: 'method', chunk_type: 'method', symbol_name: 'Foo.Bar', parent_symbol: 'Foo', file_path: 'foo.ts' });
    // Neither chunk is indexed into chunk_fts — both reach the window via D
    // alone.

    const { results } = await hybridSearch(
      db,
      { query: 'Foo.Bar' },
      { ...hybridConfig, declaration_exact_ranker: true },
      chunkStore,
    );

    const shell = results.find((r) => r.chunk_type === 'class_shell' && r.symbol_name === 'Foo');
    const method = results.find((r) => r.chunk_type === 'method' && r.parent_symbol === 'Foo');
    expect(shell !== undefined && method !== undefined).toBe(false);

    // D's ordering rule (full-name matches before segment matches,
    // declex.ts's own doc comment) makes the shell (full match on 'Foo')
    // deterministically outrank the method (segment match on 'Bar') pre-dedup
    // — so the shell survives and the method is suppressed into its hint.
    expect(shell).toBeDefined();
    expect(method).toBeUndefined();
    expect(shell!.related).toEqual({ methods_matched: ['Foo.Bar'] });
  });
});

// ---------------------------------------------------------------------------
// 6. mode is unaffected by D
// ---------------------------------------------------------------------------

describe('hybridSearch — mode unaffected by D', () => {
  it('mode stays lexical even when D fires', async () => {
    await insertChunk({ chunk_id: 'anchor2', chunk_type: 'function', symbol_name: 'ScanCodeChord', content: 'irrelevant prose' });

    const { mode } = await hybridSearch(
      db,
      { query: 'ScanCodeChord' },
      { ...hybridConfig, declaration_exact_ranker: true },
      chunkStore,
    );

    expect(mode).toBe('lexical');
  });
});

// ---------------------------------------------------------------------------
// 7. Stage 6.3 — D-fire telemetry (`declex` field on hybridSearch's return)
//
// Fixture: 3 FTS-only chunks sharing one lowercase (D-ineligible) term at
// different repetition counts inside `chunk_fts.content` — trigram BM25
// ranks purely by match strength, so `fts_top` > `fts_displaced` >
// `fts_bottom` deterministically — plus 2 D-only chunks reached through two
// distinct uppercase (D-eligible) symbol names, full-name matched, ordered by
// ascending chunk_id per declex.ts's own tie-break (§ registration).
//
// Hand-computed RRF (k=60), scoredWithoutD = FTS-only ids:
//   rank_without_d: fts_top=1, fts_displaced=2, fts_bottom=3
// scored (with D) — d_anchor1/d_anchor2 tie fts_top/fts_displaced's rrf
// exactly (same rank r on a different channel scores identically under RRF),
// broken by Array.prototype.sort's guaranteed stability (ES2019+) preserving
// the pre-sort Set-iteration order (fts keys inserted before d keys):
//   rank_with_d: fts_top=1, d_anchor1=2, fts_displaced=3, d_anchor2=4, fts_bottom=5
// So fts_displaced is genuinely DISPLACED (2 -> 3) by the D-only chunks
// entering above it, and fts_top ties (1 -> 1, no diff, excluded).
// ---------------------------------------------------------------------------

describe('hybridSearch — declex telemetry (Stage 6.3)', () => {
  async function insertTelemetryFixture(): Promise<void> {
    const term = (n: number): string => Array.from({ length: n }, () => 'matchterm').join(' ');

    await insertChunk({ chunk_id: 'fts_top', chunk_type: 'function', symbol_name: 'topSym', content: term(10) });
    await insertFts({ chunk_id: 'fts_top', symbol_name: 'topSym', content: term(10) });

    await insertChunk({ chunk_id: 'fts_displaced', chunk_type: 'function', symbol_name: 'displacedSym', content: term(5) });
    await insertFts({ chunk_id: 'fts_displaced', symbol_name: 'displacedSym', content: term(5) });

    await insertChunk({ chunk_id: 'fts_bottom', chunk_type: 'function', symbol_name: 'bottomSym', content: term(1) });
    await insertFts({ chunk_id: 'fts_bottom', symbol_name: 'bottomSym', content: term(1) });

    // D-only: no chunk_fts row, reached only through declex's direct
    // `chunks.symbol_name` predicate.
    await insertChunk({ chunk_id: 'd_anchor1', chunk_type: 'function', symbol_name: 'AnchorOne' });
    await insertChunk({ chunk_id: 'd_anchor2', chunk_type: 'function', symbol_name: 'AnchorTwo' });
  }

  const telemetryQuery = { query: 'matchterm AnchorOne AnchorTwo' };
  const declexOnConfig = { ...hybridConfig, declaration_exact_ranker: true };

  it('D fired: declex is present with correct diagnostics and a D-only anchor reporting rank_without_d: null', async () => {
    await insertTelemetryFixture();

    const { declex } = await hybridSearch(db, telemetryQuery, declexOnConfig, chunkStore);

    expect(declex).toBeDefined();
    expect(declex!.fired).toBe(true);
    expect(declex!.top_match_channel).toBe('full');
    expect(declex!.candidate_count).toBe(2);

    const anchor = declex!.window_effects.find((w) => w.chunk_id === 'd_anchor1');
    expect(anchor).toBeDefined();
    expect(anchor!.rank_without_d).toBeNull();
    expect(typeof anchor!.rank_with_d).toBe('number');
    expect(anchor!.symbol_name).toBe('AnchorOne');
  });

  it('a displaced chunk reports both numeric ranks with rank_with_d > rank_without_d', async () => {
    await insertTelemetryFixture();

    const { declex } = await hybridSearch(db, telemetryQuery, declexOnConfig, chunkStore);

    const displaced = declex!.window_effects.find((w) => w.chunk_id === 'fts_displaced');
    expect(displaced).toBeDefined();
    expect(displaced!.rank_with_d).not.toBeNull();
    expect(displaced!.rank_without_d).not.toBeNull();
    expect(displaced!.rank_with_d!).toBeGreaterThan(displaced!.rank_without_d!);
  });

  it('D silent (flag on, no eligible terms): declex is absent', async () => {
    await insertChunk({ chunk_id: 'prose2', chunk_type: 'function', symbol_name: 'handler', content: 'binds a shortcut handler for input events' });
    await insertFts({ chunk_id: 'prose2', symbol_name: 'handler', content: 'binds a shortcut handler for input events' });

    const { declex } = await hybridSearch(
      db,
      { query: 'binds a shortcut handler' },
      declexOnConfig,
      chunkStore,
    );

    expect(declex).toBeUndefined();
  });

  it('flag off: declex is absent even when the query would otherwise be D-eligible', async () => {
    await insertTelemetryFixture();

    const { declex } = await hybridSearch(db, telemetryQuery, hybridConfig, chunkStore);

    expect(declex).toBeUndefined();
  });

  it('is deterministic across two identical calls', async () => {
    await insertTelemetryFixture();

    const first = await hybridSearch(db, telemetryQuery, declexOnConfig, chunkStore);
    const second = await hybridSearch(db, telemetryQuery, declexOnConfig, chunkStore);

    expect(second.declex).toEqual(first.declex);
  });
});
