// Q1/SCALE — tier embed runner (LATER PHASE — do NOT run until the full-corpus embed
// against vscode-state-full has completed; this script depends on that cache being warm).
//
// For each tier state dir (T1-T3; T4 is vscode-state-full itself, already fully
// embedded), populates that tier's OWN `lance/vectors.lance` from the shared
// content-hash embed cache (symlinked into each tier's `embed_cache/` by
// scale-build-tiers.mjs's operator, NOT by this script). Every chunk in a tier is
// also a chunk in vscode-state-full (T1 subset T2 subset T3 subset T4, by
// construction), so once the full embed finishes, every tier's embed pass here is a
// 100% cache-hit populate — no model calls, per the registration's "Do NOT run tier
// embeds yet" note.
//
// Uses the SAME HarnessEmbedder recipe as eval/embed-full-corpus.mjs (dtype=fp32,
// recipeTag=shipped — the default). This is a DEVIATION worth stating plainly: the
// shipped product Embedder (src/indexer/embedder.ts) caches at
// `embed_cache/<modelId>/<hash>.json`; HarnessEmbedder (used to build
// vscode-state-full) caches at `embed_cache/<modelId>__<dtype>__<recipeTag>/<hash>.json`.
// The two layouts are NOT interchangeable — this script must use HarnessEmbedder with
// matching dtype/recipeTag or every tier read misses the shared cache entirely. See
// scale-build-tiers.mjs's header for how the embed_cache symlink is set up.
//
// After populating, runs Gate 0(c) and 0(d) per tier:
//   0(c): lance vector count == tier chunk count.
//   0(d): anti-join — zero vectors in the tier's lance table whose chunk_id is NOT
//         in that tier's own chunks table. An out-of-tier vector leak would die
//         silently at chunkStore.getChunksByIds (hybrid.ts:123), eating H-only
//         candidate slots — an asymmetric arm distortion (F8, AMENDMENT 1 item 8).
//         Computed as a Set-difference in JS (SQLite and LanceDB are different
//         storage engines; there is no single-query join across them).
//
//   node eval/scale-embed-tiers.mjs           # all tiers T1-T3
//   node eval/scale-embed-tiers.mjs T2         # a single tier

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore, chunkRecordToChunk } from '../dist/store/lance.js';
import { stampVectorHashes } from '../dist/indexer/embedder.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR, RESULTS_DIR } from './paths.mjs';

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const BATCH = 32;
const ROOT = join(homedir(), '.cache', 'mast-eval');

const requested = process.argv.slice(2);
const TIERS = requested.length > 0 ? requested : ['T1', 'T2', 'T3'];

async function embedTier(tierName) {
  const stateDir = join(ROOT, `vscode-state-${tierName.toLowerCase()}`);
  console.log(`\n=== ${tierName} (${stateDir}) ===`);

  const db = openDatabase(stateDir);
  const chunkStore = new SqliteChunkStore(db);
  const lance = await LanceStore.open(stateDir);

  const all = await chunkStore.getAllChunks();
  const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, stateDir, 'fp32');
  await embedder.load();
  await lance.ensureVectorsTable(embedder.dimension);

  const already = await lance.getEmbeddedChunkIds();
  const todo = all.filter((c) => !already.has(c.chunk_id));
  console.log(`[${tierName}] chunks=${all.length} already=${already.size} todo=${todo.length}`);

  const t0 = Date.now();
  let done = 0;
  let cacheMisses = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const cs = todo.slice(i, i + BATCH).map(chunkRecordToChunk);
    const before = Date.now();
    const vectors = await embedder.embed(cs);
    // A batch that was NOT cache-hit (real model call) takes materially longer than
    // a pure cache read. Recorded as a soft signal, not a hard gate — the registered
    // gates are 0(c)/0(d) below.
    if (Date.now() - before > 200 * cs.length) cacheMisses += cs.length;
    await lance.upsertVectors(stampVectorHashes(vectors, cs));
    done += cs.length;
    process.stdout.write(`\r[${tierName}] ${done}/${todo.length} ${(done / ((Date.now() - t0) / 1000)).toFixed(2)} ch/s`);
  }
  if (todo.length > 0) console.log('');
  console.log(`[${tierName}] embed pass done in ${((Date.now() - t0) / 1000).toFixed(1)}s; possible cache misses=${cacheMisses}`);

  // --- Gate 0(c): vector count == tier chunk count ---
  const vectorCount = await lance.vectorCount();
  const chunkCount = all.length;
  const gate0c = vectorCount === chunkCount;
  console.log(`[${tierName}] GATE 0(c) vectorCount=${vectorCount} chunkCount=${chunkCount} -> ${gate0c ? 'PASS' : 'FAIL'}`);

  // --- Gate 0(d): anti-join — zero vectors whose chunk_id is outside this tier ---
  const tierChunkIds = new Set(all.map((c) => c.chunk_id));
  const embeddedIds = await lance.getEmbeddedChunkIds();
  const outOfTier = [...embeddedIds].filter((id) => !tierChunkIds.has(id));
  const gate0d = outOfTier.length === 0;
  console.log(`[${tierName}] GATE 0(d) out-of-tier vectors=${outOfTier.length} -> ${gate0d ? 'PASS' : 'FAIL'}`);

  await db.destroy();
  return {
    tier: tierName, state_dir: stateDir,
    chunk_count: chunkCount, vector_count: vectorCount,
    gate0c_pass: gate0c, gate0d_pass: gate0d,
    out_of_tier_vector_ids: outOfTier,
    cache_misses_suspected: cacheMisses,
  };
}

const report = [];
for (const t of TIERS) {
  report.push(await embedTier(t));
}

const allPass = report.every((r) => r.gate0c_pass && r.gate0d_pass);
console.log(`\n=== GATE 0(c)/(d) SUMMARY: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT — do not proceed to scoring'} ===`);

mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = join(RESULTS_DIR, 'scale-embed-tiers-gate0cd.json');
writeFileSync(outFile, JSON.stringify({ ran_at: new Date().toISOString(), model: MODEL, tiers: report }, null, 2));
console.log(`wrote ${outFile}`);
if (!allPass) process.exit(1);
