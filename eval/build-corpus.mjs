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
// D2 (2026-08-01): chunks moved to graph.db's `chunks` table in M1, so the old
// `LanceStore.chunkCount()` here counted a table that no longer exists and would
// have reported 0 — a silent false result in the corpus-freezing step itself.
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { BASE_STATE_DIR, PROJECT_ROOT, CORPUS_SHA } from './paths.mjs';

mkdirSync(BASE_STATE_DIR, { recursive: true });

// Q1-r2 (re-registered 2026-08-01): exclude the documents the query set is
// harvested from. Leaving them in made every harvested query a near-perfect
// trigram match for its OWN source paragraph, so the lexical arm returned that
// one chunk and nothing else — scoring 0 by construction and manufacturing a
// "vectors justified" verdict. q19's target lives in workbench/fold, unaffected.
const Q1_EXCLUDES = [
  'packages/mast/IMPLEMENTATION_PLAN.md',
  'packages/mast/eval/GITNEXUS_COMPARISON.md',
  'packages/mast/.history/**',
];

const base = resolveConfig({
  projectRoot: PROJECT_ROOT,
  stateDirOverride: BASE_STATE_DIR,
});
const config = {
  ...base,
  exclude_patterns: [...base.exclude_patterns, ...(process.env.MAST_EVAL_R2 ? Q1_EXCLUDES : [])],
};
if (process.env.MAST_EVAL_R2) console.log(`[build-corpus] Q1-r2 excludes: ${Q1_EXCLUDES.join(', ')}`);

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

const db = openDatabase(BASE_STATE_DIR);
const chunkCount = await new SqliteChunkStore(db).chunkCount();
await db.destroy();

console.log(`[build-corpus] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`[build-corpus] corpus_sha   = ${CORPUS_SHA}`);
console.log(`[build-corpus] filesIndexed=${result.filesIndexed} parseErrors=${result.parseErrors}`);
console.log(`[build-corpus] TOTAL CHUNKS = ${chunkCount}`);

if (chunkCount === 0) {
  console.error('[build-corpus] FAIL: zero chunks — corpus is empty, do not score against it');
  process.exit(1);
}
