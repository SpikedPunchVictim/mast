import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { LanceStore } from '../store/lance.js';

// ---------------------------------------------------------------------------
// IPC message types (parent ↔ child)
// ---------------------------------------------------------------------------

export interface EmbedRequest {
  readonly type: 'embed';
  readonly chunkIds: readonly string[];
}

export interface EmbedProgress {
  readonly type: 'progress';
  readonly embeddedCount: number;
  readonly totalCount: number;
}

export interface EmbedComplete {
  readonly type: 'complete';
  readonly embeddedCount: number;
  readonly durationMs: number;
}

export interface EmbedError {
  readonly type: 'error';
  readonly message: string;
}

export type ChildMessage = EmbedProgress | EmbedComplete | EmbedError;
export type ParentMessage = EmbedRequest;

// ---------------------------------------------------------------------------
// Parent-side driver
// ---------------------------------------------------------------------------

/**
 * Structural subset of `ChildProcess` the driver depends on. Declaring it
 * explicitly lets tests inject a fake child without forking a real process or
 * loading the ONNX runtime. The real `ChildProcess` satisfies this shape.
 */
export interface EmbedderChildHandle {
  on(event: 'message', listener: (msg: ChildMessage) => void): EmbedderChildHandle;
  off(event: 'message', listener: (msg: ChildMessage) => void): EmbedderChildHandle;
  send(message: ParentMessage): boolean;
  kill(): boolean;
}

/**
 * Chunk ids that have no vector yet (chunks present in `chunks.lance` but absent
 * from `vectors.lance`). This is the work set for both startup warm-up and
 * mid-task `mast_reindex` embedding.
 */
export async function pendingChunkIds(
  lance: Pick<LanceStore, 'getAllChunks' | 'getEmbeddedChunkIds'>,
): Promise<string[]> {
  const allChunks = await lance.getAllChunks();
  const embeddedIds = await lance.getEmbeddedChunkIds();
  return allChunks.map((c) => c.chunk_id).filter((id) => !embeddedIds.has(id));
}

/**
 * Send one embed request to an already-running child and resolve with the count
 * once it reports completion. Attaches a single correlated listener and removes
 * it on completion/error so the same long-lived child can serve many requests
 * (startup warm-up, then each `mast_reindex`).
 */
export function embedChunks(
  child: EmbedderChildHandle,
  chunkIds: readonly string[],
  onProgress?: (progress: EmbedProgress) => void,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const listener = (msg: ChildMessage): void => {
      switch (msg.type) {
        case 'progress': onProgress?.(msg); break;
        case 'complete': child.off('message', listener); resolve(msg.embeddedCount); break;
        case 'error':    child.off('message', listener); reject(new Error(`embedder failed: ${msg.message}`)); break;
      }
    };
    child.on('message', listener);
    child.send({ type: 'embed', chunkIds });
  });
}

/** Factory for an embedder child. Defaults to the real forked worker. */
export type SpawnEmbedderChild = (modelId: string, stateDir: string) => EmbedderChildHandle;

export interface WarmEmbeddingsOptions {
  readonly modelId: string;
  readonly stateDir: string;
  /** Store used to compute which chunks still need embedding. */
  readonly lance: Pick<LanceStore, 'getAllChunks' | 'getEmbeddedChunkIds'>;
  /** Child-process factory; defaults to {@link forkEmbedderChild}. Injected in tests. */
  readonly spawn?: SpawnEmbedderChild;
  /** Per-batch progress reporting from the child. */
  readonly onProgress?: (progress: EmbedProgress) => void;
}

export interface WarmEmbeddingsResult {
  /** Number of chunks the embedder reported embedding. */
  readonly embedded: number;
  /**
   * The spawned child, kept alive so future incremental embedding can reuse it,
   * or `null` when nothing was pending and no child was spawned.
   */
  readonly child: EmbedderChildHandle | null;
}

/**
 * Compute the set of chunks that have no vector yet and drive the forked
 * embedder to embed them, resolving once the embedder reports completion.
 *
 * This is the parent-side glue required by §7.4 Step 4: the worker only embeds
 * in response to an `embed` request, so without this the semantic layer never
 * warms and `mast_search` stays in `lexical` mode forever.
 *
 * Resolves immediately with `{ embedded: 0, child: null }` when every chunk is
 * already vectorised (e.g. a Docker-baked seed). Rejects if the embedder
 * reports an error.
 */
export async function warmEmbeddings(options: WarmEmbeddingsOptions): Promise<WarmEmbeddingsResult> {
  const pendingIds = await pendingChunkIds(options.lance);
  if (pendingIds.length === 0) {
    return { embedded: 0, child: null };
  }

  const spawn = options.spawn ?? forkEmbedderChild;
  const child = spawn(options.modelId, options.stateDir);
  const embedded = await embedChunks(child, pendingIds, options.onProgress);
  return { embedded, child };
}

/**
 * Fork the embedder worker as a child process.
 *
 * Rationale (§7.4): native ONNX allocations are isolated — an OOM or segfault
 * in the embedder cannot kill the MCP server, and the main process keeps a
 * small footprint (no model weights loaded in-process).
 */
export function forkEmbedderChild(modelId: string, stateDir: string): EmbedderChildHandle {
  const workerPath = fileURLToPath(
    new URL('./background-embedder-worker.js', import.meta.url),
  );

  return fork(workerPath, [], {
    env: {
      ...process.env,
      MAST_MODEL_ID: modelId,
      MAST_STATE_DIR: stateDir,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
}
