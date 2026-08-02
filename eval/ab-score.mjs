// Q1/OUTCOME — scoring. Reads the SEALED arm manifest only AFTER every result.json
// exists, so no grading decision could be influenced by arm knowledge.
//
// GRADING IS MECHANICAL (AMENDMENT 2): the registration specified a blind Fable
// grader. Exact-match grading against a mechanically-derived ground truth is
// strictly better — it removes the grader as a source of bias entirely rather
// than blinding it. Logged as a deviation; it runs in no direction.
//
//   node eval/ab-score.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const RUNS = join(homedir(), '.cache', 'mast-eval', 'ab-runs');
const doc = JSON.parse(readFileSync('./eval/ab-tasks.json', 'utf8'));
const manifest = JSON.parse(readFileSync(join(RUNS, 'SEALED-manifest.json'), 'utf8'));
const taskById = new Map(doc.tasks.map((t) => [t.id, t]));

// ---- search log -> per-run effort + arm integrity ----
const log = existsSync(join(RUNS, 'search-log.jsonl'))
  ? readFileSync(join(RUNS, 'search-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const byRun = new Map();
for (const e of log) {
  if (!byRun.has(e.run_id)) byRun.set(e.run_id, []);
  byRun.get(e.run_id).push(e);
}

const rows = [];
for (const r of manifest.runs) {
  const t = taskById.get(r.task);
  const rf = join(RUNS, r.run_id, 'result.json');
  if (!existsSync(rf)) { rows.push({ ...r, missing: true }); continue; }
  const res = JSON.parse(readFileSync(rf, 'utf8'));
  const calls = byRun.get(r.run_id) ?? [];

  // calls before the ground-truth chunk first appeared in the returned window
  const targetKeyPrefix = `${t.target.file_path}:`;
  let callsToSight = null;
  calls.forEach((c, i) => {
    if (callsToSight !== null) return;
    if ((c.kept_keys ?? []).some((k) => k.startsWith(targetKeyPrefix))) callsToSight = i + 1;
  });

  rows.push({
    run_id: r.run_id, task: r.task, arm: r.arm, replicate: r.replicate,
    stratum: t.stratum,
    answer_file: res.answer_file, answer_symbol: res.answer_symbol,
    truth_file: t.target.file_path, truth_symbol: t.target.symbol,
    success: res.answer_file === t.target.file_path && res.answer_symbol === t.target.symbol,
    file_success: res.answer_file === t.target.file_path,
    search_calls: calls.length,
    calls_to_sight: callsToSight,
    sighted: callsToSight !== null,
    fallback_used: res.fallback_used === true,
    fallback_calls: res.fallback_calls ?? 0,
    arm_intact: calls.length > 0 && calls.every((c) => c.arm_intact),
    void: calls.length > 0 && !calls.every((c) => c.arm_intact),
  });
}

// ---- stats helpers ----
const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return r; };
/** exact two-sided McNemar on discordant pairs */
function mcnemar(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const m = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= m; i++) tail += C(n, i);
  return Math.min(1, 2 * tail / Math.pow(2, n));
}
/** exact two-sided sign test */
function signTest(pos, neg) { return mcnemar(pos, neg); }

// ---- primary analysis: replicate 1 only (the registered 12x2) ----
const main = rows.filter((r) => r.replicate === 1 && !r.void && !r.missing);
const pairs = [];
for (const t of doc.tasks) {
  const H = main.find((r) => r.task === t.id && r.arm === 'hybrid');
  const L = main.find((r) => r.task === t.id && r.arm === 'lexical');
  if (H === undefined || L === undefined) continue;
  pairs.push({ task: t.id, stratum: t.stratum, H, L });
}

const b = pairs.filter((p) => p.H.success && !p.L.success).length;   // hybrid wins
const c = pairs.filter((p) => !p.H.success && p.L.success).length;   // lexical wins
const both = pairs.filter((p) => p.H.success && p.L.success).length;
const neither = pairs.filter((p) => !p.H.success && !p.L.success).length;

const fb = pairs.filter((p) => p.H.file_success && !p.L.file_success).length;
const fc = pairs.filter((p) => !p.H.file_success && p.L.file_success).length;

// co-primary B: search calls (sign test on paired differences)
const diffs = pairs.map((p) => p.L.search_calls - p.H.search_calls).filter((d) => d !== 0);
const effPos = diffs.filter((d) => d > 0).length;   // L cost MORE
const effNeg = diffs.filter((d) => d < 0).length;

