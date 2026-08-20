// A file that fails to index must be retried on the next run.
//
// The finalise phase stamps `file_manifest.json` from a fresh re-stat of every
// file the walk returned — written or not. A file whose parse threw, or whose
// write failed, therefore got a manifest entry recording the mtime of content
// that never reached the index, and `diffManifest` saw it as up to date from
// then on. One transient failure removed a file from the index permanently.
//
// The trace also disappeared: `parse_errors` is written to index.json as
// `parseErrors > 0 ? parseErrors : undefined`, so the next clean run — clean
// only because it never looked at the file again — dropped the field entirely
// and both status surfaces reported the index fresh with zero errors.
//
// Existing coverage stopped one step short. `write-failures.test.ts` and
// `status-write-errors.test.ts` both inject a failure and assert on the
// counters *that run* produces. Neither runs a second time, which is where the
// defect lives.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex, loadIndexMeta } from '../index.js';
import { openDatabase } from '../../graph/db.js';
import { extractFile } from '../../ast/extract.js';
import type { ChunkStore, ChunkRecord } from '../../store/sqliteChunkStore.js';

let dir: string;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

/** `{ relativePath → mtime }` as persisted by the last run. */
function readManifest(stateDir: string): Record<string, number> {
  return JSON.parse(
    readFileSync(join(stateDir, 'file_manifest.json'), 'utf-8'),
  ) as Record<string, number>;
}

/** Paths present in the `files` table — what is actually indexed. */
async function indexedPaths(stateDir: string): Promise<string[]> {
  const db = openDatabase(stateDir);
  try {
    const rows = await db.selectFrom('files').select('path').execute();
    return rows.map((r) => r.path).sort();
  } finally {
    await db.destroy();
  }
}

/** A corpus of one healthy file and one that can be made to fail on demand. */
function seedCorpus(): { config: ReturnType<typeof resolveConfig> } {
  dir = mkdtempSync(join(tmpdir(), 'mast-failed-retry-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'good.ts'), 'export function good(): number { return 1; }\n');
  writeFileSync(join(dir, 'src', 'doomed.ts'), 'export function doomed(): number { return 2; }\n');
  return { config: resolveConfig({ projectRoot: dir }) };
}

describe('a file whose parse fails', () => {
  it('is left out of the manifest, so the next run retries it', async () => {
    const { config } = seedCorpus();

    let failing = true;
    const flakyExtract: typeof extractFile = (path, ...rest) => {
      if (failing && path.endsWith('doomed.ts')) throw new Error('simulated transient extract failure');
      return extractFile(path, ...rest);
    };

    const first = await runIndex(config, { incremental: false, extractFileFn: flakyExtract });
    expect(first.parseErrors).toBe(1);
    expect(await indexedPaths(config.resolved_state_dir)).toEqual(['src/good.ts']);

    // The failure is what must not be recorded as success.
    expect(Object.keys(readManifest(config.resolved_state_dir))).toEqual(['src/good.ts']);

    // The transient condition clears; nothing on disk changed.
    failing = false;
    const second = await runIndex(config, { incremental: true });

    expect(second.parseErrors).toBe(0);
    expect(second.filesIndexed).toBe(1);
    expect(await indexedPaths(config.resolved_state_dir)).toEqual(['src/doomed.ts', 'src/good.ts']);
    expect(Object.keys(readManifest(config.resolved_state_dir)).sort())
      .toEqual(['src/doomed.ts', 'src/good.ts']);
  });

  it('keeps reporting the error for as long as it keeps failing', async () => {
    const { config } = seedCorpus();
    const alwaysFails: typeof extractFile = (path, ...rest) => {
      if (path.endsWith('doomed.ts')) throw new Error('simulated permanent extract failure');
      return extractFile(path, ...rest);
    };

    await runIndex(config, { incremental: false, extractFileFn: alwaysFails });
    // The second run is the one that used to report a clean index, because it
    // never looked at the file again.
    const second = await runIndex(config, { incremental: true, extractFileFn: alwaysFails });

    expect(second.parseErrors).toBe(1);
    expect(loadIndexMeta(config.resolved_state_dir)?.parse_errors).toBe(1);
  });
});

describe('a file whose write fails', () => {
  it('is left out of the manifest too — the same hole, one phase later', async () => {
    const { config } = seedCorpus();

    // `populateFile` is what a write failure surfaces through, so failing the
    // extract is not a substitute: this asserts the manifest is built from
    // what was WRITTEN, not from what was parsed.
    let failing = true;
    class SelectivelyFailingChunkStore implements ChunkStore {
      async replaceChunksForFile(filePath: string): Promise<number> {
        if (failing && filePath.endsWith('doomed.ts')) throw new Error('simulated write failure');
        return 0;
      }
      async deleteChunksForFiles(): Promise<number> { return 0; }
      async getChunksByFilePath(): Promise<ChunkRecord[]> { return []; }
      async getChunksByIds(): Promise<ChunkRecord[]> { return []; }
      async getAllChunks(): Promise<ChunkRecord[]> { return []; }
      async chunkCount(): Promise<number> { return 0; }
    }

    const first = await runIndex(config, {
      incremental: false,
      chunkStoreOverride: new SelectivelyFailingChunkStore(),
    });
    expect(first.writeErrors).toBe(1);
    expect(Object.keys(readManifest(config.resolved_state_dir))).toEqual(['src/good.ts']);

    failing = false;
    const second = await runIndex(config, { incremental: true });
    expect(second.filesIndexed).toBe(1);
    expect(Object.keys(readManifest(config.resolved_state_dir)).sort())
      .toEqual(['src/doomed.ts', 'src/good.ts']);
  });
});

describe('a hole left by an index written before this fix', () => {
  it('is reindexed by an ordinary incremental run, without a full reindex', async () => {
    const { config } = seedCorpus();
    await runIndex(config, { incremental: false });

    // Reproduce the pre-fix state exactly: the manifest records the file as up
    // to date while the index holds nothing for it. Before D034 was fixed this
    // is what one failed parse left behind, and the manifest diff would have
    // reported the file unchanged forever.
    const db = openDatabase(config.resolved_state_dir);
    try {
      await db.deleteFrom('files').where('path', '=', 'src/doomed.ts').execute();
    } finally {
      await db.destroy();
    }
    expect(Object.keys(readManifest(config.resolved_state_dir)).sort())
      .toEqual(['src/doomed.ts', 'src/good.ts']);
    expect(await indexedPaths(config.resolved_state_dir)).toEqual(['src/good.ts']);

    const healed = await runIndex(config, { incremental: true });

    expect(healed.filesIndexed).toBe(1);
    expect(await indexedPaths(config.resolved_state_dir)).toEqual(['src/doomed.ts', 'src/good.ts']);
  });
});
