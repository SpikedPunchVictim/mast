// E1-LADDER — the run driver: 27 scored runs across the full nine-rung ladder, one arm.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-LADDER PRE-REGISTRATION (2026-08-17), Gates
// 0/0b/1/3/P/P2/L, with A4-MAT-3 (attempt journaling), A4-MAT-4 (tier verification),
// A4-MAT-6 (retake semantics) and A4-MAT-7 (the VOID queue) inherited from E1 unchanged.
//
// Usage (run from packages/mast, never the repo root — FINDINGS.md §5):
//   node eval/e1-ladder-run.mjs --dry-run      print the schedule and exit
//   node eval/e1-ladder-run.mjs                the 27 runs
//   node eval/e1-ladder-run.mjs --limit 1      the next pending run, then exit (smoke)
//
// Resumable, on its OWN journal. It never appends to `e1-runs.jsonl`, `e1-phase-runs.jsonl`
// or `e1-verify-runs.jsonl`: those are scored records of completed experiments.
//
// NO CALIBRATION STEP, on purpose. `c` is `runIndex`'s fixed cost and it lands inside the
// `walk` phase (schema DDL, lock-marker init and the empty walk all precede the first phase
// boundary — see E1-PHASE's calibration TSDoc). The outcome here is `phase_ms.edges`, which
// `c` does not touch. Measuring an unused constant invites post-hoc use.

import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E1_ROOT, RESULTS_DIR, assertGate0, assertCorpusPinned, materialiseTier,
  runColdIndex, readIndexedPaths, writeResult,
} from './e1-common.mjs';
import { REPS, gate3Verdict, orphanedAttempts, remainingAttempts, selectFitted }
  from './e1-schedule.mjs';
import {
  LADDER_TIERS, LADDER_TOTAL_RUNS, buildLadderSchedule, gatePVerdict, ladderStateDirName,
} from './e1-ladder-schedule.mjs';

const JOURNAL = join(RESULTS_DIR, 'e1-ladder-runs.jsonl');
const SCHEDULE = join(RESULTS_DIR, 'e1-ladder-schedule.json');
const TIER_ROOT = join(E1_ROOT, 'tiers');

function parseArgs(argv) {
  const o = { limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

const key = (r) => `${r.corpus}#${r.rep}`;
const log = (...a) => console.log(...a);

/** Read the journal, distinguishing completed pairs, voids, and killed attempts (A4-MAT-3). */
function loadJournal() {
  const done = new Map(), voids = new Map(), records = [];
  if (!existsSync(JOURNAL)) return { done, voids, records, orphans: [], truncated: false };

  const lines = readFileSync(JOURNAL, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      if (i === lines.length - 1) { truncated = true; continue; }
      throw new Error(`Journal line ${i + 1} is unparseable and is not the trailing line — ${JOURNAL} is corrupt.`);
    }
    records.push(rec);
    if (rec.type === 'run') done.set(key(rec), rec);
    else if (rec.type === 'void') voids.set(key(rec), rec);
  }

  return { done, voids, records, orphans: orphanedAttempts(records), truncated };
}

function journal(rec) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(JOURNAL, JSON.stringify(rec) + '\n');
}

/**
 * Reuse the nine hardlink tier trees E1 materialised, rebuilding only on a manifest mismatch.
 *
 * The sidecar records the exact frozen-manifest record, so a tree with the right FILE COUNT
 * and the wrong contents is refused rather than reused.
 */
function materialiseTiers(manifest, n8nWorktree) {
  mkdirSync(TIER_ROOT, { recursive: true });
  const roots = {};
  for (const name of LADDER_TIERS) {
    const tier = manifest.tiers[name];
    if (!tier) throw new Error(`e1-tiers.json has no rung '${name}' — the manifest cannot serve this ladder.`);
    const root = join(TIER_ROOT, name);
    const sidecar = `${root}.manifest.json`;
    const want = { tier: name, file_count: tier.file_count, chunk_count: tier.chunk_count, seed: manifest.seed };

    if (existsSync(sidecar) && existsSync(root) &&
        readFileSync(sidecar, 'utf-8') === JSON.stringify(want)) {
      roots[name] = root;
      continue;
    }
    log(`[tiers] materialising ${name} (${tier.file_count} files)`);
    materialiseTier(n8nWorktree, tier.files, root);
    writeFileSync(sidecar, JSON.stringify(want));
    roots[name] = root;
  }
  return roots;
}

/** Gate 1's tier clause (A4-MAT-4): what this run indexed must be exactly the frozen rung. */
function assertTierFileSet(run, tier, name) {
  const got = readIndexedPaths(run.state_dir);
  const want = [...tier.files].sort();
  if (got.length !== want.length) {
    throw new Error(`GATE 1 FAILED (${name}): indexed ${got.length} files, manifest says ${want.length}.`);
  }
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) {
      throw new Error(`GATE 1 FAILED (${name}): file set diverges from the manifest at '${got[i]}' != '${want[i]}'.`);
    }
  }
}

