import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
// Parent-side host
// ---------------------------------------------------------------------------

export interface BackgroundEmbedderOptions {
  readonly modelId: string;
  readonly stateDir: string;
  readonly onProgress?: (progress: EmbedProgress) => void;
  readonly onComplete?: (result: EmbedComplete) => void;
  readonly onError?: (err: EmbedError) => void;
}

/**
 * Fork a child process to run Phase 2 embedding independently of the main
 * MCP server process.
 *
 * Rationale (§7.4): native ONNX allocations are isolated — an OOM in the
 * embedder cannot kill the MCP server, and the main process serves
 * discovery-layer queries with a small memory footprint (no model weights).
 *
 * @returns A handle to the child process. The caller must handle the IPC
 *   events to know when embedding is complete and can flip `mode` to hybrid.
 */
export function startBackgroundEmbedder(
  options: BackgroundEmbedderOptions,
): ChildProcess {
  const workerPath = fileURLToPath(
    new URL('./background-embedder-worker.js', import.meta.url),
  );

  const child = fork(workerPath, [], {
    env: {
      ...process.env,
      MAST_MODEL_ID: options.modelId,
      MAST_STATE_DIR: options.stateDir,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  child.on('message', (msg: ChildMessage) => {
    switch (msg.type) {
      case 'progress': options.onProgress?.(msg); break;
      case 'complete': options.onComplete?.(msg); break;
      case 'error':    options.onError?.(msg); break;
    }
  });

  return child;
}

/**
 * Send a batch of chunk IDs to an already-running background embedder child.
 * The child will embed those chunks and IPC `progress` + `complete` messages.
 */
export function requestEmbedding(child: ChildProcess, chunkIds: readonly string[]): void {
  const msg: EmbedRequest = { type: 'embed', chunkIds };
  child.send(msg);
}
