import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatus } from '../status.js';

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