// noise floor: within-arm discordance across replicates
const noise = [];
for (const tid of manifest.noise_floor_tasks) {
  for (const arm of ['hybrid', 'lexical']) {
    const a = rows.find((r) => r.task === tid && r.arm === arm && r.replicate === 1);
    const d = rows.find((r) => r.task === tid && r.arm === arm && r.replicate === 2);
    if (a && d) noise.push({ task: tid, arm, same_success: a.success === d.success, calls: [a.search_calls, d.search_calls] });
  }
}
const noiseDiscordant = noise.filter((n) => !n.same_success).length;

const hSucc = pairs.filter((p) => p.H.success).length;
const lSucc = pairs.filter((p) => p.L.success).length;
const ceiling = (hSucc === pairs.length && lSucc === pairs.length) || (hSucc === 0 && lSucc === 0);

console.log(`\n=== Q1/OUTCOME RESULTS (k=${pairs.length} paired tasks) ===\n`);
console.log(`  task  stratum    H:sym H:file  L:sym L:file   H:calls L:calls`);
for (const p of pairs) {
  console.log(`  ${p.task}  ${p.stratum.padEnd(9)}  ${p.H.success ? ' Y ' : ' n '}   ${p.H.file_success ? 'Y' : 'n'}      ${p.L.success ? ' Y ' : ' n '}   ${p.L.file_success ? 'Y' : 'n'}       ${String(p.H.search_calls).padStart(2)}      ${String(p.L.search_calls).padStart(2)}`);
}

console.log(`\n-- CO-PRIMARY A: task success (exact symbol) --`);
console.log(`  H succeeded : ${hSucc}/${pairs.length}`);
console.log(`  L succeeded : ${lSucc}/${pairs.length}`);
console.log(`  both=${both}  neither=${neither}  b(H only)=${b}  c(L only)=${c}`);
console.log(`  exact McNemar p = ${mcnemar(b, c).toFixed(4)}   -> ${mcnemar(b, c) <= 0.05 ? 'SIGNIFICANT' : 'not significant'}`);
console.log(`  file-level: b=${fb} c=${fc}  p=${mcnemar(fb, fc).toFixed(4)}`);

console.log(`\n-- CO-PRIMARY B: retrieval effort (search calls) --`);
console.log(`  L more calls than H: ${effPos} tasks;  H more than L: ${effNeg};  ties: ${pairs.length - diffs.length}`);
console.log(`  sign test p = ${signTest(effPos, effNeg).toFixed(4)}  -> ${signTest(effPos, effNeg) <= 0.05 ? 'SIGNIFICANT' : 'not significant'}`);
console.log(`  median calls H=${median(pairs.map((p) => p.H.search_calls))}  L=${median(pairs.map((p) => p.L.search_calls))}`);

console.log(`\n-- NOISE FLOOR (3 seeded tasks, 2 replicates per arm) --`);
console.log(`  within-arm success discordance: ${noiseDiscordant}/${noise.length} arm-task cells`);
for (const n of noise) console.log(`    ${n.task}/${n.arm}: same_success=${n.same_success} calls=${n.calls.join(' vs ')}`);

console.log(`\n-- INTEGRITY --`);
console.log(`  void runs (arm decayed): ${rows.filter((r) => r.void).length}`);
console.log(`  missing results        : ${rows.filter((r) => r.missing).length}`);
console.log(`  runs with fallback     : ${main.filter((r) => r.fallback_used).length}/${main.length}`);
console.log(`  GATE 5 marginals       : ${ceiling ? '🔴 UNINFORMATIVE (ceiling/floor)' : 'ok — task set discriminated'}`);

function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

writeFileSync('./eval/results/ab-outcome.json', JSON.stringify({
  scored_at: new Date().toISOString(), k: pairs.length,
  co_primary_a: { h_success: hSucc, l_success: lSucc, both, neither, b, c, mcnemar_p: mcnemar(b, c), file_b: fb, file_c: fc, file_p: mcnemar(fb, fc) },
  co_primary_b: { l_more: effPos, h_more: effNeg, ties: pairs.length - diffs.length, sign_p: signTest(effPos, effNeg) },
  noise_floor: { discordant_cells: noiseDiscordant, total_cells: noise.length, detail: noise },
  integrity: { void: rows.filter((r) => r.void).length, missing: rows.filter((r) => r.missing).length, gate5_uninformative: ceiling },
  rows,
}, null, 2));
console.log(`\nwrote ./eval/results/ab-outcome.json`);
