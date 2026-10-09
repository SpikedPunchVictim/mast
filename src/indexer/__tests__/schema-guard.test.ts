import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { openDatabase } from '../../graph/db.js';
import { CURRENT_SCHEMA_VERSION } from '../../store/config.js';
import { withLock } from '../../store/lock.js';
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
  it('keeps the metrics rows of the index it rebuilds (D126)', async () => {
    // A handle of its own before and after: one held across the run would go on
    // reading a deleted file and count the row either way.
    const graphPath = join(configFor(dir).resolved_state_dir, 'graph.db');
    const before = new Sqlite(graphPath);
    before.exec(
      "INSERT INTO metrics (tool_name, call_timestamp, tokens_returned, tokens_full_file_upper_bound, duration_ms, session_id, status) VALUES ('mast_search', 1, 1, 1, 1, 's', 'ok')",
    );
    before.close();
    stampWith('0.0.1');

    await runIndex(configFor(dir), { incremental: true });

    const after = new Sqlite(graphPath);
    const rows = after.prepare('SELECT count(*) AS c FROM metrics').get();
    after.close();
    expect(rows).toEqual({ c: 1 });
  });

  it('is read by a database handle that was open before it ran (D125)', async () => {
    const heldOpen = openDatabase(configFor(dir).resolved_state_dir);
    stampWith('0.0.1');
    writeFiles(dir, { 'src/c.ts': `export function added(): number { return 3; }\n` });

    await runIndex(configFor(dir), { incremental: true });

    const paths = (await heldOpen.selectFrom('files').select('path').execute()).map((f) => f.path).sort();
    await heldOpen.destroy();
    expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('removes nothing when it cannot take the structure lock (D127)', async () => {
    const stateDir = configFor(dir).resolved_state_dir;
    stampWith('0.0.1');
    let release: () => void = () => undefined;
    const held = withLock(stateDir, 'structure', { maxRetries: 0, retryIntervalMs: 10, caller: 'test' }, () =>
      new Promise<void>((resolve) => { release = resolve; }),
    );

    await expect(runIndex(configFor(dir), { incremental: true })).rejects.toThrow();

    release();
    await held;
    const db = openDatabase(stateDir);
    const files = await db.selectFrom('files').select('path').execute();
    await db.destroy();
    expect(files).toHaveLength(2);
  }, 20_000);
});