/** One scored run: Gate 3's retakes, then Gate P on the fitted attempt. */
async function executeRun(entry, ctx) {
  const { corpus, rep, kind } = entry;
  const stateDir = join(E1_ROOT, ladderStateDirName(corpus, rep));
  const tier = ctx.manifest.tiers[corpus];

  // Every tier run re-asserts the n8n pin: the tier trees are hardlinks into that worktree,
  // so an in-place write there would change their content mid-schedule (A4-MAT-4).
  const projectRoot = ctx.tierRoots[corpus];
  assertCorpusPinned('n8n');

  const spent = ctx.orphansByKey?.get(`${corpus}#${rep}`) ?? 0;
  const budget = remainingAttempts(spent);
  if (budget === 0) {
    const rec = { type: 'void', corpus, tier: corpus, rep, kind, attempt: spent,
      reason: 'retake_cap_exhausted_by_interruptions', measurement: null, at: new Date().toISOString() };
    journal(rec);
    return rec;
  }

  const attempts = [];
  for (let attempt = 1; attempt <= budget; attempt++) {
    journal({ type: 'attempt_start', corpus, tier: corpus, rep, attempt, at: new Date().toISOString() });

    const run = await runColdIndex({ projectRoot, stateDir });

    if (run.write_errors > 0) {
      const rec = { type: 'void', corpus, tier: corpus, rep, kind, attempt, reason: 'write_errors',
        write_errors: run.write_errors, measurement: run, at: new Date().toISOString() };
      journal(rec);
      return rec;
    }

    assertTierFileSet(run, tier, corpus);

    const g3 = gate3Verdict({ externalMs: run.external_ms, durationMs: run.duration_ms });
    attempts.push({ attempt, duration_ms: run.duration_ms, external_ms: run.external_ms,
      phase_ms: run.phase_ms, gate3: g3 });

    if (g3.ok || attempt === budget) {
      // A4-MAT-6. `selectFitted` keeps the clock and its decomposition on ONE attempt: without
      // it a thrice-failing pair would divide a warm attempt's phases by a cold attempt's
      // total, mis-firing Gate P and mixing attempts inside a fitted point.
      const fitted = selectFitted(run, attempts, g3.ok);

      const gp = gatePVerdict({ phaseMs: fitted.phase_ms, durationMs: fitted.duration_ms });
      if (!gp.ok) {
        const rec = { type: 'void', corpus, tier: corpus, rep, kind, attempt, reason: `gate_p_${gp.reason}`,
          gate_p: gp, measurement: run, at: new Date().toISOString() };
        journal(rec);
        return rec;
      }

      const rec = {
        type: 'run', corpus, rep, kind, at: new Date().toISOString(),
        chunk_count: run.chunk_count, file_count: run.file_count, duration_ms: fitted.duration_ms,
        external_ms: fitted.external_ms, phase_ms: fitted.phase_ms,
        db_bytes: run.db_bytes, parse_errors: run.parse_errors,
        symbol_count: run.symbol_count, edge_count: run.edge_count,
        potential_call_count: run.potential_call_count,
        // BOTH keys, deliberately. FINDINGS.md §1 records that `e1-verify` rows carry the rung
        // only as `corpus`, so grouping its runs by `tier` silently collapses nine rungs into
        // one bucket and a median then returns T5's value while looking ladder-wide. Writing
        // both means neither convention can produce that failure against this journal.
        tier: corpus,
        gate3: g3, gate3_attempts: attempts,
        gate3_finding: g3.ok ? null : `Gate 3 failed on all ${attempts.length} attempts; first attempt retained in the fit.`,
        gate_p: gp,
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
  if (opts.help) {
    process.stdout.write('Usage: node eval/e1-ladder-run.mjs [--dry-run] [--limit <n>]\n');
    return;
  }

  log('[E1-LADDER] GATE 0 — binary identity');
  const gate0 = assertGate0();
  log(`     schema_version : ${gate0.schema_version}`);
  log(`     dist hash      : ${gate0.dist_hash}`);
  log(`     node           : ${gate0.node_version}`);

  const manifest = JSON.parse(readFileSync(join(RESULTS_DIR, 'e1-tiers.json'), 'utf-8'));
  const schedule = buildLadderSchedule();

  if (!existsSync(SCHEDULE)) {
    writeResult('e1-ladder-schedule.json', {
      created: new Date().toISOString(), gate0, total_runs: LADDER_TOTAL_RUNS, reps: REPS,
      tiers: LADDER_TIERS, schedule,
    });
    log(`[E1-LADDER] wrote ${SCHEDULE} (schedule + binary pin)`);
  } else {
    const pinned = JSON.parse(readFileSync(SCHEDULE, 'utf-8'));
    if (pinned.gate0.dist_hash !== gate0.dist_hash) {
      throw new Error(
        `GATE 0 FAILED (A4-MAT-2): dist/ has changed since this schedule was committed.\n` +
        `  committed: ${pinned.gate0.dist_hash}\n  now:       ${gate0.dist_hash}\n` +
        `The completed runs measured different code than the remaining ones would. ` +
        `Resuming is VOID pending an explicit re-decision.`
      );
    }
    if (JSON.stringify(pinned.schedule) !== JSON.stringify(schedule)) {
      throw new Error('The committed schedule does not match the one just built — the seed or rung list moved.');
    }
  }

  if (opts.dryRun) {
    for (const e of schedule) log(`  ${String(e.slot).padStart(2)}. ${e.kind.padEnd(5)} ${key(e)}`);
    return;
  }

  const { done, voids, orphans, truncated } = loadJournal();
  if (truncated) log('[E1-LADDER] FINDING: journal ends in a partial line — an attempt was interrupted mid-write.');
  for (const o of orphans) {
    log(`[E1-LADDER] FINDING: ${o.key} attempt ${o.attempt} started at ${o.at} and never completed — re-attempting, flagged.`);
  }

  const orphansByKey = new Map();
  for (const o of orphans) orphansByKey.set(o.key, (orphansByKey.get(o.key) ?? 0) + 1);

  const n8n = assertCorpusPinned('n8n');
  const tierRoots = materialiseTiers(manifest, n8n);
  const ctx = { manifest, tierRoots, orphansByKey };

  const pending = schedule.filter((e) => !done.has(key(e)));
  log(`[E1-LADDER] ${done.size} complete, ${voids.size} void, ${pending.length} pending of ${LADDER_TOTAL_RUNS}`);

  let ran = 0;
  for (const entry of pending) {
    if (ran >= opts.limit) break;
    const t0 = Date.now();
    log(`[E1-LADDER] slot ${String(entry.slot).padStart(2)}/${LADDER_TOTAL_RUNS}  ${key(entry)}`);
    const rec = await executeRun(entry, ctx);
    ran++;

    if (rec.type === 'void') {
      log(`      VOID — ${rec.reason}; queued for re-run (A4-MAT-7)`);
      continue;
    }
    log(`      ${rec.chunk_count} chunks  ${rec.duration_ms} ms  edges ${rec.phase_ms.edges} ms  ` +
        `attribution ${(rec.gate_p.attribution * 100).toFixed(2)}%  ` +
        `(wall ${Math.round((Date.now() - t0) / 1000)}s)${rec.gate3.ok ? '' : '  [Gate 3 finding]'}`);

    // NO state dir is retained. E1 retained rep-3 dirs because Gate 6 sequences R3/R4/E2/R5
    // read them; nothing downstream reads E1-LADDER's, and nine retained graph.db files
    // (T9 alone indexes 13,330 files) is real disk for no reader.
    rmSync(rec.measurement.state_dir, { recursive: true, force: true });
  }

  summarise();
}

/** Post-schedule checks that are cross-run by nature and cannot live inside one run. */
function summarise() {
  const { done, voids, orphans } = loadJournal();
  log('');
  log(`[E1-LADDER] ${done.size}/${LADDER_TOTAL_RUNS} complete, ${voids.size} void, ${orphans.length} interrupted`);

  const findings = [];
  for (const [k, v] of voids) findings.push(`VOID ${k}: ${v.reason}`);
  for (const o of orphans) {
    findings.push(`INTERRUPTED ${o.key}: attempt started ${o.at} never completed; re-attempted warmer and charged against the retake cap.`);
  }
  for (const [k, r] of done) if (!r.gate3.ok) findings.push(`Gate 3 ${k}: ${r.gate3_finding}`);

  // Gate P2 — a rung's three repetitions must report identical chunk_count.
  const byCorpus = new Map();
  for (const r of done.values()) {
    if (!byCorpus.has(r.corpus)) byCorpus.set(r.corpus, []);
    byCorpus.get(r.corpus).push(r);
  }
  const repIdentity = [];
  for (const [corpus, rs] of byCorpus) {
    const counts = [...new Set(rs.map((r) => r.chunk_count))];
    const ok = counts.length === 1;
    repIdentity.push({ corpus, reps: rs.length, chunk_counts: counts, identical: ok });
    if (rs.length === REPS && !ok) findings.push(`GATE P2 ${corpus}: chunk counts ${counts.join(' != ')}`);
  }

  const summary = {
    created: new Date().toISOString(),
    complete: done.size, total: LADDER_TOTAL_RUNS, voids: [...voids.keys()],
    rep_identity: repIdentity,
    findings,
    // A thrice-failing Gate 3 run is logged and retained (A4-MAT-6), never a blocker.
    scoreable: done.size === LADDER_TOTAL_RUNS && voids.size === 0 &&
      repIdentity.every((r) => r.identical),
  };
  writeResult('e1-ladder-runs-summary.json', summary);

  if (findings.length === 0) log('[E1-LADDER] no findings');
  else for (const f of findings) log(`[E1-LADDER] FINDING: ${f}`);
  log(`[E1-LADDER] scoreable: ${summary.scoreable}`);
}

main().catch((err) => {
  console.error(`\n[E1-LADDER] FAILED: ${err.message}`);
  process.exitCode = 1;
});
