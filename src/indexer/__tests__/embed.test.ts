import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { runEmbed } from '../../indexer/index.js';
import { LanceStore } from '../../store/lance.js';
import { searchVectors } from '../../search/vector.js';
import { JINA_V2_DIM, type EmbedderLike } from '../../indexer/embedder.js';
import type { Chunk, VectorEntry } from '../../ast/types.js';

// ---------------------------------------------------------------------------
// Fixture sources
// ---------------------------------------------------------------------------

const UTILS_SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`;

const TYPES_SRC = `export interface Shape {
  area(): number;
}

export type Color = 'red' | 'green' | 'blue';
`;

// ---------------------------------------------------------------------------
// Fake embedder — produces deterministic unit vectors without loading ONNX
// ---------------------------------------------------------------------------

function makeFakeEmbedder(): EmbedderLike & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async load() {},
    async embed(chunks: readonly Chunk[]): Promise<VectorEntry[]> {
      callCount += chunks.length;
      // Each chunk gets a unit vector with a unique first component so that
      // cosine similarity produces meaningful rankings in search tests.
      return chunks.map((c, i) => ({
        chunk_id: c.chunk_id,
        embedding: Array.from({ length: JINA_V2_DIM }, (_, dim) => dim === i % JINA_V2_DIM ? 1 : 0),
        model_version: 'fake-1.0',
      }));
    },
    get dimension() { return JINA_V2_DIM; },
  };
}

// ---------------------------------------------------------------------------
// runEmbed — orchestration
// ---------------------------------------------------------------------------

describe('runEmbed', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-embed-test-'));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_SRC);
    writeFileSync(join(tmpDir, 'types.ts'), TYPES_SRC);
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('embeds all chunks produced by Phase 1', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const embedder = makeFakeEmbedder();

    const result = await runEmbed(config, { embedder });

    expect(result.chunksEmbedded).toBeGreaterThan(0);
    expect(result.chunksSkipped).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('stores vectors in LanceDB', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const lance = await LanceStore.open(config.resolved_state_dir);
    const ids = await lance.getEmbeddedChunkIds();
    expect(ids.size).toBeGreaterThan(0);
  });

  it('skips already-embedded chunks on a second run', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const embedder = makeFakeEmbedder();

    const result = await runEmbed(config, { embedder });

    expect(result.chunksEmbedded).toBe(0);
    expect(result.chunksSkipped).toBeGreaterThan(0);
    expect(embedder.callCount).toBe(0);
  });

  it('fires onProgress callbacks once per batch', async () => {
    // Fresh state dir so all chunks are pending.
    const freshDir = mkdtempSync(join(tmpdir(), 'mast-embed-progress-'));
    try {
      writeFileSync(join(freshDir, 'utils.ts'), UTILS_SRC);
      const config = resolveConfig({ projectRoot: freshDir });
      await runIndex(config, { incremental: false });

      const progressCalls: Array<{ embedded: number; total: number }> = [];
      await runEmbed(config, {
        embedder: makeFakeEmbedder(),
        batchSize: 1,
        onProgress: (embedded, total) => progressCalls.push({ embedded, total }),
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      // Progress is monotonically increasing.
      for (let i = 1; i < progressCalls.length; i++) {
        expect(progressCalls[i]!.embedded).toBeGreaterThan(progressCalls[i - 1]!.embedded);
      }
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('removes orphaned vectors whose chunks were deleted', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'mast-embed-orphan-'));
    try {
      writeFileSync(join(freshDir, 'utils.ts'), UTILS_SRC);
      writeFileSync(join(freshDir, 'types.ts'), TYPES_SRC);
      const config = resolveConfig({ projectRoot: freshDir });

      await runIndex(config, { incremental: false });
      await runEmbed(config, { embedder: makeFakeEmbedder() });

      // Delete types.ts and reindex so its chunks disappear from LanceDB.
      rmSync(join(freshDir, 'types.ts'));
      await runIndex(config, { incremental: true });

      // Run embed again — should remove orphaned vectors for types.ts chunks.
      const result = await runEmbed(config, { embedder: makeFakeEmbedder() });

      const lance = await LanceStore.open(config.resolved_state_dir);
      const allChunks = await lance.getAllChunks();
      const embeddedIds = await lance.getEmbeddedChunkIds();

      // Every embedded ID must correspond to a live chunk.
      const liveIds = new Set(allChunks.map((c) => c.chunk_id));
      for (const id of embeddedIds) {
        expect(liveIds.has(id)).toBe(true);
      }

      // No new chunks were embedded (utils.ts was already done).
      expect(result.chunksEmbedded).toBe(0);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Vector search after embedding
// ---------------------------------------------------------------------------

describe('vector search after embedding', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-vector-search-'));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_SRC);
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    await runEmbed(config, { embedder: makeFakeEmbedder() });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ranked hits after embedding', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const lance = await LanceStore.open(config.resolved_state_dir);
    const queryVector = Array.from({ length: JINA_V2_DIM }, (_, i) => i === 0 ? 1 : 0);

    const hits = await searchVectors(lance, queryVector, 5);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ chunkId: expect.any(String), score: expect.any(Number) });
  });

  it('reports true cosine similarity (identical → 1, orthogonal → 0)', async () => {
    // The fake embedder assigns each chunk a distinct unit basis vector, so a
    // query equal to one chunk's vector is identical to it (cosine 1) and
    // orthogonal to the others (cosine 0 — not 0.5, which the old `1 - d/2`
    // rescale produced).
    const config = resolveConfig({ projectRoot: tmpDir });
    const lance = await LanceStore.open(config.resolved_state_dir);
    const queryVector = Array.from({ length: JINA_V2_DIM }, (_, i) => (i === 0 ? 1 : 0));

    const hits = await searchVectors(lance, queryVector, 10);

    expect(Math.max(...hits.map((h) => h.score))).toBeCloseTo(1, 5);
    expect(Math.min(...hits.map((h) => h.score))).toBeCloseTo(0, 5);
  });

  it('returns empty array when vectors table has no rows', async () => {
    // Fresh store with no Phase 2 run.
    const freshDir = mkdtempSync(join(tmpdir(), 'mast-no-vectors-'));
    try {
      writeFileSync(join(freshDir, 'utils.ts'), UTILS_SRC);
      const config = resolveConfig({ projectRoot: freshDir });
      await runIndex(config, { incremental: false });

      const lance = await LanceStore.open(config.resolved_state_dir);
      const queryVector = Array.from({ length: JINA_V2_DIM }, () => 0.1);
      const hits = await searchVectors(lance, queryVector, 5);

      expect(hits).toHaveLength(0);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Embedder — pre-load guard
// ---------------------------------------------------------------------------

describe('Embedder', () => {
  it('throws when embed() is called before load()', async () => {
    const { Embedder } = await import('../../indexer/embedder.js');
    const embedder = new Embedder('test-model', '/tmp', '/tmp');
    await expect(embedder.embed([])).rejects.toThrow('Call load() before embed()');
  });
});
