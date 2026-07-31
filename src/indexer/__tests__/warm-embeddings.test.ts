import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex, runEmbed } from '../../indexer/index.js';
import { LanceStore } from '../../store/lance.js';
import { openDatabase } from '../../graph/db.js';
import { SqliteChunkStore } from '../../store/sqliteChunkStore.js';
import { JINA_V2_DIM, type EmbedderLike } from '../../indexer/embedder.js';
import {
  warmEmbeddings,
  embedChunks,
  type EmbedderChildHandle,
  type ChildMessage,
  type EmbedRequest,
} from '../../indexer/background-embedder.js';
import type { Chunk, VectorEntry } from '../../ast/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`;

function makeFakeEmbedder(): EmbedderLike {
  return {
    async load() {},
    async embed(chunks: readonly Chunk[]): Promise<VectorEntry[]> {
      return chunks.map((c, i) => ({
        chunk_id: c.chunk_id,
        embedding: Array.from({ length: JINA_V2_DIM }, (_, d) => (d === i % JINA_V2_DIM ? 1 : 0)),
        model_version: 'fake-1.0',
      }));
    },
    get dimension() { return JINA_V2_DIM; },
  };
}

/**
 * A fake embedder child that records the embed requests it receives and
 * immediately reports completion — standing in for the forked worker so the
 * parent-side driver can be tested without forking or loading ONNX.
 */
function makeFakeChild(): { handle: EmbedderChildHandle; received: EmbedRequest[] } {
  const received: EmbedRequest[] = [];
  let listener: ((msg: ChildMessage) => void) | null = null;
  const handle: EmbedderChildHandle = {
    on(_event, l) { listener = l; return handle; },
    off(_event, _l) { listener = null; return handle; },
    send(msg) {
      received.push(msg);
      queueMicrotask(() =>
        listener?.({ type: 'complete', embeddedCount: msg.chunkIds.length, durationMs: 1 }),
      );
      return true;
    },
    kill() { return true; },
  };
  return { handle, received };
}

// ---------------------------------------------------------------------------
// warmEmbeddings — parent-side driver (§7.4 Step 4)
// ---------------------------------------------------------------------------

describe('warmEmbeddings', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-warm-'));
    writeFileSync(join(tmpDir, 'math.ts'), SRC);
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends the pending chunk IDs to the embedder and resolves on completion', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const lance = await LanceStore.open(config.resolved_state_dir);
    const db = openDatabase(config.resolved_state_dir);
    const chunkStore = new SqliteChunkStore(db);
    const pendingExpected = (await chunkStore.getAllChunks()).map((c) => c.chunk_id);
    expect(pendingExpected.length).toBeGreaterThan(0);

    const fake = makeFakeChild();

    const result = await warmEmbeddings({
      modelId: config.embedding_model,
      stateDir: config.resolved_state_dir,
      chunkStore,
      lance,
      spawn: () => fake.handle,
    });
    await db.destroy();

    // The driver must actually request embedding of every un-vectorised chunk.
    expect(fake.received).toHaveLength(1);
    expect([...fake.received[0]!.chunkIds].sort()).toEqual([...pendingExpected].sort());
    expect(result.embedded).toBe(pendingExpected.length);
    expect(result.child).toBe(fake.handle);
  });

  it('does not spawn an embedder when every chunk is already vectorised', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runEmbed(config, { embedder: makeFakeEmbedder() });

    const lance = await LanceStore.open(config.resolved_state_dir);
    const db = openDatabase(config.resolved_state_dir);
    const chunkStore = new SqliteChunkStore(db);
    let spawnCalls = 0;

    const result = await warmEmbeddings({
      modelId: config.embedding_model,
      stateDir: config.resolved_state_dir,
      chunkStore,
      lance,
      spawn: () => { spawnCalls++; return makeFakeChild().handle; },
    });
    await db.destroy();

    expect(spawnCalls).toBe(0);
    expect(result.embedded).toBe(0);
    expect(result.child).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// embedChunks — one reusable child serves sequential requests (H2)
// ---------------------------------------------------------------------------

describe('embedChunks', () => {
  it('resolves with the embedded count and reuses the same child', async () => {
    const fake = makeFakeChild();

    const first = await embedChunks(fake.handle, ['a', 'b']);
    const second = await embedChunks(fake.handle, ['c']);

    expect(first).toBe(2);
    expect(second).toBe(1);
    // Both requests went to the one child — the basis for reusing the worker
    // across startup warm-up and every mast_reindex.
    expect(fake.received).toHaveLength(2);
    expect(fake.received.map((r) => [...r.chunkIds])).toEqual([['a', 'b'], ['c']]);
  });
});
