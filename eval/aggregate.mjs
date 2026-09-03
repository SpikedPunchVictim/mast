// Stage 3 — aggregate results/*.json into the scored table, weighted composite,
// and an automatic application of the rubric's decision rule. Prints Markdown
// ready to paste into FABLE_FEEDBAK.md.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INCUMBENT_ID } from './models.mjs';
import { RESULTS_DIR as SCRATCH_RESULTS_DIR } from './paths.mjs';

// Rubric weights (proposed defaults from FABLE_FEEDBAK.md §"Scored axes").
const W = { quality: 0.50, latency: 0.15, throughput: 0.10, storage: 0.10, footprint: 0.10, quant: 0.05 };

// Prefer the versioned copy in eval/results/ (auditable after the scratchpad is
// gone); fall back to the live scratchpad during an active run.
const repoResults = join(fileURLToPath(new URL('.', import.meta.url)), 'results');
const RESULTS_DIR = existsSync(repoResults) ? repoResults : SCRATCH_RESULTS_DIR;

// truncation.json and recipe probes have a different shape — the model table
// aggregates only run-model.mjs outputs.
const files = readdirSync(RESULTS_DIR).filter(
  (f) => f.endsWith('.json') && !f.startsWith('truncation') && !f.includes('__recipe_'),
);
const runs = files.map((f) => JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf-8')));

// Primary rows: fp32 (the shipped dtype). Quant probes are matched by modelId.
const fp32 = runs.filter((r) => r.dtype === 'fp32');
const incumbent = fp32.find((r) => r.modelId === INCUMBENT_ID);
if (!incumbent) throw new Error('no incumbent fp32 result found');

const mb = (b) => (b == null ? null : +(b / 1024 / 1024).toFixed(0));
const quality = (r, variant) => {
  const s = r.scores?.[variant];
  if (!s) return null;
  return +((s.ndcg + s.recall + s.mrr) / 3).toFixed(4);
};

function ratio(cand, base, higherBetter, cap = 3) {
  if (cand == null || base == null || base === 0) return null;
  const r = higherBetter ? cand / base : base / cand;
  return Math.min(r, cap);
}

// hybrid_shipped (θ=0.70) is degenerate — 0/28 gold queries clear jina's 0.70
// gate, so it zeroes every model equally (a cosine-scale artifact, not quality).
// The discriminating hybrid metric is hybrid_thresh0 (RRF over FTS+vector with
// the miscalibrated gate removed). Quality axis + decision rule use it.
const QUALITY_VARIANT = 'hybrid_thresh0';
const incQualityH = quality(incumbent, QUALITY_VARIANT);
const _incQualityV = quality(incumbent, 'pure_vector');

const rows = fp32.map((r) => {
  if (r.gate !== 'passed') return { r, gate: r.gate };
  const qH = quality(r, QUALITY_VARIANT);
  const qV = quality(r, 'pure_vector');
  const rQuality = ratio(qH, incQualityH, true);
  const rLatency = ratio(r.queryLatencyMedianMs, incumbent.queryLatencyMedianMs, false);
  const rThroughput = ratio(r.throughputChunksPerSec, incumbent.throughputChunksPerSec, true);
  const rStorage = ratio(r.dims, incumbent.dims, false);
  const rFootprint = ratio(r.downloadBytesAbs, incumbent.downloadBytesAbs, false);
  const rQuant = 1; // fp32 baseline; quant deltas reported separately
  const composite =
    W.quality * rQuality + W.latency * rLatency + W.throughput * rThroughput +
    W.storage * rStorage + W.footprint * rFootprint + W.quant * rQuant;
  return {
    r, gate: 'passed', qH, qV,
    ndcgH: r.scores.hybrid_shipped.ndcg, recallH: r.scores.hybrid_shipped.recall, mrrH: r.scores.hybrid_shipped.mrr,
    ndcgV: r.scores.pure_vector.ndcg, ndcgH0: r.scores.hybrid_thresh0.ndcg,
    rQuality, rLatency, rThroughput, rStorage, rFootprint,
    composite: +composite.toFixed(3),
  };
});

// Decision rule per query: NDCG@10 (hybrid) ≥ +3–5%, latency ≤1.5×, storage ≤1.3×.
function decision(row) {
  if (row.gate !== 'passed') return 'DROPPED (gate failed)';
  if (row.r.modelId === INCUMBENT_ID) return 'baseline';
  if (row.r.role === 'reference') return 'REFERENCE ONLY (license)';
  const ndcgGain = (row.ndcgH0 - incumbent.scores[QUALITY_VARIANT].ndcg) / (incumbent.scores[QUALITY_VARIANT].ndcg || 1);
  const latMult = row.r.queryLatencyMedianMs / incumbent.queryLatencyMedianMs;
  const dimMult = row.r.dims / incumbent.dims;
  const clears = ndcgGain >= 0.03 && latMult <= 1.5 && dimMult <= 1.3;
  return `${clears ? 'SWITCH-CANDIDATE' : 'KEEP INCUMBENT'} (ΔNDCG=${(ndcgGain * 100).toFixed(1)}% lat×${latMult.toFixed(2)} dim×${dimMult.toFixed(2)})`;
}

// --- Markdown ---
let md = '';
md += '#### Operational + quality table (fp32, shipped pipeline: mean-pool + normalize, threshold 0.70)\n\n';
md += '| Model | Role | Lic | dims | NDCG@10 (hyb) | Recall@10 | MRR | NDCG (vec-only) | NDCG (hyb θ=0) | q-lat ms | thru ch/s | dl MB | vec.lance MB (12.8k) | composite | decision |\n';
md += '|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|\n';
for (const row of rows.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1))) {
  const r = row.r;
  if (row.gate !== 'passed') {
    md += `| ${r.label} | ${r.role} | ${r.license} | — | — | — | — | — | — | — | — | — | — | — | ${decision(row)} |\n`;
    continue;
  }
  md += `| ${r.label} | ${r.role} | ${shortLic(r.license)} | ${r.dims} | ${r.scores.hybrid_shipped.ndcg} | ${r.scores.hybrid_shipped.recall} | ${r.scores.hybrid_shipped.mrr} | ${row.ndcgV} | ${row.ndcgH0} | ${r.queryLatencyMedianMs} | ${r.throughputChunksPerSec} | ${mb(r.downloadBytesAbs)} | ${mb(r.projectedVectorPayloadBytes)} | ${row.composite} | ${decision(row)} |\n`;
}

