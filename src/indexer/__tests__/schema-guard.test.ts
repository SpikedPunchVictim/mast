import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '../../store/config.js';
import { loadIndexMeta, runIndex } from '../index.js';
import { configFor, expectStoredEdges, indexFull, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// D113. An index stamped with another schema version is one this binary did
// not build. `mast serve` rebuilds it at startup; the indexer has to as well,
// because an incremental run from a git hook is often the first thing to touch
// the index after an upgrade, and it writes the stamp.
// ---------------------------------------------------------------------------
describe('an index run over an index of another schema version', () => {
  let dir: string;

  const EDGES = ['POTENTIAL_CALL src/b.ts:use -> src/a.ts:fn'];

  function stampWith(version: string): void {
    const path = join(configFor(dir).resolved_state_dir, 'index.json');
    const meta = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...meta, schema_version: version }));
  }

  beforeEach(async () => {
    dir = makeProject('schema-guard');
    writeFiles(dir, {
      'src/a.ts': `export function fn(): number { return 1; }\n`,
      'src/b.ts': `import { fn } from './a.js';\nexport function use(): number { return fn(); }\n`,
    });
    await indexFull(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes every file again when the run is incremental', async () => {
    stampWith('0.0.1');

    const result = await runIndex(configFor(dir), { incremental: true });

    expect(result.filesIndexed).toBe(2);
    await expectStoredEdges(dir, EDGES);
  });

  it('skips unchanged files when the version is the one it writes', async () => {
    const result = await runIndex(configFor(dir), { incremental: true });

    expect(result.filesIndexed).toBe(0);
    expect(loadIndexMeta(configFor(dir).resolved_state_dir)?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('removes the graph the old version built before a full run', async () => {
    stampWith('0.0.1');
    writeFileSync(join(configFor(dir).resolved_state_dir, 'embed_cache'), 'left by an old version');

    await runIndex(configFor(dir), { incremental: false });

    expect(() => readFileSync(join(configFor(dir).resolved_state_dir, 'embed_cache'))).toThrow();
    await expectStoredEdges(dir, EDGES);
  });
});
