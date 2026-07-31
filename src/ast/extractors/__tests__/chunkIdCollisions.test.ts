import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TypeScriptExtractor, chunkId, sha256 } from '../typescript.js';
import { parseSource } from '../../parser.js';
import { extractFile, dedupeChunkIds, remapIdentifierRows } from '../../extract.js';
import type { Chunk } from '../../types.js';
import type { IdentifierRow } from '../../extractor.js';

// ---------------------------------------------------------------------------
// `chunk_id` collision fixes (GITNEXUS_COMPARISON.md §15.3):
//   Part 1 — typescript.ts skips zero-content nodes (e.g. `empty_statement`)
//            in the default block branch, killing the `declare module 'x';`
//            collision at its source.
//   Part 2 — extract.ts's `dedupeChunkIds` disambiguates genuine same-line
//            siblings (real declarations sharing one physical line, or
//            generated/minified files where every statement shares a line)
//            with a namespaced ordinal, at the one dispatch chokepoint so
//            every extractor is covered.
// ---------------------------------------------------------------------------

const extractor = new TypeScriptExtractor();
const CONTEXT_LINES = 0;
const THRESHOLD = 100;

function extractChunks(src: string, filePath = 'file.ts'): Chunk[] {
  const tree = parseSource(src, '.ts');
  return extractor.extractChunks(tree, src, filePath, 0, CONTEXT_LINES, THRESHOLD);
}

