import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatus } from '../status.js';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mast-status-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
  return dir;
}

/**
 * M6's defect (ADR 008) was `mast serve` answering meaningfully against a state
 * directory that had never been indexed. The same shape survived in `mast status`:
 * pointed at a path with no index it printed a full health table — an invented
 * schema version, a stale-file count, `freshness_cause: phase1_stale` — and exited 0.
 *
 * That is the difference between "your index is stale, reindex it" and "there is no
 * index here, you are looking in the wrong place", and it costs most in exactly the
 * case that produces it: someone who indexed to `--state-dir ./elsewhere` and then
 * ran a command without the flag.
 */
describe('mast status on a directory that was never indexed', () => {
  it('says the index is absent, not stale', async () => {
    const s = await buildStatus({ path: project() });
    expect(s.initialised).toBe(false);
    expect(s.freshness_cause).toBe('not_initialised');
  });

  it('does not report a stale-file count for an index that does not exist', async () => {
    const s = await buildStatus({ path: project() });
    expect(s.stale_files).toBeNull();
  });

  it('tells the caller where it looked, so a wrong --state-dir is visible', async () => {
    const dir = project();
    const s = await buildStatus({ path: dir });
    expect(s.state_dir).toContain(dir);
  });

  it('is not fresh', async () => {
    expect((await buildStatus({ path: project() })).index_fresh).toBe(false);
  });
});

describe('mast status on an initialised index', () => {
  it('reports initialised and a real stale count', async () => {
    const dir = project();
    mkdirSync(join(dir, '.mast'), { recursive: true });
    writeFileSync(join(dir, '.mast', 'index.json'), JSON.stringify({
      schema_version: '1.3.0', last_indexed: new Date().toISOString(),
      file_count: 1, chunk_count: 1,
    }));
    const s = await buildStatus({ path: dir });
    expect(s.initialised).toBe(true);
    expect(s.freshness_cause).not.toBe('not_initialised');
    expect(typeof s.stale_files).toBe('number');
  });
});

/**
 * D048/D049. The guard above catches "there is no index here". It does not catch
 * the neighbouring case: an index that exists, is perfectly fresh, and describes a
 * *different tree* than the one being asked about — which is what
 * `--state-dir`-resolves-against-the-path-argument makes easy to produce.
 *
 * Measured on a real consumer index before the fix: pointed at the root it was
 * built for, `{stale:0, unindexed:0, deleted:0}`; pointed one directory down,
 * `{stale:1, unindexed:1569, deleted:1821}` reported as `stale_files: 3391` with
 * `freshness_cause: phase1_stale` — a cause accounting for 1 of the 3391.
 */
describe('mast status pointed at a project root the index was not built for', () => {
  async function indexedElsewhere(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'mast-status-root-'));
    mkdirSync(join(dir, 'typescript', 'src'), { recursive: true });
    writeFileSync(join(dir, 'typescript', 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
    writeFileSync(join(dir, 'typescript', 'src', 'b.ts'), 'export function beta(): number { return 2; }\n');
    // Indexed with the SUBDIRECTORY as project root, so every stored path is
    // relative to it — exactly what the consumer repo had on disk.
    const config = resolveConfig({ projectRoot: join(dir, 'typescript'), stateDirOverride: '.mast' });
    await runIndex(config, { incremental: false });
    return dir;
  }

  it('names the mismatch instead of blaming stale content', async () => {
    const dir = await indexedElsewhere();
    const s = await buildStatus({ path: dir, stateDir: 'typescript/.mast' });

    expect(s.freshness_cause).toBe('root_mismatch');
  });

  it('reports the breakdown, so the count can be read rather than guessed at', async () => {
    const dir = await indexedElsewhere();
    const s = await buildStatus({ path: dir, stateDir: 'typescript/.mast' });

    // Nothing on disk here is known to the index, and the index knows two files
    // that are not here — the signature of an index built for another root.
    expect(s.stale_breakdown).toEqual({ changed: 0, unindexed: 2, deleted: 2 });
    expect(s.stale_files).toBe(4);
  });

  it('still reports a plain stale count when the root is right', async () => {
    const dir = await indexedElsewhere();
    const s = await buildStatus({ path: join(dir, 'typescript'), stateDir: '.mast' });

    expect(s.freshness_cause).toBeNull();
    expect(s.stale_breakdown).toEqual({ changed: 0, unindexed: 0, deleted: 0 });
    expect(s.index_fresh).toBe(true);
  });
});
