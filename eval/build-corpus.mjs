// Stage 1 — build the model-independent corpus once.
//
// Runs the REAL Phase-1 indexer (dist/indexer/index.js `runIndex`) against this
// repo into a throwaway scratchpad state dir. This produces chunks.lance and the
// SQLite graph.db (chunk_fts / identifier_fts / symbols) that the FTS side of
// hybrid search reads. No embeddings are written here — vectors are per-model
// (build-vectors.mjs). Determinism rule: this corpus is frozen before any model
// is scored, and the gold set is verified against it.

import { mkdirSync } from 'node:fs';
import { resolveConfig } from '../dist/store/config.js';
import { runIndex } from '../dist/indexer/index.js';
import { LanceStore } from '../dist/store/lance.js';
import { BASE_STATE_DIR, PROJECT_ROOT } from './paths.mjs';

mkdirSync(BASE_STATE_DIR, { recursive: true });

const config = resolveConfig({
  projectRoot: PROJECT_ROOT,
  stateDirOverride: BASE_STATE_DIR,
});

console.log(`[build-corpus] project_root = ${config.resolved_project_root}`);
console.log(`[build-corpus] state_dir    = ${config.resolved_state_dir}`);
console.log(`[build-corpus] extensions   = ${config.file_extensions.join(', ')}`);

const t0 = Date.now();
const result = await runIndex(config, {
  incremental: false,
  onProgress: (done, total) => {
    if (done % 200 === 0 || done === total) {
      process.stdout.write(`\r[build-corpus] parsed ${done}/${total} files`);
    }
  },
});
process.stdout.write('\n');

const lance = await LanceStore.open(BASE_STATE_DIR);
const chunkCount = await lance.chunkCount();

console.log(`[build-corpus] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`[build-corpus] filesIndexed=${result.filesIndexed} parseErrors=${result.parseErrors}`);
console.log(`[build-corpus] TOTAL CHUNKS = ${chunkCount}`);