function mkChunk(overrides: Partial<Chunk> & Pick<Chunk, 'chunk_id' | 'start_line'>): Chunk {
  return {
    file_path: 'f.ts',
    end_line: overrides.start_line,
    content: 'x',
    chunk_type: 'block',
    symbol_name: null,
    parent_symbol: null,
    is_exported: false,
    language: 'typescript',
    file_mtime: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part 1 — empty_statement / zero-content node skip
// ---------------------------------------------------------------------------
describe('empty_statement skip (Part 1)', () => {
  const SRC = "declare module '*.md';\ndeclare module '*.yaml';\n";

  it('collapses 4 raw chunks (2 real declarations + 2 bare `;`) to 2, all ids unique', () => {
    const chunks = extractChunks(SRC, 'shims.d.ts');
    expect(chunks).toHaveLength(2);
    expect(new Set(chunks.map((c) => c.chunk_id)).size).toBe(2);
  });

  it('keeps the real declarations, not the empty `;` statements', () => {
    const chunks = extractChunks(SRC, 'shims.d.ts');
    expect(chunks.map((c) => c.content.trim())).toEqual([
      "declare module '*.md';",
      "declare module '*.yaml';",
    ]);
  });

  it('assigns the ids the surviving declarations would always have had (near-zero churn)', () => {
    const chunks = extractChunks(SRC, 'shims.d.ts');
    expect(chunks[0]!.chunk_id).toBe(chunkId('shims.d.ts', 1));
    expect(chunks[1]!.chunk_id).toBe(chunkId('shims.d.ts', 2));
  });
});

describe('no-collision regression (Part 1)', () => {
  it('does not change ids or chunk count for a normal multi-line file', () => {
    const SRC = `export function greet(name: string): string {
  return 'hi ' + name;
}

export const VERSION = '1.0.0';
`;
    const chunks = extractChunks(SRC, 'normal.ts');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.chunk_id).toBe(chunkId('normal.ts', 1));
    expect(chunks[1]!.chunk_id).toBe(chunkId('normal.ts', 5));
  });
});

// ---------------------------------------------------------------------------
// Part 2 — dedupeChunkIds (pure)
// ---------------------------------------------------------------------------
describe('dedupeChunkIds (Part 2 — namespaced ordinal)', () => {
  it('keeps the first chunk at a colliding id unchanged; each subsequent one gets a namespaced-ordinal id', () => {
    const shared = chunkId('f.ts', 2);
    const chunks: Chunk[] = [
      mkChunk({ chunk_id: shared, start_line: 2, symbol_name: 'Dep3.a1' }),
      mkChunk({ chunk_id: shared, start_line: 2, symbol_name: 'Dep3.a2' }),
      mkChunk({ chunk_id: shared, start_line: 2, symbol_name: 'Dep3.a3' }),
      mkChunk({ chunk_id: shared, start_line: 2, symbol_name: 'Dep3.a4' }),
    ];

    const deduped = dedupeChunkIds(chunks);

    expect(deduped).toHaveLength(4);
    expect(new Set(deduped.map((c) => c.chunk_id)).size).toBe(4);
    expect(deduped[0]!.chunk_id).toBe(shared); // first occurrence: id unchanged
    expect(deduped[1]!.chunk_id).toBe(sha256('f.ts:2#dup:1'));
    expect(deduped[2]!.chunk_id).toBe(sha256('f.ts:2#dup:2'));
    expect(deduped[3]!.chunk_id).toBe(sha256('f.ts:2#dup:3'));
  });

  it('scales to many same-line siblings (mechanism 3: generated/minified single-line files)', () => {
    const shared = chunkId('generated.js', 6);
    const chunks: Chunk[] = Array.from({ length: 20 }, (_, i) =>
      mkChunk({ chunk_id: shared, start_line: 6, file_path: 'generated.js', symbol_name: `g${i}` }),
    );

    const deduped = dedupeChunkIds(chunks);

    expect(deduped).toHaveLength(20);
    expect(new Set(deduped.map((c) => c.chunk_id)).size).toBe(20);
  });

  it('is deterministic: identical input produces identical id sequences across runs', () => {
    const shared = chunkId('f.ts', 2);
    const build = (): Chunk[] => [
      mkChunk({ chunk_id: shared, start_line: 2 }),
      mkChunk({ chunk_id: shared, start_line: 2 }),
      mkChunk({ chunk_id: shared, start_line: 2 }),
    ];
    const run1 = dedupeChunkIds(build()).map((c) => c.chunk_id);
    const run2 = dedupeChunkIds(build()).map((c) => c.chunk_id);
    expect(run1).toEqual(run2);
  });

  it('leaves non-colliding chunks completely unchanged (near-zero churn)', () => {
    const chunks: Chunk[] = [
      mkChunk({ chunk_id: chunkId('f.ts', 1), start_line: 1 }),
      mkChunk({ chunk_id: chunkId('f.ts', 5), start_line: 5 }),
      mkChunk({ chunk_id: chunkId('f.ts', 12), start_line: 12 }),
    ];
    const deduped = dedupeChunkIds(chunks);
    expect(deduped).toEqual(chunks);
  });
});

describe('end-to-end: extractChunks + dedupeChunkIds (real collision, lab3.ts-style)', () => {
  // Mirrors probe-lab/lab3.ts (GITNEXUS_COMPARISON.md §15.3): 4 real methods
  // sharing one physical line collide on chunk_id at the extractor level —
  // `chunkId(filePath, mStart)` uses only the shared start_line.
  const SRC = `export class Dep3 {
  a1(): void {} a2(): void {} a3<T>(): void {} a4<T>(): void {}
}
`;

  it('extractChunks alone still collides — documents the bug this fix addresses', () => {
    const raw = extractChunks(SRC, 'lab3.ts');
    const methodIds = raw.filter((c) => c.chunk_type === 'method').map((c) => c.chunk_id);
    expect(methodIds).toHaveLength(4);
    expect(new Set(methodIds).size).toBe(1);
  });

  it('dedupeChunkIds resolves the collision and preserves all 4 methods under unique ids', () => {
    const raw = extractChunks(SRC, 'lab3.ts');
    const deduped = dedupeChunkIds(raw);

    expect(deduped).toHaveLength(raw.length);
    expect(new Set(deduped.map((c) => c.chunk_id)).size).toBe(deduped.length);

    const methodNames = deduped.filter((c) => c.chunk_type === 'method').map((c) => c.symbol_name);
    expect(methodNames).toEqual(['Dep3.a1', 'Dep3.a2', 'Dep3.a3', 'Dep3.a4']);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — remapIdentifierRows (pure)
// ---------------------------------------------------------------------------
describe('remapIdentifierRows', () => {
  it('re-keys identifier rows to their post-dedup chunk_id, preserving per-chunk correspondence', () => {
    const shared = chunkId('f.ts', 2);
    const original: Chunk[] = [
      mkChunk({ chunk_id: shared, start_line: 2, symbol_name: 'a1' }),
      mkChunk({ chunk_id: shared, start_line: 2, symbol_name: 'a2' }),
    ];
    const deduped = dedupeChunkIds(original);
    const rows: IdentifierRow[] = [
      { chunk_id: shared, identifiers: 'a1' },
      { chunk_id: shared, identifiers: 'a2' },
    ];

    const remapped = remapIdentifierRows(original, deduped, rows);

    expect(remapped).toEqual([
      { chunk_id: deduped[0]!.chunk_id, identifiers: 'a1' },
      { chunk_id: deduped[1]!.chunk_id, identifiers: 'a2' },
    ]);
    expect(remapped[0]!.chunk_id).toBe(shared);
    expect(remapped[1]!.chunk_id).not.toBe(shared);
  });

  it('passes non-colliding rows through untouched', () => {
    const original: Chunk[] = [mkChunk({ chunk_id: chunkId('f.ts', 1), start_line: 1 })];
    const deduped = dedupeChunkIds(original);
    const rows: IdentifierRow[] = [{ chunk_id: original[0]!.chunk_id, identifiers: 'x' }];
    expect(remapIdentifierRows(original, deduped, rows)).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline via extractFile — the real dispatch chokepoint
// ---------------------------------------------------------------------------
describe('extractFile end-to-end', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mast-dup-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function write(name: string, content: string): string {
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  }

  it('directus-style shims.d.ts collapses to 2 unique-id chunks', () => {
    const file = write('shims.d.ts', "declare module '*.md';\ndeclare module '*.yaml';\n");
    const { chunks } = extractFile(file, dir, 0, 100);
    expect(chunks).toHaveLength(2);
    expect(new Set(chunks.map((c) => c.chunk_id)).size).toBe(2);
  });

  it('lab3.ts-style same-line methods all survive with unique ids and matching identifier rows', () => {
    const file = write(
      'lab3.ts',
      `export class Dep3 {
  a1(): void {} a2(): void {} a3<T>(): void {} a4<T>(): void {}
}
`,
    );
    const { chunks, identifierRows } = extractFile(file, dir, 0, 100);

    const methodChunks = chunks.filter((c) => c.chunk_type === 'method');
    expect(methodChunks).toHaveLength(4);
    expect(new Set(methodChunks.map((c) => c.chunk_id)).size).toBe(4);

    // Every identifier row must reference a chunk_id that actually exists in
    // the final chunk list — a stale pre-dedup id would orphan the row.
    const chunkIds = new Set(chunks.map((c) => c.chunk_id));
    expect(identifierRows.length).toBeGreaterThan(0);
    for (const row of identifierRows) {
      expect(chunkIds.has(row.chunk_id)).toBe(true);
    }
  });
});