md += '\n#### Composite axis breakdown (ratio to incumbent, capped 3.0; incumbent=1.00 each)\n\n';
md += '| Model | quality×.5 | latency×.15 | thru×.10 | storage×.10 | footprint×.10 | composite |\n|---|--:|--:|--:|--:|--:|--:|\n';
for (const row of rows) {
  if (row.gate !== 'passed') continue;
  md += `| ${row.r.label} | ${f(row.rQuality)} | ${f(row.rLatency)} | ${f(row.rThroughput)} | ${f(row.rStorage)} | ${f(row.rFootprint)} | ${row.composite} |\n`;
}

// Quant probes
const quantRuns = runs.filter((r) => r.dtype !== 'fp32' && r.gate === 'passed');
if (quantRuns.length > 0) {
  md += '\n#### Quantization deltas (quantized vs fp32, same model)\n\n';
  md += '| Model | dtype | NDCG@10 (hyb) | Δ vs fp32 | q-lat ms | dl MB |\n|---|---|--:|--:|--:|--:|\n';
  for (const qr of quantRuns) {
    const base = fp32.find((r) => r.modelId === qr.modelId);
    const dNdcg = base ? (qr.scores.hybrid_shipped.ndcg - base.scores.hybrid_shipped.ndcg) : null;
    md += `| ${qr.label} | ${qr.dtype} | ${qr.scores.hybrid_shipped.ndcg} | ${dNdcg == null ? '—' : (dNdcg >= 0 ? '+' : '') + dNdcg.toFixed(4)} | ${qr.queryLatencyMedianMs} | ${mb(qr.downloadBytesAbs)} |\n`;
  }
}

md += '\n#### Threshold-mismatch diagnostic (why hybrid_shipped can hide a good vector model)\n\n';
md += '| Model | gold queries with a vector hit ≥0.70 | of | \n|---|--:|--:|\n';
for (const row of rows) {
  if (row.gate !== 'passed') continue;
  md += `| ${row.r.label} | ${row.r.vectorAboveThresholdQueries} | ${row.r.goldQueryCount} |\n`;
}

console.log(md);

function f(x) { return x == null ? '—' : x.toFixed(2); }
function shortLic(l) { return l.replace('(NON-ADOPTABLE)', 'NC').replace('CC-BY-NC-4.0 NC', 'CC-NC'); }
