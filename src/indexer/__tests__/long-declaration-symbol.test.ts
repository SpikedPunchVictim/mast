import { rmSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../graph/db.js';
import { configFor, indexFull, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// D097 — a declaration longer than one chunk is still one symbol.
//
// The split rule (MAST_SPEC.md §10.1) cuts a long declaration into overlapping
// sub-chunks for search. The graph must not follow it: §10.3 gives each
// declaration one `symbols` row. With one row per sub-chunk, the edges into
// the function and the edges out of it land on different rows, and a walk
// through the function stops there.
//
// Every other graph fixture is shorter than one chunk, and the shared dump in
// `graph-fixture.ts` prints names, which reads the same for one row or three.
// So this file reads ids.
// ---------------------------------------------------------------------------

/** 250 lines of body: three sub-chunks at the default threshold of 100. */
const FILLER = Array.from({ length: 250 }, (_, i) => `  total += ${String(i)};`).join('\n');

const SRC = `export function leaf(): number { return 1; }

export function long(): number {
  let total = 0;
${FILLER}
  return total + leaf();
}

export function top(): number { return long(); }
`;

interface SymbolRow { readonly id: number; readonly line: number }
interface EdgeRow { readonly from_name: string; readonly from_id: number; readonly to_name: string; readonly to_id: number }

describe('a declaration longer than one chunk (D097)', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = makeProject('long-declaration');
    writeFiles(projectDir, { 'src/a.ts': SRC });
    await indexFull(projectDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  async function read(): Promise<{ symbols: readonly SymbolRow[]; edges: readonly EdgeRow[] }> {
    const db = openDatabase(configFor(projectDir).resolved_state_dir);
    try {
      const symbols = (
        await sql<SymbolRow>`SELECT id, line FROM symbols WHERE name = 'long' ORDER BY line`.execute(db)
      ).rows;
      const edges = (
        await sql<EdgeRow>`
          SELECT fs.name AS from_name, e.from_id, ts.name AS to_name, e.to_id
          FROM edges e
          JOIN symbols fs ON fs.id = e.from_id
          JOIN symbols ts ON ts.id = e.to_id
          WHERE e.edge_type = 'POTENTIAL_CALL'`.execute(db)
      ).rows;
      return { symbols, edges };
    } finally {
      await db.destroy();
    }
  }

  it('has one symbols row, on the line of the declaration', async () => {
    const { symbols } = await read();

    expect(symbols.map((s) => s.line)).toEqual([3]);
  });

  it('holds its incoming and its outgoing call edge on the same row', async () => {
    const { edges } = await read();

    const incoming = edges.find((e) => e.from_name === 'top' && e.to_name === 'long');
    const outgoing = edges.find((e) => e.from_name === 'long' && e.to_name === 'leaf');
    expect(incoming).toBeDefined();
    expect(outgoing).toBeDefined();
    expect(outgoing?.from_id).toBe(incoming?.to_id);
  });
});
