import { mkdtempSync, writeFileSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../config.js';
import { runIndex } from '../../indexer/index.js';
import { LanceStore } from '../lance.js';

describe('LanceStore.open — corruption recovery', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mast-lance-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('recovers when chunks.lance data fragments are missing from disk', async () => {
    writeFileSync(
      join(dir, 'a.ts'),
      'export function add(a: number, b: number): number { return a + b; }\n',
    );
    const config = resolveConfig({ projectRoot: dir });

    // Populate the lance table with real chunks.
    const initial = await runIndex(config, { incremental: false });
    expect(initial.chunksAdded).toBeGreaterThan(0);

    // Simulate the corruption: delete all .lance data fragment files while
    // leaving the _versions/ manifests intact. This reproduces the scenario
    // where the data/ directory is externally wiped (e.g. a partial cleanup or
    // rm -rf on only the data sub-directory).
    const dataDir = join(config.resolved_state_dir, 'lance', 'chunks.lance', 'data');
    for (const f of readdirSync(dataDir).filter((n) => n.endsWith('.lance'))) {
      unlinkSync(join(dataDir, f));
    }

    // LanceStore.open must not throw. It detects the missing fragments via a
    // countRows() probe, wipes the entire lance directory, and reconnects.
    const store = await LanceStore.open(config.resolved_state_dir);

    // After recovery the table doesn't exist yet — ensureChunksTable creates it.
    await store.ensureChunksTable();
    expect(await store.chunkCount()).toBe(0);
  });

  it('does not wipe the lance directory when the table is healthy', async () => {
    writeFileSync(join(dir, 'b.ts'), 'export const x = 1;\n');
    const config = resolveConfig({ projectRoot: dir });

    await runIndex(config, { incremental: false });

    const before = await (await LanceStore.open(config.resolved_state_dir)).chunkCount();
    expect(before).toBeGreaterThan(0);

    // A second open on a healthy table must preserve the existing chunks.
    const store = await LanceStore.open(config.resolved_state_dir);
    expect(await store.chunkCount()).toBe(before);
  });
});
