import { mkdtempSync, writeFileSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../config.js';
import { extractFile } from '../../ast/extract.js';
import { LanceStore } from '../lance.js';

// M1 (eval/GITNEXUS_COMPARISON.md §15.1) moved chunks off Lance for the
// default (production) path — `runIndex` no longer touches chunks.lance at
// all, so these tests populate it directly via `LanceStore`'s own chunk API
// instead of relying on `runIndex` as a side-effecting shortcut. What is
// under test here — `LanceStore.open`'s fragment-corruption recovery — is
// orthogonal to which store `runIndex` chooses for chunks by default; Lance
// keeps this API for M2 to decide (store/lance.ts is untouched by M1).
describe('LanceStore.open — corruption recovery', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mast-lance-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('recovers when chunks.lance data fragments are missing from disk', async () => {
    const fixture = join(dir, 'a.ts');
    writeFileSync(fixture, 'export function add(a: number, b: number): number { return a + b; }\n');
    const config = resolveConfig({ projectRoot: dir });

    // Populate the lance chunks table directly (LanceStore's own API — not
    // the default chunk-store path any more).
    const result = extractFile(fixture, dir, 0, 100);
    const seedStore = await LanceStore.open(config.resolved_state_dir);
    await seedStore.ensureChunksTable();
    await seedStore.replaceChunksForFile('a.ts', result.chunks);
    expect(await seedStore.chunkCount()).toBeGreaterThan(0);

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
    const fixture = join(dir, 'b.ts');
    writeFileSync(fixture, 'export const x = 1;\n');
    const config = resolveConfig({ projectRoot: dir });

    const result = extractFile(fixture, dir, 0, 100);
    const seedStore = await LanceStore.open(config.resolved_state_dir);
    await seedStore.ensureChunksTable();
    await seedStore.replaceChunksForFile('b.ts', result.chunks);

    const before = await (await LanceStore.open(config.resolved_state_dir)).chunkCount();
    expect(before).toBeGreaterThan(0);

    // A second open on a healthy table must preserve the existing chunks.
    const store = await LanceStore.open(config.resolved_state_dir);
    expect(await store.chunkCount()).toBe(before);
  });
});
