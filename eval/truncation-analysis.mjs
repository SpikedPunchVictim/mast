// embeddinggemma 2048-token context-cap truncation analysis (rubric N1).
//
// Tokenizes corpus chunks with embeddinggemma's OWN tokenizer and reports:
//   (a) how many gold-target chunks exceed 2048 tokens (would truncate),
//   (b) the same over the full corpus and the frozen subset,
//   (c) per-query: whether the query's gold target is a long (>2048) chunk,
//       so the report can correlate truncation with any recall drop.
//
// Run AFTER the model runs (so it doesn't contend for CPU and skew throughput):
//   node eval/truncation-analysis.mjs
// Writes results/truncation.json.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LanceStore } from '../dist/store/lance.js';
import { BASE_STATE_DIR, MODEL_CACHE_DIR, RESULTS_DIR } from './paths.mjs';
import { median } from './e1-schedule.mjs';

const CTX_CAP = 2048;
const GEMMA_ID = 'onnx-community/embeddinggemma-300m-ONNX';

const { AutoTokenizer, env } = await import('@huggingface/transformers');
env.cacheDir = MODEL_CACHE_DIR;
const tok = await AutoTokenizer.from_pretrained(GEMMA_ID);
const countTokens = (text) => tok(text, { add_special_tokens: true }).input_ids.dims.at(-1);

const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf-8'));
const subset = JSON.parse(readFileSync(new URL('./corpus-subset.json', import.meta.url), 'utf-8'));
const subsetIds = new Set(subset.chunkIds);

const lance = await LanceStore.open(BASE_STATE_DIR);
const chunks = await lance.getAllChunks();

const byFile = new Map();
for (const c of chunks) {
  if (!byFile.has(c.file_path)) byFile.set(c.file_path, []);
  byFile.get(c.file_path).push(c);
}

// (a) gold-target token lengths + per-query long-target flag.
const perQuery = [];
const goldTargetTokens = [];
for (const q of gold.queries) {
  let anyLong = false;
  let maxTok = 0;
  for (const t of q.relevant) {
    for (const c of byFile.get(t.file_path) ?? []) {
      const hit = t.symbol != null ? c.symbol_name === t.symbol
        : t.line != null ? t.line >= c.start_line && t.line <= c.end_line : false;
      if (!hit) continue;
      const n = countTokens(c.content);
      goldTargetTokens.push(n);
      maxTok = Math.max(maxTok, n);
      if (n > CTX_CAP) anyLong = true;
    }
  }
  perQuery.push({ id: q.id, maxGoldTargetTokens: maxTok, truncates: anyLong });
}

// (b) corpus + subset truncation rates (subset sampled for speed on the full set).
function truncStats(list) {
  let over = 0, max = 0;
  for (const c of list) {
    const n = countTokens(c.content);
    if (n > CTX_CAP) over++;
    if (n > max) max = n;
  }
  return { total: list.length, overCap: over, pctOver: +((over / list.length) * 100).toFixed(2), maxTokens: max };
}
const subsetChunks = chunks.filter((c) => subsetIds.has(c.chunk_id));
// Full-corpus stats sampled every 4th chunk to keep this quick (representative).
const corpusSample = chunks.filter((_, i) => i % 4 === 0);

const out = {
  ctxCap: CTX_CAP,
  tokenizer: GEMMA_ID,
  goldTargets: {
    count: goldTargetTokens.length,
    overCap: goldTargetTokens.filter((n) => n > CTX_CAP).length,
    maxTokens: Math.max(...goldTargetTokens),
    medianTokens: median(goldTargetTokens),
  },
  perQuery,
  subset: truncStats(subsetChunks),
  corpusSampled: truncStats(corpusSample),
};

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(join(RESULTS_DIR, 'truncation.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
