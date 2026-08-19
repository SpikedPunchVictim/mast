// Arms E and D from the grounding report.
//
// E: parallelism headroom — cpu/wall ratio of ONE solo call. If ORT's intra-op
//    pool already saturates the cores at batch=1, batching cannot add
//    parallelism and its only marginal effect is padding waste.
// D: intrinsic batching overhead — batch-16 of IDENTICAL text vs 16 sequential
//    calls on that text. Identical length ⇒ zero padding by construction, so
//    any difference is batching itself, not padding.
//
// Controls the confounds in tmp-diagnose.mjs: explicit per-shape warm-up,
// interleaved arm order, 3 reps + median, token lengths (not chars).
import { openDatabase } from '/Users/spikedpunchvictim/projects/kluster/packages/mast/dist/graph/db.js';
import { SqliteChunkStore } from '/Users/spikedpunchvictim/projects/kluster/packages/mast/dist/store/sqliteChunkStore.js';
import { pipeline, env } from '@huggingface/transformers';
import { join } from 'node:path';
import os from 'node:os';
import { median } from './e1-schedule.mjs';

const STATE_DIR = '/Users/spikedpunchvictim/temp/mast-bench/embed-batching-eval-state';
const MODEL_ID = 'jinaai/jina-embeddings-v2-base-code';
env.cacheDir = join(process.env.HOME, '.cache', 'mast', 'transformers');

const db = openDatabase(STATE_DIR);
const store = new SqliteChunkStore(db);
const all = await store.getAllChunks();
await db.destroy();

const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' });
const tok = extractor.tokenizer;

const tokLen = (text) => tok(text).input_ids.dims[1];

// Pick real chunks nearest a target token length.
function pickNear(targetTokens) {
  let best = null;
  for (const c of all) {
    // cheap char prefilter so we don't tokenize 14k chunks
    const approx = c.content.length / 3.5;
    if (approx < targetTokens * 0.5 || approx > targetTokens * 2) continue;
    const n = tokLen(c.content);
    const d = Math.abs(n - targetTokens);
    if (best === null || d < best.d) best = { d, n, text: c.content };
    if (d === 0) break;
  }
  return best;
}

const opts = { pooling: 'mean', normalize: true };

async function timed(texts) {
  const c0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  await extractor(texts, opts);
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const c1 = process.cpuUsage(c0);
  const cpuMs = (c1.user + c1.system) / 1000;
  return { wallMs, cpuMs, ratio: cpuMs / wallMs };
}

async function warm(texts, n = 2) {
  for (let i = 0; i < n; i++) await extractor(texts, opts);
}

console.log(`cores: ${os.cpus().length} (${os.cpus()[0].model})`);
console.log(`memGB: ${(os.totalmem() / 1e9).toFixed(1)}`);

const REPS = 3;
const out = { cores: os.cpus().length, arms: {} };

// Token-budget cap on the sweep: B x tokens must stay under this, so we never
// request a [B,12,L,L] score tensor that thrashes a 16 GB box. Also what the
// real fix should use in place of a fixed count.
const SWEEP_TOKEN_BUDGET = 16384;

const TARGETS = process.argv.slice(2).map(Number);
for (const target of TARGETS.length > 0 ? TARGETS : [64, 512, 2048]) {
  const pick = pickNear(target);
  if (pick === null) {
    console.log(`\n=== target ~${target} tok: no chunk found, skipping ===`);
    continue;
  }
  const { text, n } = pick;
  console.log(`\n=== target ~${target} tok — using real chunk of ${n} tok (${text.length} chars) ===`);

  // ---- Arm E: parallelism headroom on a single item ----
  await warm([text]);
  const soloRuns = [];
  for (let r = 0; r < REPS; r++) soloRuns.push(await timed([text]));
  const soloWall = median(soloRuns.map((x) => x.wallMs));
  const soloRatio = median(soloRuns.map((x) => x.ratio));
  console.log(`  E solo x1        wall=${soloWall.toFixed(1)}ms  cpu/wall=${soloRatio.toFixed(2)}x`);

  // ---- Arm D: batch of BD IDENTICAL vs BD sequential (zero padding) ----
  // BD is token-budgeted, not fixed at 16: at 2048 tok a B=16 arm is the
  // already-measured 30-minute thrash case and would tell us nothing new.
  const BD = Math.max(2, Math.min(16, Math.floor(SWEEP_TOKEN_BUDGET / n)));
  console.log(`  (arm D batch size = ${BD}, token-budgeted)`);
  const batch16 = Array.from({ length: BD }, () => text);
  // Warm BOTH shapes we are about to time: the solo shape (used by the
  // sequential arm) and the batched shape. Warming only one biases the
  // comparison — the confound that sank tmp-diagnose.mjs.
  await warm([text], 1);
  await warm(batch16, 1);

  const seqRuns = [];
  for (let r = 0; r < REPS; r++) {
    const c0 = process.cpuUsage();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < BD; i++) await extractor([text], opts);
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const c1 = process.cpuUsage(c0);
    seqRuns.push({ wallMs, ratio: (c1.user + c1.system) / 1000 / wallMs });
  }
  const seqWall = median(seqRuns.map((x) => x.wallMs));

  const batRuns = [];
  for (let r = 0; r < REPS; r++) batRuns.push(await timed(batch16));
  const batWall = median(batRuns.map((x) => x.wallMs));
  const batRatio = median(batRuns.map((x) => x.ratio));

  console.log(`  D seq xBD       wall=${seqWall.toFixed(1)}ms  (${(seqWall / BD).toFixed(1)}ms/chunk)`);
  console.log(`  D batch-BD ident wall=${batWall.toFixed(1)}ms  (${(batWall / BD).toFixed(1)}ms/chunk)  cpu/wall=${batRatio.toFixed(2)}x`);
  console.log(`  ==> batching speedup at ${n} tok: ${(seqWall / batWall).toFixed(2)}x  ${seqWall > batWall ? '(batch WINS)' : '(batch LOSES)'}`);

  // ---- Batch-size sweep, identical text (no padding) ----
  const sweep = {};
  for (const B of [1, 2, 4, 8, 16, 32]) {
    if (B * n > SWEEP_TOKEN_BUDGET) {
      console.log(`    B=${String(B).padStart(2)}  SKIPPED (B*tokens=${B * n} > budget ${SWEEP_TOKEN_BUDGET})`);
      continue;
    }
    const texts = Array.from({ length: B }, () => text);
    await warm(texts, 1);
    const runs = [];
    for (let r = 0; r < REPS; r++) runs.push(await timed(texts));
    const w = median(runs.map((x) => x.wallMs));
    sweep[B] = { wallMs: +w.toFixed(1), perChunkMs: +(w / B).toFixed(2) };
    console.log(`    B=${String(B).padStart(2)}  wall=${w.toFixed(1).padStart(9)}ms  perChunk=${(w / B).toFixed(2).padStart(8)}ms  rssMB=${(process.memoryUsage().rss / 1e6).toFixed(0)}`);
  }

  out.arms[n] = {
    tokens: n,
    soloWallMs: +soloWall.toFixed(1),
    soloCpuWallRatio: +soloRatio.toFixed(2),
    seq16WallMs: +seqWall.toFixed(1),
    batch16WallMs: +batWall.toFixed(1),
    batchSpeedup: +(seqWall / batWall).toFixed(2),
    sweep,
  };
}

out.maxRssKB = process.resourceUsage().maxRSS;
console.log('\n=== JSON ===');
console.log(JSON.stringify(out, null, 2));
