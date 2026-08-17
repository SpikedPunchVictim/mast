// E1-VERIFY — re-run E1's 9-rung ladder against the FTS delete guard.
//
// Required by IMPLEMENTATION_PLAN.md § E1-FTS RESULT, "Not shipped on the
// strength of this": arm G was a rehearsal of the guard, and the guard itself
// is accepted only by re-running E1's full ladder against the COMMITTED scorer
// and the IMMUTABLE 1.35 threshold.
//
// A SEPARATE driver from `e1-run.mjs`, and this one is not a style choice. That
// driver appends to `e1-runs.jsonl` — E1's scored record of a completed
// experiment — and its Gate 0 pin would refuse this binary outright. Everything
// this needs from E1 it IMPORTS unchanged: the tier list, the repetition count,
// the schedule's seeded order, Gate 3, the retake budget, `selectFitted`,
// `median`. Nothing in `e1-schedule.mjs` or `e1-score.mjs` is modified.
//
// SCOPE, stated plainly rather than left to be noticed: this runs the 9-rung
// LADDER, not E1's 5-corpus PANEL. The registration's condition names the
// ladder, and E1's own verdict records the panel as `panel_supporting_only` —
// it supports the reachability argument, not the exponent. The panel is
// therefore out of scope here, and no claim is made about it.
//
// Usage (run from packages/mast, never the repo root):
//   node eval/e1-verify-run.mjs --dry-run
//   node eval/e1-verify-run.mjs --limit 2
//   node eval/e1-verify-run.mjs

import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E1_ROOT, RESULTS_DIR, assertGate0, assertCorpusPinned, materialiseTier,
  runColdIndex, readIndexedPaths, writeResult,
} from './e1-common.mjs';
import {
  TIERS, REPS, buildSchedule, gate3Verdict, remainingAttempts, selectFitted,
  orphanedAttempts, median,
} from './e1-schedule.mjs';

const JOURNAL = join(RESULTS_DIR, 'e1-verify-runs.jsonl');
const SCHEDULE = join(RESULTS_DIR, 'e1-verify-schedule.json');
const CALIBRATION = join(RESULTS_DIR, 'e1-verify-calibration.json');
const TIER_ROOT = join(E1_ROOT, 'tiers');
const EMPTY_CORPUS = join(E1_ROOT, 'verify-empty-corpus');
const CALIBRATION_RUNS = 10;

/** Ladder only — E1's seeded order preserved for the tier subset. */
const LADDER = buildSchedule().filter((c) => c.kind === 'tier')
  .map((c, i) => ({ ...c, slot: i + 1 }));
const TOTAL = TIERS.length * REPS;

const log = (...a) => console.log(...a);
const key = (r) => `${r.corpus}#r${r.rep}`;

