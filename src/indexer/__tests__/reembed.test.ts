import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex, runEmbed } from '../../indexer/index.js';
import { LanceStore } from '../../store/lance.js';
import { JINA_V2_DIM, type EmbedderLike } from '../../indexer/embedder.js';
import type { Chunk, VectorEntry } from '../../ast/types.js';

// Fake embedder that records the content it was asked to embed, so a test can
// assert *which* chunks were (re-)embedded.
function makeRecordingEmbedder(): EmbedderLike & { embedded: string[] } {
  const embedded: string[] = [];
  return {
    embedded,
    async load() {},
    async embed(chunks: readonly Chunk[]): Promise<VectorEntry[]> {
      for (const c of chunks) embedded.push(c.content);
      return chunks.map((c, i) => ({
        chunk_id: c.chunk_id,
        embedding: Array.from({ length: JINA_V2_DIM }, (_, d) => (d === i % JINA_V2_DIM ? 1 : 0)),
        model_version: 'fake-1.0',
      }));
    },
    get dimension() { return JINA_V2_DIM; },
  };
}

// Two well-separated functions so, with context_lines: 0, each chunk's content
// is exactly its own declaration and editing one cannot perturb the other.
const v1 = `export function foo(): number {
  return 1;
}

export function bar(): number {
  return 2;
}
`;
// foo's body changed; foo still starts on line 1, so its chunk_id is unchanged.
const v2 = `export function foo(): number {
  return 111;
}

export function bar(): number {
  return 2;
}
`;

describe('re-embedding on in-place edits (H1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-reembed-'));
    // context_lines: 0 keeps each chunk's content to its own declaration.
    writeFileSync(join(tmpDir, 'mast.config.json'), JSON.stringify({ context_lines: 0 }));
    writeFileSync(join(tmpDir, 'm.ts'), v1);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-embeds a chunk whose content changed but whose id (start line) did not', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });

    await runIndex(config, { incremental: false });
    await runEmbed(config, { embedder: makeRecordingEmbedder() });

    const lance = await LanceStore.open(config.resolved_state_dir);
    const chunkCount = await lance.chunkCount();
    expect(await lance.vectorCount()).toBe(chunkCount);

    // Edit foo's body in place, reindex, re-embed.
    writeFileSync(join(tmpDir, 'm.ts'), v2);
    await runIndex(config, { incremental: false });
    const second = makeRecordingEmbedder();
    const result = await runEmbed(config, { embedder: second });

    // foo was re-embedded (its new body), bar was not (unchanged).
    expect(result.chunksEmbedded).toBe(1);
    expect(second.embedded.some((c) => c.includes('return 111'))).toBe(true);
    expect(second.embedded.some((c) => c.includes('return 2'))).toBe(false);

    // No duplicate vector for foo's reused chunk_id.
    const lance2 = await LanceStore.open(config.resolved_state_dir);
    expect(await lance2.vectorCount()).toBe(await lance2.chunkCount());
  });

  it('skips re-embedding when nothing changed', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    await runEmbed(config, { embedder: makeRecordingEmbedder() });

    // Re-index identical content, then embed again — nothing should re-embed.
    await runIndex(config, { incremental: false });
    const again = makeRecordingEmbedder();
    const result = await runEmbed(config, { embedder: again });

    expect(result.chunksEmbedded).toBe(0);
    expect(again.embedded).toHaveLength(0);
  });
});
