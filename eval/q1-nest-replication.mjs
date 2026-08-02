// Q1 — n>=2 EXTERNAL replication on nest (pinned).
//
// The kluster run is home-field: the corpus is our own repo and the targets skew
// to packages/mast/src. Per the empirical-planning rule "validating on the one
// repo you built for lies to you", this repeats the decisive comparison on a
// foreign codebase chosen by someone else.
//
// Scope: the NORMAL (lexically-biased) set only. gold-set.json's 28 anti-lexical
// queries were hand-authored against kluster chunks and cannot port — so this
// replication tests exactly one thing, and it is the hard direction:
//
//   does hybrid still beat lexical on a query set RIGGED FOR LEXICAL?
//
// Query derivation is identical to gold-set-normal-r2.json:
//   query = camelCaseSplit(symbol_name) + first TSDoc sentence, <= 12 words.
// Target selection is mechanical: seeded shuffle over exported, TSDoc-bearing
// declarations. No human picks which symbols are in the set.
//
//   node eval/q1-nest-replication.mjs build|embed|score

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore, chunkRecordToChunk } from '../dist/store/lance.js';
import { hybridSearch } from '../dist/search/hybrid.js';
import { stampVectorHashes } from '../dist/indexer/embedder.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR, RESULTS_DIR } from './paths.mjs';

