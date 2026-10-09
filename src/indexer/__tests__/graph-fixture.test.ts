import { rmSync } from 'node:fs';
import Sqlite from 'better-sqlite3';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configFor,
  expectGraphEqualsFullIndex,
  indexFull,
  makeProject,
  writeFiles,
} from './graph-fixture.js';

// ---------------------------------------------------------------------------
// The comparison every equivalence test rests on has to see each thing mast
// stores for a file. Until D134 it compared edges, star rows and three import
// columns, so a stale export flag (D132) and a leftover row (D133) both passed
// it. Each case plants one difference in a stored index and requires the
// comparison to fail.
// ---------------------------------------------------------------------------

const FILES = {
  'src/lib.ts': 'export function target(): number { return 1; }\nexport function other(): number { return 2; }\n',
  'src/barrel.ts': "export { target as renamed } from './lib';\nexport * from './missing';\n",
  'src/use.ts':
    "import { target as t } from './lib';\nexport function caller(): number {\n  return t();\n}\n",
};

const PLANTED: readonly (readonly [string, string])[] = [
  ['a symbol export flag', "UPDATE symbols SET is_exported = 0 WHERE name = 'target'"],
  ['a symbol line', "UPDATE symbols SET line = line + 7 WHERE name = 'other'"],
  ['a symbol declaration hash', "UPDATE symbols SET declaration_hash = 'x' WHERE name = 'target'"],
  ['a symbol body hash', "UPDATE symbols SET body_hash = 'x' WHERE name = 'target'"],
  ['an import alias', 'UPDATE imports SET aliases = NULL WHERE aliases IS NOT NULL'],
  ['a re-export alias row', 'DELETE FROM reexport_aliases'],
  ['an unresolved star row', 'DELETE FROM star_reexport_unresolved'],
  ['a chunk', "DELETE FROM chunks WHERE symbol_name = 'other'"],
  ['a chunk export flag', "UPDATE chunks SET is_exported = 0 WHERE symbol_name = 'target'"],
  ['the line of a call', 'UPDATE edges SET call_line = call_line + 5 WHERE call_line IS NOT NULL'],
  ['the version a file row was written by', "UPDATE files SET written_by = NULL WHERE path = 'src/use.ts'"],
];

describe('the comparison with a full index sees every stored thing (D134)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = makeProject('graph-fixture');
    writeFiles(dir, FILES);
    await indexFull(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes on an index nothing was done to', async () => {
    await expectGraphEqualsFullIndex(dir);
  });

  it.each(PLANTED)('fails when %s differs', async (_what, statement) => {
    const sqlite = new Sqlite(join(configFor(dir).resolved_state_dir, 'graph.db'));
    const changed = sqlite.prepare(statement).run().changes;
    sqlite.close();
    expect(changed).toBeGreaterThan(0);

    await expect(expectGraphEqualsFullIndex(dir)).rejects.toThrow();
  });
});
