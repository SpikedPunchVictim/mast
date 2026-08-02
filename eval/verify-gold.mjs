// Verify every gold-set target resolves to a real corpus chunk.
//
// Determinism guard: run this BEFORE scoring. If any target is missing, the gold
// set is broken and results would be meaningless — exits non-zero.

import { readFileSync } from 'node:fs';
// D2 (2026-08-01): was `LanceStore.getAllChunks()` — dead post-M1, so it returned
// an EMPTY chunk set and reported all 43 targets as "(file not in corpus)". The
// determinism gate's own read path was broken, producing a confident, entirely
// artifactual verdict. It failed closed (exit 1) so nothing was scored against
// bad data, but the same rot in build-corpus.mjs reported `TOTAL CHUNKS = 0` as
// success — hence the explicit zero-chunk guard added there.
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { BASE_STATE_DIR } from './paths.mjs';

const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf-8'));
const db = openDatabase(BASE_STATE_DIR);
const chunks = await new SqliteChunkStore(db).getAllChunks();
await db.destroy();

if (chunks.length === 0) {
  console.error('FAIL: corpus has zero chunks — run build-corpus.mjs first.');
  process.exit(1);
}

// Index chunks by file for fast lookup.
const byFile = new Map();
for (const c of chunks) {
  if (!byFile.has(c.file_path)) byFile.set(c.file_path, []);
  byFile.get(c.file_path).push(c);
}

/** Does a target match at least one real chunk? */
export function targetMatches(target, fileChunks) {
  if (!fileChunks) return false;
  return fileChunks.some((c) => {
    if (target.symbol != null) return c.symbol_name === target.symbol;
    if (target.line != null) return target.line >= c.start_line && target.line <= c.end_line;
    return false;
  });
}

let missing = 0;
let totalTargets = 0;
for (const q of gold.queries) {
  for (const t of q.relevant) {
    totalTargets++;
    const fileChunks = byFile.get(t.file_path);
    if (!targetMatches(t, fileChunks)) {
      missing++;
      const near = fileChunks
        ? fileChunks.map((c) => c.symbol_name ?? `L${c.start_line}-${c.end_line}`).slice(0, 12).join(', ')
        : '(file not in corpus)';
      console.error(`MISSING  ${q.id}  ${t.file_path}  ${t.symbol ?? 'L' + t.line}`);
      console.error(`         available in file: ${near}`);
    }
  }
}

console.log(`\nqueries: ${gold.queries.length}  targets: ${totalTargets}  missing: ${missing}`);
if (missing > 0) {
  console.error('GOLD SET INVALID — fix targets before scoring.');
  process.exit(1);
}
console.log('gold set OK — every target exists in the corpus.');
