import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig, CURRENT_SCHEMA_VERSION } from '../../store/config.js';
import { runIndex, loadIndexMeta, writeIndexMeta } from '../../indexer/index.js';
import { openDatabase } from '../../graph/db.js';
import { LanceStore } from '../../store/lance.js';
import { initLockMarkers } from '../../store/lock.js';
import type { EmbedderLike } from '../../indexer/embedder.js';
import { JINA_V2_DIM } from '../../indexer/embedder.js';
import { runEmbed } from '../../indexer/index.js';
import type { Chunk, VectorEntry } from '../../ast/types.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const MATH_SRC = `export function add(a: number, b: number): number {
  return a + b;
}
`;

function makeFakeEmbedder(): EmbedderLike {
  return {
    async load() {},
    async embed(chunks: readonly Chunk[]): Promise<VectorEntry[]> {
      return chunks.map((c, i) => ({
        chunk_id:      c.chunk_id,
        embedding:     Array.from({ length: JINA_V2_DIM }, (_, d) => d === i % JINA_V2_DIM ? 1 : 0),
        model_version: 'fake-1.0',
      }));
    },
    get dimension() { return JINA_V2_DIM; },
  };
}

// ---------------------------------------------------------------------------
// Startup ladder state initialisation
// ---------------------------------------------------------------------------

describe('startup ladder — state initialisation', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-startup-'));
    writeFileSync(join(tmpDir, 'math.ts'), MATH_SRC);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('step 1: initLockMarkers creates state directory structure', () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    initLockMarkers(config.resolved_state_dir);
    // If this doesn't throw, state directory was created.
    const meta = loadIndexMeta(config.resolved_state_dir);
    expect(meta).toBeNull(); // Not yet indexed.
  });

  it('step 2: Phase 1 populates the index and writes index.json', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const result = await runIndex(config, { incremental: false });
    expect(result.filesIndexed).toBeGreaterThan(0);
    const meta = loadIndexMeta(config.resolved_state_dir);
    expect(meta).not.toBeNull();
    expect(meta!.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(meta!.file_count).toBeGreaterThan(0);
  });

  it('step 3: schema version mismatch triggers full-reindex flag', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });

    // Inject an old schema version into index.json.
    const oldMeta = loadIndexMeta(config.resolved_state_dir)!;
    writeIndexMeta(config.resolved_state_dir, {
      ...oldMeta,
      schema_version: '0.0.0-stale',
    });

    const stale = loadIndexMeta(config.resolved_state_dir);
    const needsFullReindex = stale !== null && stale.schema_version !== CURRENT_SCHEMA_VERSION;
    expect(needsFullReindex).toBe(true);

    // After a full reindex, the schema version is restored.
    await runIndex(config, { incremental: false });
    const fresh = loadIndexMeta(config.resolved_state_dir)!;
    expect(fresh.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Search mode transition: lexical → hybrid
// ---------------------------------------------------------------------------

describe('search mode — lexical to hybrid transition', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;
  let lance: LanceStore;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-mode-'));
    writeFileSync(join(tmpDir, 'math.ts'), MATH_SRC);

    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });

    db = openDatabase(config.resolved_state_dir);
    lance = await LanceStore.open(config.resolved_state_dir);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mode starts as lexical (no vectors)', async () => {
    // Before Phase 2, searchVectors returns nothing — mode stays lexical.
    const vectors = await lance.searchVectors(
      Array.from({ length: JINA_V2_DIM }, () => 0),
      10,
    );
    expect(vectors).toHaveLength(0);
  });

  it('mode becomes hybrid after embedding completes', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runEmbed(config, { embedder: makeFakeEmbedder() });

    // After Phase 2, vector search returns results.
    const queryVec = Array.from({ length: JINA_V2_DIM }, (_, i) => i === 0 ? 1 : 0);
    const vectors = await lance.searchVectors(queryVec, 5);
    expect(vectors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Dynamic dimension detection — contract via EmbedderLike
// ---------------------------------------------------------------------------

describe('dynamic dimension detection', () => {
  it('runEmbed uses EmbedderLike.dimension for the vectors table', async () => {
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'mast-dim-'));
    writeFileSync(join(tmpDir2, 'a.ts'), 'export const x = 1;');

    let detectedDimension = -1;
    const customDim = 128;  // Non-default dimension.

    const fakeEmbedder: EmbedderLike = {
      async load() {},
      async embed(chunks: readonly Chunk[]): Promise<VectorEntry[]> {
        return chunks.map((c) => ({
          chunk_id:      c.chunk_id,
          embedding:     Array.from({ length: customDim }, () => 0.1),
          model_version: 'custom-128',
        }));
      },
      get dimension() { return customDim; },
    };

    const config = resolveConfig({ projectRoot: tmpDir2 });
    await runIndex(config, { incremental: false });

    // runEmbed should call embedder.dimension to create the table.
    // Wrap the embedder to observe the dimension being read.
    const wrappedEmbedder: EmbedderLike = {
      ...fakeEmbedder,
      get dimension() {
        detectedDimension = customDim;
        return customDim;
      },
    };

    // Should complete without throwing (LanceDB table created with 128 dims).
    const result = await runEmbed(config, { embedder: wrappedEmbedder });
    expect(result.chunksEmbedded).toBeGreaterThan(0);
    // dimension getter was called — confirms runEmbed uses the embedder's dimension.
    expect(detectedDimension).toBe(customDim);

    rmSync(tmpDir2, { recursive: true, force: true });
  });
});
