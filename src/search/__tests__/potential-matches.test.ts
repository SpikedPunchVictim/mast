import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase, type Db } from '../../graph/db.js';
import { SqliteChunkStore } from '../../store/sqliteChunkStore.js';
import { collectPotentialMatchCandidates } from '../potential-matches.js';
import { querySymbolByName, queryVerifiedCallers } from '../../graph/queries.js';

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

// ---------------------------------------------------------------------------
// D156 — a chunk that a verified caller's call sits in is not a potential match
// as well. The collector used to drop a chunk only when it STARTED on the
// verified caller's line, and that line is the call's, so the two met only for
// a call on a declaration's first line. On nest 692 of 2,457 potential entries
// (the 200 most-called names) were a verified caller listed again, and on n8n
// 2,980 of 5,409 (adr/proposals/checker-widening/spikes/d156).
// ---------------------------------------------------------------------------

const LIB_SRC = `export function needle(): number { return 1; }
export function Mark(): (...args: unknown[]) => void { return () => undefined; }
`;

const USERS_SRC = [
  `import { needle, Mark } from './lib';`,
  `export function callsBelowItsFirstLine(): number {`,
  `  const one = 1;`,
  `  return needle() + one;`,
  `}`,
  `export function mentionsWithoutCalling(): unknown {`,
  `  return [needle];`,
  `}`,
  `export class Decorated {`,
  `  @Mark()`,
  `  run(): void {}`,
  `}`,
  // Long enough to be split into pieces: the call is in the first, and the
  // last mentions the name without calling it.
  `export function longCaller(): unknown {`,
  `  needle();`,
  ...Array.from({ length: 130 }, () => `  void 0;`),
  `  return [needle];`,
  `}`,
  // The class's own chunk mentions the name, and the verified call is its method's.
  `export class Holder {`,
  `  held = needle;`,
  `  go(): number { return needle(); }`,
  `}`,
].join('\n') + '\n';

describe('collectPotentialMatchCandidates — a verified caller is not a potential match too (D156)', () => {
  let dir: string;
  let db: Db;
  let chunkStore: SqliteChunkStore;

  const candidatesFor = async (name: string): Promise<string[]> => {
    const [symbol] = await querySymbolByName(db, name, 'lib.ts');
    const verified = await queryVerifiedCallers(db, [symbol!.id], false);
    const { candidates } = await collectPotentialMatchCandidates(db, chunkStore, name, verified);
    return candidates.filter((c) => c.file_path === 'users.ts').map((c) => `${c.chunk_symbol_name ?? '(none)'} @ ${String(c.start_line)}`).sort();
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mast-potential-covered-'));
    writeFileSync(join(dir, 'lib.ts'), LIB_SRC);
    writeFileSync(join(dir, 'users.ts'), USERS_SRC);
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
    chunkStore = new SqliteChunkStore(db);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves out a function whose verified call is below its first line', async () => {
    expect(await candidatesFor('needle')).not.toContain('callsBelowItsFirstLine @ 2');
  });

  it('keeps a function that mentions the name and has no verified call of it', async () => {
    expect(await candidatesFor('needle')).toContain('mentionsWithoutCalling @ 6');
  });

  it('leaves out a method whose verified call is the decorator above it', async () => {
    expect(await candidatesFor('Mark')).not.toContain('Decorated.run @ 11');
  });

  it('keeps a class whose method makes the verified call, and leaves the method out', async () => {
    const inHolder = (await candidatesFor('needle')).filter((c) => c.startsWith('Holder'));

    expect(inHolder).toEqual(['Holder @ 147']);
  });

  it('keeps a later piece of a long caller that mentions the name and holds no verified call', async () => {
    const pieces = (await candidatesFor('needle')).filter((c) => c.startsWith('longCaller'));

    expect(pieces).toHaveLength(1);
    expect(pieces[0]).not.toBe('longCaller @ 13');
  });
});