function parseArgs(argv) {
  const o = { limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--recalibrate') o.recalibrate = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

function loadJournal() {
  if (!existsSync(JOURNAL)) return { records: [], done: new Map(), voids: new Map(), orphans: [] };
  const lines = readFileSync(JOURNAL, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    try { records.push(JSON.parse(lines[i])); } catch {
      if (i === lines.length - 1) continue;
      throw new Error(`Journal line ${i + 1} is unparseable and is not the trailing line — ${JOURNAL} is corrupt.`);
    }
  }
  const done = new Map();
  const voids = new Map();
  for (const r of records) {
    if (r.type === 'run') { done.set(key(r), r); voids.delete(key(r)); }
    else if (r.type === 'void') { voids.set(key(r), r); done.delete(key(r)); }
  }
  return { records, done, voids, orphans: orphanedAttempts(records, key) };
}

const journal = (rec) => {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(JOURNAL, JSON.stringify(rec) + '\n');
};

/**
 * E1's calibration, re-measured.
 *
 * `c` is `runIndex`'s fixed cost with zero indexing work in it, and `scoreE1`
 * subtracts it before fitting. It MUST be re-measured here: E1's stored `c` was
 * taken on a different binary, and E1's own driver treats a moved dist hash as
 * grounds to void a resume for exactly this reason. Left stale, a wrong additive
 * constant biases the exponent — and it biases it DOWNWARD, toward the answer
 * this run wants, which is the direction that must never be taken on trust.
 */
async function calibrate(gate0) {
  log(`[calib] ${CALIBRATION_RUNS} runs against an empty corpus`);
  if (existsSync(EMPTY_CORPUS)) rmSync(EMPTY_CORPUS, { recursive: true, force: true });
  mkdirSync(EMPTY_CORPUS, { recursive: true });

  const runs = [];
  for (let i = 1; i <= CALIBRATION_RUNS; i++) {
    const r = await runColdIndex({ projectRoot: EMPTY_CORPUS, stateDir: join(E1_ROOT, 'verify-calib-state') });
    if (r.chunk_count !== 0 || r.file_count !== 0) {
      throw new Error(`Calibration corpus is not empty: ${r.file_count} files, ${r.chunk_count} chunks.`);
    }
    runs.push(r.duration_ms);
  }
  const c = median(runs);
  const record = {
    created: new Date().toISOString(), gate0, n: CALIBRATION_RUNS,
    durations_ms: runs, c_ms: c, min_ms: Math.min(...runs), max_ms: Math.max(...runs),
    why_remeasured:
      'E1\'s stored c was taken on a different binary. A stale additive constant biases the ' +
      'exponent DOWNWARD — toward the answer this run wants — so it is re-measured, not reused.',
  };
  writeFileSync(CALIBRATION, JSON.stringify(record, null, 2) + '\n');
  log(`[calib] c = ${c} ms (median of ${CALIBRATION_RUNS}; range ${record.min_ms}-${record.max_ms})`);
  return record;
}

function materialiseTiers(manifest, n8nWorktree) {
  mkdirSync(TIER_ROOT, { recursive: true });
  const roots = {};
  for (const name of TIERS) {
    const tier = manifest.tiers[name];
    const root = join(TIER_ROOT, name);
    const sidecar = `${root}.manifest.json`;
    const want = { tier: name, file_count: tier.file_count, chunk_count: tier.chunk_count, seed: manifest.seed };
    if (existsSync(sidecar) && existsSync(root) &&
        readFileSync(sidecar, 'utf-8') === JSON.stringify(want)) { roots[name] = root; continue; }
    log(`[tiers] materialising ${name} (${tier.file_count} files)`);
    materialiseTier(n8nWorktree, tier.files, root);
    writeFileSync(sidecar, JSON.stringify(want));
    roots[name] = root;
  }
  return roots;
}

/** Gate 1's tier clause (A4-MAT-4). */
function assertTierFileSet(run, tier, name) {
  const got = readIndexedPaths(run.state_dir);
  const want = [...tier.files].sort();
  if (got.length !== want.length) {
    throw new Error(`GATE 1 FAILED (${name}): indexed ${got.length} files, manifest says ${want.length}.`);
  }
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) {
      throw new Error(`GATE 1 FAILED (${name}): file set diverges at '${got[i]}' != '${want[i]}'.`);
    }
  }
}

