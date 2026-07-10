// Verify every gold-set target resolves to a real corpus chunk.
//
// Determinism guard: run this BEFORE scoring. If any target is missing, the gold
// set is broken and results would be meaningless — exits non-zero.

import { readFileSync } from 'node:fs';
import { LanceStore } from '../dist/store/lance.js';
import { BASE_STATE_DIR } from './paths.mjs';

const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf-8'));
const lance = await LanceStore.open(BASE_STATE_DIR);
const chunks = await lance.getAllChunks();

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
