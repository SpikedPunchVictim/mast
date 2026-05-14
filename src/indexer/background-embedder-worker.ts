/**
 * Side-effectful module — instantiates EmbedWorker and calls run() on import.
 *
 * This file is the entry point for the forked embedder child process.
 * It reads process.env exactly once (at the bottom), validates the values,
 * then delegates everything to EmbedWorker, which never touches process.env.
 */
import { createEmbedder } from './embedder.js';
import { LanceStore, chunkRecordToChunk } from '../store/lance.js';
import type { ChildMessage, EmbedRequest } from './background-embedder.js';
import { WorkerEnvSchema } from '../env.js';

const BATCH_SIZE = 32;

// ---------------------------------------------------------------------------
// EmbedWorker — stateful, config-injected, never reads process.env
// ---------------------------------------------------------------------------

export class EmbedWorker {
  private readonly embedder: ReturnType<typeof createEmbedder>;
  private lance: LanceStore | null = null;

  constructor(
    modelId: string,
    private readonly stateDir: string,
  ) {
    this.embedder = createEmbedder(modelId, stateDir);
  }

  /**
   * Load the embedding model and open the vector store, then start listening
   * for IPC embed requests. Resolves once the model is ready.
   */
  async run(): Promise<void> {
    this.lance = await LanceStore.open(this.stateDir);
    // Load first to detect dimension, then create the table with the real size.
    await this.embedder.load();
    await this.lance.ensureVectorsTable(this.embedder.dimension);

    process.on('message', (msg: unknown) => {
      void this.handleEmbed(msg);
    });
  }

  private send(msg: ChildMessage): void {
    // process.send is always defined when forked with IPC — validated at entry.
    process.send!(msg);
  }

  private async handleEmbed(msg: unknown): Promise<void> {
    const req = msg as EmbedRequest;
    if (req.type !== 'embed') return;

    const lance = this.lance!;
    const startMs = Date.now();
    const chunks = await lance.getChunksByIds(req.chunkIds);
    const total = chunks.length;
    let embedded = 0;

    try {
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE).map(chunkRecordToChunk);
        const vectors = await this.embedder.embed(batch);
        await lance.insertVectors(vectors);
        embedded += batch.length;
        this.send({ type: 'progress', embeddedCount: embedded, totalCount: total });
      }
      this.send({ type: 'complete', embeddedCount: embedded, durationMs: Date.now() - startMs });
    } catch (err) {
      this.send({ type: 'error', message: String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry block — reads process.env exactly once, validates, starts the worker
// ---------------------------------------------------------------------------

if (!process.send) {
  process.stderr.write('[mast-worker] must be started as an IPC child process\n');
  process.exit(1);
}

const envResult = WorkerEnvSchema.safeParse(process.env);
if (!envResult.success) {
  process.stderr.write(`[mast-worker] invalid environment: ${envResult.error.message}\n`);
  process.exit(1);
}

const { MAST_STATE_DIR: stateDir, MAST_MODEL_ID: modelId } = envResult.data;

await new EmbedWorker(modelId, stateDir).run();