async function executeCell(cell, ctx) {
  const { corpus, rep } = cell;
  const stateDir = join(E1_ROOT, `e1v-run-${corpus}-r${rep}`);
  assertCorpusPinned('n8n');

  const budget = remainingAttempts(ctx.orphansByKey.get(key(cell)) ?? 0);
  if (budget === 0) {
    const rec = { type: 'void', corpus, rep, reason: 'retake_cap_exhausted_by_interruptions', at: new Date().toISOString() };
    journal(rec);
    return rec;
  }

  const attempts = [];
  for (let attempt = 1; attempt <= budget; attempt++) {
    journal({ type: 'attempt_start', corpus, rep, attempt, at: new Date().toISOString() });
    const run = await runColdIndex({ projectRoot: ctx.tierRoots[corpus], stateDir });

    if (run.write_errors > 0) {
      const rec = { type: 'void', corpus, rep, attempt, reason: 'write_errors', measurement: run, at: new Date().toISOString() };
      journal(rec);
      return rec;
    }
    assertTierFileSet(run, ctx.manifest.tiers[corpus], corpus);

    const g3 = gate3Verdict({ externalMs: run.external_ms, durationMs: run.duration_ms });
    attempts.push({ attempt, duration_ms: run.duration_ms, external_ms: run.external_ms, phase_ms: run.phase_ms, gate3: g3 });

    if (g3.ok || attempt === budget) {
      const fitted = selectFitted(run, attempts, g3.ok);
      const rec = {
        type: 'run', kind: 'tier', corpus, rep, at: new Date().toISOString(),
        duration_ms: fitted.duration_ms, external_ms: fitted.external_ms, phase_ms: fitted.phase_ms,
        write_spans: run.write_spans,
        chunk_count: run.chunk_count, file_count: run.file_count,
        symbol_count: run.symbol_count, edge_count: run.edge_count,
        chunk_fts_count: run.chunk_fts_count, identifier_fts_count: run.identifier_fts_count,
        db_bytes: run.db_bytes, parse_errors: run.parse_errors,
        gate3: g3, gate3_attempts: attempts,
        gate3_finding: g3.ok ? null : `Gate 3 failed on all ${attempts.length} attempts; first attempt retained.`,
        measurement: run,
      };
      journal(rec);
      return rec;
    }
    log(`      Gate 3 miss (delta ${g3.delta_ms} ms > ${Math.round(g3.allowance_ms)} ms) — retaking`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write('Usage: node eval/e1-verify-run.mjs [--dry-run] [--limit <n>] [--recalibrate]\n'); return; }

  log('[E1-VERIFY] GATE 0 — binary identity');
  const gate0 = assertGate0();
  log(`     dist hash      : ${gate0.dist_hash}`);
  log('     This binary carries the FTS delete guard. Absolute timings are NOT');
  log("     comparable to E1's original ladder; the EXPONENT is what is compared,");
  log('     and it is scored by E1\'s own committed scorer against 1.35.');

  const manifest = JSON.parse(readFileSync(join(RESULTS_DIR, 'e1-tiers.json'), 'utf-8'));

  if (!existsSync(SCHEDULE)) {
    writeResult('e1-verify-schedule.json', {
      created: new Date().toISOString(), gate0, total_runs: TOTAL, reps: REPS,
      tiers: TIERS, scope: 'ladder_only_panel_out_of_scope', schedule: LADDER,
    });
    log(`[E1-VERIFY] wrote ${SCHEDULE}`);
  } else {
    const pinned = JSON.parse(readFileSync(SCHEDULE, 'utf-8'));
    if (pinned.gate0.dist_hash !== gate0.dist_hash) {
      throw new Error(
        `GATE 0 FAILED: dist/ has changed since this schedule was committed.\n` +
        `  committed: ${pinned.gate0.dist_hash}\n  now:       ${gate0.dist_hash}\n` +
        `Completed runs measured different code than the remaining ones would.`);
    }
  }

  if (opts.dryRun) {
    for (const c of LADDER) log(`  ${String(c.slot).padStart(2)}. ${c.corpus} rep ${c.rep}`);
    return;
  }

  const calibration = (!existsSync(CALIBRATION) || opts.recalibrate)
    ? await calibrate(gate0)
    : JSON.parse(readFileSync(CALIBRATION, 'utf-8'));
  if (calibration.gate0.dist_hash !== gate0.dist_hash) {
    throw new Error(
      `GATE 0 FAILED: c was calibrated on a different binary (${calibration.gate0.dist_hash}). ` +
      `Re-run with --recalibrate.`);
  }
  log(`[E1-VERIFY] c = ${calibration.c_ms} ms`);

  const { done, voids, orphans } = loadJournal();
  const orphansByKey = new Map();
  for (const o of orphans) orphansByKey.set(o.key, (orphansByKey.get(o.key) ?? 0) + 1);

  const n8n = assertCorpusPinned('n8n');
  const ctx = { manifest, tierRoots: materialiseTiers(manifest, n8n), orphansByKey };

  const pending = LADDER.filter((c) => !done.has(key(c)) || voids.has(key(c)));
  log(`[E1-VERIFY] ${done.size} complete, ${voids.size} void, ${pending.length} to run of ${TOTAL}`);

  let ran = 0;
  for (const cell of pending) {
    if (ran >= opts.limit) break;
    const t0 = Date.now();
    log(`[E1-VERIFY] ${cell.corpus} rep ${cell.rep}`);
    const rec = await executeCell(cell, ctx);
    ran++;
    if (rec.type === 'void') { log(`      VOID — ${rec.reason}`); continue; }
    const s = rec.write_spans ?? {};
    log(`      ${rec.chunk_count} chunks  total ${rec.duration_ms} ms  write ${rec.phase_ms.write} ms  ` +
        `fts_del ${Math.round(s.fts_del ?? 0)} ms  db ${(rec.db_bytes / 1048576).toFixed(1)} MiB  ` +
        `(wall ${Math.round((Date.now() - t0) / 1000)}s)`);
    rmSync(rec.measurement.state_dir, { recursive: true, force: true });
  }

  const after = loadJournal();
  log('');
  log(`[E1-VERIFY] ${after.done.size}/${TOTAL} runs, ${after.voids.size} void`);
  log(`[E1-VERIFY] score with: node eval/e1-verify-score.mjs`);
}

main().catch((err) => {
  console.error(`\n[E1-VERIFY] FAILED: ${err.message}`);
  process.exitCode = 1;
});
