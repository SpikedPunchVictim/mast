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

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
// D2 (2026-08-01): was LanceStore.getAllChunks() — dead post-M1, returns empty,
// which would have frozen a subset containing ZERO gold targets and silently
// crippled every vector-using arm. Same rot class as build-corpus/verify-gold.
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { BASE_STATE_DIR, CORPUS_SHA } from './paths.mjs';

const SUBSET_SIZE = 3000;
const SEED = 20260709;

// Q1: BOTH gold sets must be embedded. gold-set.json is the anti-lexical set;
// gold-set-normal.json is the lexically-normal counterweight (§14.3). Omitting
// the latter would leave its targets unembedded, so arms H and V could never
// retrieve them and Q1 would measure the vector store's absence, not its value.
const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf-8'));
// Prefer the re-registered r2 set when present (v1 is VOID — in-corpus leakage).
const normalUrl = new URL(
  existsSync(new URL('./gold-set-normal-r2.json', import.meta.url)) ? './gold-set-normal-r2.json' : './gold-set-normal.json',
  import.meta.url,
);
console.log(`[make-subset] normal set: ${normalUrl.pathname.split('/').pop()}`);
const goldNormal = JSON.parse(readFileSync(normalUrl, 'utf-8'));
const allQueries = [...gold.queries, ...goldNormal.queries];

const db = openDatabase(BASE_STATE_DIR);
const chunks = await new SqliteChunkStore(db).getAllChunks();
await db.destroy();
if (chunks.length === 0) {
  console.error('FAIL: corpus empty — run build-corpus.mjs first.');
  process.exit(1);
}

const byFile = new Map();
for (const c of chunks) {
  if (!byFile.has(c.file_path)) byFile.set(c.file_path, []);
  byFile.get(c.file_path).push(c);
}

// Collect gold-target chunk_ids (verified present earlier).
const goldIds = new Set();
const unresolvedTargets = [];
for (const q of allQueries) {
  for (const t of q.relevant) {
    const fc = byFile.get(t.file_path) ?? [];
    let resolved = false;
    for (const c of fc) {
      const hit = t.symbol != null ? c.symbol_name === t.symbol
        : t.line != null ? t.line >= c.start_line && t.line <= c.end_line
        : false;
      if (hit) { goldIds.add(c.chunk_id); resolved = true; }
    }
    if (!resolved) unresolvedTargets.push(`${q.id} ${t.file_path}:${t.symbol ?? t.line}`);
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
  JSON.stringify({ seed: SEED, corpus_sha: CORPUS_SHA, size: subset.length, goldTargets: goldIds.size, distractors: distractorCount, chunkIds: subset }, null, 0),
);
console.log(`subset frozen: ${subset.length} chunks (${goldIds.size} gold + ${distractorCount} distractors), seed ${SEED}`);
console.log(`corpus_sha: ${CORPUS_SHA}`);

// Guard: EVERY target must resolve to at least one chunk. Note the chunk-id
// count is legitimately LOWER than the target count — distinct targets can
// share a chunk (e.g. two cited lines inside one function) — so comparing the
// two counts would false-alarm. Resolution, not cardinality, is the invariant.
const expectedTargets = allQueries.reduce((n, q) => n + q.relevant.length, 0);
console.log(`targets: ${expectedTargets} → ${goldIds.size} distinct chunks, ${unresolvedTargets.length} unresolved`);
if (unresolvedTargets.length > 0) {
  console.error('FAIL: subset would omit gold needles:');
  for (const u of unresolvedTargets) console.error(`  ${u}`);
  process.exit(1);
}