const NEST_ROOT = join(process.env.HOME, '.cache/mast-eval/corpus-nest');
const NEST_STATE = join(process.env.HOME, '.cache/mast-eval/base-state-nest');
const NEST_SHA = 'f7fffd63937ce6133624d23eb1d46fdd3c271526';
const SET_FILE = new URL('./gold-set-nest.json', import.meta.url);
const SUBSET_FILE = new URL('./corpus-subset-nest.json', import.meta.url);
const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const SEED = 20260801;
const WANT = 20;
const SUBSET_SIZE = 3000;
const LIMIT = 10;
const BATCH = 32;
const cmd = process.argv[2] ?? 'score';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function splitIdent(name) {
  return name.replace(/[._]/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/\s+/).filter(Boolean);
}
function tsdocFirstSentence(filePath, startLine) {
  const abs = join(NEST_ROOT, filePath);
  if (!existsSync(abs)) return '';
  const lines = readFileSync(abs, 'utf-8').split('\n');
  let i = startLine - 2;
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0 || !lines[i].trim().endsWith('*/')) return '';
  const block = [];
  while (i >= 0) { block.unshift(lines[i]); if (lines[i].trim().startsWith('/**')) break; i--; }
  const text = block.join(' ').replace(/\/\*\*|\*\//g, ' ').replace(/^\s*\*\s?/gm, ' ')
    .replace(/\s*\*\s/g, ' ').replace(/`|\{@\w+\s*|\}/g, ' ').replace(/@\w+/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
  const m = text.match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1] : text).trim();
}

const db = openDatabase(NEST_STATE);
const chunkStore = new SqliteChunkStore(db);
const lance = await LanceStore.open(NEST_STATE);

// --------------------------------------------------------------- build
if (cmd === 'build') {
  const chunks = await chunkStore.getAllChunks();
  if (chunks.length === 0) { console.error('FAIL: nest corpus empty — build it first.'); process.exit(1); }

  const eligible = chunks.filter((c) =>
    c.is_exported && c.symbol_name &&
    ['function', 'method', 'class_shell', 'interface', 'type'].includes(c.chunk_type) &&
    splitIdent(c.symbol_name).length >= 2);
  const rand = mulberry32(SEED);
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }

  const queries = [];
  const takenFiles = new Set();
  for (const c of eligible) {
    if (queries.length >= WANT) break;
    if (takenFiles.has(c.file_path)) continue;          // spread across files
    const doc = tsdocFirstSentence(c.file_path, c.start_line);
    if (!doc) continue;                                  // TSDoc required (same as r2)
    const seen = new Set(); const words = [];
    for (const w of [...splitIdent(c.symbol_name), ...doc.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)]) {
      if (w.length < 2 || seen.has(w)) continue;
      seen.add(w); words.push(w);
      if (words.length >= 12) break;
    }
    if (words.length < 4) continue;
    takenFiles.add(c.file_path);
    queries.push({
      id: `x${String(queries.length + 1).padStart(2, '0')}`,
      query: words.join(' '),
      derived_from: c.symbol_name,
      relevant: [{ file_path: c.file_path, symbol: c.symbol_name }],
    });
  }

  writeFileSync(SET_FILE, JSON.stringify({
    version: '1.0.0', created: '2026-08-01',
    corpus: { repo: 'nestjs/nest', sha: NEST_SHA, chunks: chunks.length },
    purpose: 'Q1 external (n>=2) replication — foreign corpus, same TSDoc-derived protocol as gold-set-normal-r2.json.',
    declared_bias: 'BIASED FOR THE LEXICAL ARM (TSDoc tokens sit inside the target), identical to the kluster normal set. Hybrid winning here is the hard direction.',
    selection: { seed: SEED, eligible: eligible.length, picked: queries.length, rule: 'exported + TSDoc-bearing declarations, seeded shuffle, one per file' },
    queries,
  }, null, 2));
  console.log(`nest set: ${queries.length} queries from ${eligible.length} eligible (${chunks.length} chunks)`);
  for (const q of queries) console.log(`  ${q.id} [${q.derived_from}] "${q.query}"`);

  // freeze subset
  const goldIds = new Set();
  const byFile = new Map();
  for (const c of chunks) {
    if (!byFile.has(c.file_path)) byFile.set(c.file_path, []);
    byFile.get(c.file_path).push(c);
  }
  const unresolved = [];
  for (const q of queries) {
    const t = q.relevant[0];
    const hits = (byFile.get(t.file_path) ?? []).filter((c) => c.symbol_name === t.symbol);
    if (hits.length === 0) unresolved.push(q.id);
    hits.forEach((c) => goldIds.add(c.chunk_id));
  }
  if (unresolved.length) { console.error('FAIL unresolved:', unresolved.join(',')); process.exit(1); }
  const rand2 = mulberry32(SEED);
  const others = chunks.map((c) => c.chunk_id).filter((id) => !goldIds.has(id));
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(rand2() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const subset = [...goldIds, ...others.slice(0, Math.max(0, SUBSET_SIZE - goldIds.size))];
  writeFileSync(SUBSET_FILE, JSON.stringify({ seed: SEED, sha: NEST_SHA, size: subset.length, goldTargets: goldIds.size, chunkIds: subset }, null, 0));
  console.log(`subset frozen: ${subset.length} (${goldIds.size} gold, 0 unresolved)`);
  await db.destroy();
  process.exit(0);
}

// --------------------------------------------------------------- embed
const subset = JSON.parse(readFileSync(SUBSET_FILE, 'utf-8'));
if (cmd === 'embed') {
  const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, NEST_STATE, 'fp32');
  await embedder.load();
  await lance.ensureVectorsTable(embedder.dimension);
  const already = await lance.getEmbeddedChunkIds();
  const todo = subset.chunkIds.filter((id) => !already.has(id));
  console.log(`[nest-embed] todo=${todo.length}`);
  const t0 = Date.now();
  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const recs = await chunkStore.getChunksByIds(todo.slice(i, i + BATCH));
    if (recs.length === 0) continue;
    const cs = recs.map(chunkRecordToChunk);
    await lance.upsertVectors(stampVectorHashes(await embedder.embed(cs), cs));
    done += cs.length;
    process.stdout.write(`\r[nest-embed] ${done}/${todo.length} ${(done / ((Date.now() - t0) / 1000)).toFixed(2)} ch/s`);
  }
  console.log(`\n[nest-embed] vectorCount=${await lance.vectorCount()}`);
  await db.destroy();
  process.exit(0);
}

// --------------------------------------------------------------- score
const gold = JSON.parse(readFileSync(SET_FILE, 'utf-8'));
const vectorCount = await lance.vectorCount();
if (vectorCount === 0) { console.error('FAIL: no vectors — run embed first.'); process.exit(1); }
const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, NEST_STATE, 'fp32');
await embedder.load();
const cfg = { rrf_k: 60 };

function scoreQuery(q, ranked) {
  const targets = q.relevant;
  const covered = new Set();
  let dcg = 0, firstRel = 0;
  for (let i = 0; i < Math.min(ranked.length, LIMIT); i++) {
    const r = ranked[i];
    let idx = -1;
    for (let k = 0; k < targets.length; k++) {
      const t = targets[k];
      if (t.file_path === r.file_path && t.symbol === r.symbol_name) { idx = k; break; }
    }
    if (idx >= 0 && !covered.has(idx)) {
      dcg += 1 / Math.log2(i + 2); covered.add(idx);
      if (firstRel === 0) firstRel = i + 1;
    }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(targets.length, LIMIT); i++) idcg += 1 / Math.log2(i + 2);
  return { ndcg: idcg > 0 ? dcg / idcg : 0, recall: covered.size / targets.length, rr: firstRel > 0 ? 1 / firstRel : 0 };
}

const out = {};
for (const arm of ['L', 'H', 'V']) {
  const agg = { ndcg: 0, recall: 0, mrr: 0, n: 0 };
  const perQuery = [];
  for (const q of gold.queries) {
    let ranked;
    if (arm === 'V') {
      const hits = await lance.searchVectors(await embedder.embedRawUncached(q.query), LIMIT);
      const recs = await chunkStore.getChunksByIds(hits.map((h) => h.chunk_id));
      const byId = new Map(recs.map((r) => [r.chunk_id, r]));
      ranked = hits.map((h) => byId.get(h.chunk_id)).filter(Boolean);
    } else {
      ranked = (await hybridSearch(db, lance, arm === 'H' ? embedder : null, { query: q.query, limit: LIMIT }, cfg, chunkStore)).results;
    }
    const m = scoreQuery(q, ranked);
    agg.ndcg += m.ndcg; agg.recall += m.recall; agg.mrr += m.rr; agg.n++;
    perQuery.push({ id: q.id, ndcg: +m.ndcg.toFixed(4) });
  }
  out[arm] = { ndcg: +(agg.ndcg / agg.n).toFixed(4), recall: +(agg.recall / agg.n).toFixed(4), mrr: +(agg.mrr / agg.n).toFixed(4), perQuery };
  console.log(`[nest] arm ${arm}: NDCG@10=${out[arm].ndcg} Recall@10=${out[arm].recall} MRR=${out[arm].mrr}`);
}

const lRetrieving = out.L.perQuery.filter((q) => q.ndcg > 0).length;
const gatePassed = lRetrieving >= Math.ceil(gold.queries.length * 0.4);
const delta = +(out.H.ndcg - out.L.ndcg).toFixed(4);
console.log(`\n[sanity gate] arm L retrieves on ${lRetrieving}/${gold.queries.length} (need >=${Math.ceil(gold.queries.length * 0.4)}) -> ${gatePassed ? 'PASS' : 'FAIL'}`);
console.log(`delta NDCG@10 (H-L) = ${delta}  [set biased FOR lexical]`);
const verdict = !gatePassed
  ? 'VOID — sanity gate failed'
  : delta >= 0.10
    ? 'REPLICATED — hybrid beats lexical on a foreign corpus with a lexically-rigged set'
    : 'NOT REPLICATED — the kluster result does not generalize; treat Q1 as home-field only';
console.log(`VERDICT: ${verdict}`);

mkdirSync(RESULTS_DIR, { recursive: true });
const f = join(RESULTS_DIR, 'q1-nest-replication.json');
writeFileSync(f, JSON.stringify({
  experiment: 'Q1 external replication (n>=2) — nest',
  ranAt: new Date().toISOString(), corpus: gold.corpus, model: MODEL,
  vectors_in_index: vectorCount, queries: gold.queries.length,
  results: out, sanity_gate: { lRetrieving, of: gold.queries.length, passed: gatePassed },
  delta_ndcg: delta, verdict,
  caveats: ['Normal (lexically-biased) set only — the 28 anti-lexical queries are kluster-specific and cannot port.',
    'Targets are exported TSDoc-bearing declarations, one per file, seeded selection.'],
}, null, 2));
console.log(`wrote ${f}`);
await db.destroy();
