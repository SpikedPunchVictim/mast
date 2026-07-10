// Freeze the vector-index subset ONCE (determinism rule).
//
// Embedding all 12,853 chunks at fp32 on CPU costs ~56 min/model (measured), so
// the tail of 4–5 models would run many hours. We instead embed a FIXED subset:
// every gold-target chunk + a seeded-random distractor pool (total ~3000). The
// FTS side stays full-corpus (cheap), so hybrid search still fuses against all
// 12.8k lexical candidates; only the vector index is the 3000-chunk pool. Gold
// needles (43) vs 2957 distractors is a legitimate retrieval ratio.
//
// Output: eval/corpus-subset.json — the frozen list of chunk_ids to embed.

import { writeFileSync, readFileSync } from 'node:fs';
import { LanceStore } from '../dist/store/lance.js';
import { BASE_STATE_DIR } from './paths.mjs';

const SUBSET_SIZE = 3000;
const SEED = 20260709;

const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf-8'));
const lance = await LanceStore.open(BASE_STATE_DIR);
const chunks = await lance.getAllChunks();

const byFile = new Map();
for (const c of chunks) {
  if (!byFile.has(c.file_path)) byFile.set(c.file_path, []);
  byFile.get(c.file_path).push(c);
}

// Collect gold-target chunk_ids (verified present earlier).
const goldIds = new Set();
for (const q of gold.queries) {
  for (const t of q.relevant) {
    const fc = byFile.get(t.file_path) ?? [];
    for (const c of fc) {
      const hit = t.symbol != null ? c.symbol_name === t.symbol
        : t.line != null ? t.line >= c.start_line && t.line <= c.end_line
        : false;
      if (hit) goldIds.add(c.chunk_id);
    }
  }
}

// Seeded PRNG (mulberry32) for a reproducible distractor sample.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const others = chunks.map((c) => c.chunk_id).filter((id) => !goldIds.has(id));
// Deterministic Fisher–Yates using the seeded PRNG.
for (let i = others.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [others[i], others[j]] = [others[j], others[i]];
}
const distractorCount = Math.max(0, SUBSET_SIZE - goldIds.size);
const subset = [...goldIds, ...others.slice(0, distractorCount)];

writeFileSync(
  new URL('./corpus-subset.json', import.meta.url),
  JSON.stringify({ seed: SEED, size: subset.length, goldTargets: goldIds.size, distractors: distractorCount, chunkIds: subset }, null, 0),
);
console.log(`subset frozen: ${subset.length} chunks (${goldIds.size} gold + ${distractorCount} distractors), seed ${SEED}`);
