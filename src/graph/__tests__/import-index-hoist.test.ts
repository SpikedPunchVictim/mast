import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { insertEdges } from '../populate.js';
import type { EdgeRecord } from '../../ast/types.js';

/**
 * `importResolvedPathFor` used to run one `imports` SELECT per unique call target,
 * even though its `file_id` argument is loop-invariant across the whole per-file
 * resolution loop (`populate.ts` — `callEdgesByToName`). Measured on the retained
 * T8 corpus that was 3,203 queries and 41,650 JSON.parse calls where 1,043 and
 * 8,962 would do.
 *
 * These tests pin the two properties that fix has to have: the query count
 * collapses to one per file, and resolution behaviour is unchanged.
 */

let dir: string;
let db: Db;

/**
 * Counts `selectFrom('imports')` without altering behaviour.
 *
 * Methods are re-bound to the target rather than left to receive the proxy as
 * `this`: Kysely reaches its own private fields, and private-field access
 * through a proxy throws.
 *
 * mast-assertion-rule-allow: reflecting over a third-party object whose method
 * shapes are genuinely not known to this test — the `unknown`s are the point,
 * not laziness about a response shape.
 */
function countingDb(inner: Db): { db: Db; count: () => number } {
  let n = 0;
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      // `never[]`, not `readonly never[]`: under `strictBindCallApply`, TS's
      // `bind` overload requires the rest parameter to be a mutable tuple
      // (`A extends any[]`). A readonly rest matches no overload, so `bound`
      // degrades to a `this: void` signature and every call site fails
      // TS2684 — visible only under `tsc -p tsconfig.test.json`.
      const bound = (value as (this: Db, ...args: never[]) => unknown).bind(target);
      if (prop !== 'selectFrom') return bound;
      return (table: string) => {
        if (table === 'imports') n++;
        return bound(table as never);
      };
    },
  }) as Db;
  return { db: proxy, count: () => n };
}

async function seed(): Promise<void> {
  await db.insertInto('files').values([
    { id: 1, path: '/w/caller.ts', language: 'typescript', mtime: 1 },
    { id: 2, path: '/w/target.ts', language: 'typescript', mtime: 1 },
  ]).execute();

  // One caller symbol, and three distinct call targets in the imported file.
  await db.insertInto('symbols').values([
    { id: 10, name: 'callerFn', kind: 'function', file_id: 1, line: 1, is_exported: 1 },
    { id: 20, name: 'alpha', kind: 'function', file_id: 2, line: 1, is_exported: 1 },
    { id: 21, name: 'beta', kind: 'function', file_id: 2, line: 2, is_exported: 1 },
    { id: 22, name: 'gamma', kind: 'function', file_id: 2, line: 3, is_exported: 1 },
  ]).execute();

  // Three separate import rows, so a per-call scan has real rows to re-parse.
  await db.insertInto('imports').values([
    { file_id: 1, module: './target', symbols: JSON.stringify(['alpha']), is_external: 0, resolved_path: '/w/target.ts' },
    { file_id: 1, module: './target', symbols: JSON.stringify(['beta']), is_external: 0, resolved_path: '/w/target.ts' },
    { file_id: 1, module: './target', symbols: JSON.stringify(['gamma']), is_external: 0, resolved_path: '/w/target.ts' },
  ]).execute();
}

const callEdge = (toName: string): EdgeRecord => ({
  fromName: 'callerFn',
  toName,
  edgeType: 'POTENTIAL_CALL',
  resolution: 'import',
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mast-import-index-'));
  db = openDatabase(dir);
  await seed();
});

afterEach(async () => {
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe('per-file import index', () => {
  it('issues exactly one imports query per file regardless of how many call targets resolve', async () => {
    const { db: counted, count } = countingDb(db);

    await insertEdges(counted, '/w/caller.ts', [callEdge('alpha'), callEdge('beta'), callEdge('gamma')]);

    expect(count()).toBe(1);
  });

  it('resolves every imported call target to its declaring symbol', async () => {
    await insertEdges(db, '/w/caller.ts', [callEdge('alpha'), callEdge('beta'), callEdge('gamma')]);

    const rows = await db.selectFrom('edges').select(['to_id']).where('edge_type', '=', 'POTENTIAL_CALL').execute();

    expect(rows.map((r) => r.to_id).sort((a, b) => a - b)).toEqual([20, 21, 22]);
  });

  it('emits no edge for a name this file does not import', async () => {
    await insertEdges(db, '/w/caller.ts', [callEdge('notImported')]);

    const rows = await db.selectFrom('edges').select(['to_id']).execute();

    expect(rows).toHaveLength(0);
  });
});
