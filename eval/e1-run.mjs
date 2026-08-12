// E1 — the run driver: calibration, then the 42 scored runs.
//
// Registration: IMPLEMENTATION_PLAN.md § E1/E2 PRE-REGISTRATION, Gates 0/1/1b/3/5/6 and
// AMENDMENT 4 (A4-MAT-2 binary pinning, A4-MAT-3 attempt journaling, A4-MAT-4 tier
// verification, A4-MAT-6 retake semantics, A4-MAT-7 the VOID queue).
//
// Usage (run from packages/mast, never the repo root — HANDOFF §7):
//   node eval/e1-run.mjs --dry-run          print the schedule and exit
//   node eval/e1-run.mjs --calibrate-only   the 10 empty-corpus runs, then exit
//   node eval/e1-run.mjs                    calibration (if absent) + the 42 runs
//   node eval/e1-run.mjs --limit 2          the next 2 pending runs, then exit (smoke)
//
// This is resumable: re-running picks up where an interrupted schedule stopped. It is NOT
// idempotent by accident — see `loadJournal`, which distinguishes a completed run from an
// attempt that started and never finished, because those two must not be treated alike.

import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E1_ROOT, PINS, RESULTS_DIR, assertGate0, assertCorpusPinned, materialiseTier,
  runColdIndex, readIndexedPaths, writeResult,
} from './e1-common.mjs';
import {
  TIERS, REPS, TOTAL_RUNS, buildSchedule, gate3Verdict, retainStateDir, median, MAX_RETAKES,
  orphanedAttempts, remainingAttempts,
} from './e1-schedule.mjs';

const JOURNAL = join(RESULTS_DIR, 'e1-runs.jsonl');
const CALIBRATION = join(RESULTS_DIR, 'e1-calibration.json');
const SCHEDULE = join(RESULTS_DIR, 'e1-schedule.json');
const TIER_ROOT = join(E1_ROOT, 'tiers');
const EMPTY_CORPUS = join(E1_ROOT, 'empty-corpus');
const CALIBRATION_RUNS = 10;

function parseArgs(argv) {
  const o = { limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--calibrate-only') o.calibrateOnly = true;
    else if (a === '--recalibrate') o.recalibrate = true;
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

const key = (r) => `${r.corpus}#${r.rep}`;
const log = (...a) => console.log(...a);

/**
 * Read the journal, distinguishing three states a pair can be in.
 *
 * A4-MAT-3. "Skip completed pairs" is not enough: the likeliest interruption is an operator
 * killing a run that LOOKS HUNG — that is, a pathologically slow large-tier run, which is
 * the super-linear signal itself. If that leaves no trace, the re-attempt runs warmer and
 * only the faster take enters the fit, which censors exactly the evidence E1 exists to find.
 */
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
      // A partially-written trailing line is an interrupted attempt, never a completed pair
      // and never a hard failure. Anywhere else it is corruption and must stop the run.
      if (i === lines.length - 1) { truncated = true; continue; }
      throw new Error(`Journal line ${i + 1} is unparseable and is not the trailing line — ${JOURNAL} is corrupt.`);
    }
    records.push(rec);
    if (rec.type === 'run') done.set(key(rec), rec);
    else if (rec.type === 'void') voids.set(key(rec), rec);
  }

  // Orphans are counted, not tracked by presence-in-a-map. The earlier implementation
  // deleted the pending start when the pair finally completed, so an interrupted attempt
  // followed by a successful re-attempt — the T9 case that actually occurred, twice —
  // left no orphan at all. A4-MAT-3's finding must outlive the pair's completion.
  return { done, voids, records, orphans: orphanedAttempts(records), truncated };
}

function journal(rec) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(JOURNAL, JSON.stringify(rec) + '\n');
}

/** The 10 empty-corpus runs whose median is `c`. */
async function calibrate(gate0) {
  log(`[calib] ${CALIBRATION_RUNS} runs against an empty corpus`);
  if (existsSync(EMPTY_CORPUS)) rmSync(EMPTY_CORPUS, { recursive: true, force: true });
  mkdirSync(EMPTY_CORPUS, { recursive: true });

  const runs = [];
  for (let i = 1; i <= CALIBRATION_RUNS; i++) {
    const r = await runColdIndex({ projectRoot: EMPTY_CORPUS, stateDir: join(E1_ROOT, 'calib-state') });
    if (r.chunk_count !== 0 || r.file_count !== 0) {
      throw new Error(`Calibration corpus is not empty: ${r.file_count} files, ${r.chunk_count} chunks.`);
    }
    runs.push(r.duration_ms);
    log(`[calib]   ${String(i).padStart(2)}/${CALIBRATION_RUNS}  ${r.duration_ms} ms`);
  }

  const c = median(runs);
  const record = {
    created: new Date().toISOString(),
    gate0,
    n: CALIBRATION_RUNS,
    durations_ms: runs,
    c_ms: c,
    min_ms: Math.min(...runs),
    max_ms: Math.max(...runs),
    what_it_measures:
      "runIndex's own fixed cost with zero indexing work in it. `startMs` is runIndex's " +
      'FIRST statement (indexer/index.ts:173) and openDatabase is at :188, so the schema ' +
      'DDL, lock-marker init and an empty walk are all INSIDE this number — as the ' +
      "registration's calibration paragraph says, and contra Gate 3's rationale (A4-C1).",
    why_it_matters:
      'Left in, a fixed additive constant makes small runs look disproportionately expensive, ' +
      'which flattens the curve and biases b DOWNWARD — toward O(N) HOLDS.',
  };
  writeFileSync(CALIBRATION, JSON.stringify(record, null, 2) + '\n');
  log(`[calib] c = ${c} ms (median of ${CALIBRATION_RUNS}; range ${record.min_ms}-${record.max_ms})`);
  return record;
}

/** Build the 9 hardlink tier trees, with the sidecar manifest kept OUTSIDE each tree. */
function materialiseTiers(manifest, n8nWorktree) {
  mkdirSync(TIER_ROOT, { recursive: true });
  const roots = {};
  for (const name of TIERS) {
    const tier = manifest.tiers[name];
    const root = join(TIER_ROOT, name);
    const sidecar = `${root}.manifest.json`;
    const want = { tier: name, file_count: tier.file_count, chunk_count: tier.chunk_count, seed: manifest.seed };

    // Reuse only on an exact match. A tree with the right FILE COUNT but the wrong contents
    // is the failure this sidecar exists to refuse, so the check is the full record, and it
    // lives outside the tree so it can never be walked into a measurement.
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

/**
 * Gate 1's tier clause (A4-MAT-4): what this run indexed must be exactly the frozen rung.
 *
 * Catches three distinct failures with one query — a truncated or polluted tier tree, a
 * walker whose behaviour differs from the one that produced the cut, and in-place mutation
 * of the n8n worktree whose inodes the hardlink trees alias.
 */
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

/** One scored run, including Gate 3's retakes. Returns a completion or a void record. */
async function executeRun(entry, ctx) {
  const { corpus, rep, kind } = entry;
  const stateDir = join(E1_ROOT, `run-${corpus}-r${rep}`);   // per-(corpus, rep): a rep-1 run
  const isTier = kind === 'tier';                            // shuffled AFTER rep 3 must not
  const tier = isTier ? ctx.manifest.tiers[corpus] : null;   // wipe the retained artifact.

  // Every tier run re-asserts the n8n pin, because the tier trees are hardlinks into that
  // worktree and an in-place write there would change their content mid-schedule (A4-MAT-4).
  const projectRoot = isTier ? ctx.tierRoots[corpus] : assertCorpusPinned(corpus);
  if (isTier) assertCorpusPinned('n8n');

  // A4-MAT-3's second clause: attempts already killed on this pair are charged against the
  // cap. A fresh budget of three after every interruption is selective retention of fast
  // takes by another route — each re-spawn runs warmer than the one it replaces.
  const spent = ctx.orphansByKey?.get(`${corpus}#${rep}`) ?? 0;
  const budget = remainingAttempts(spent);
  if (budget === 0) {
    const rec = { type: 'void', corpus, rep, kind, attempt: spent,
      reason: 'retake_cap_exhausted_by_interruptions', measurement: null, at: new Date().toISOString() };
    journal(rec);
    return rec;
  }

  const attempts = [];
  for (let attempt = 1; attempt <= budget; attempt++) {
    journal({ type: 'attempt_start', corpus, rep, attempt, at: new Date().toISOString() });

    const run = await runColdIndex({ projectRoot, stateDir });

    // Trigger 2. Recorded and the schedule continues — aborting would throw away hours of
    // completed work — but the pair is NOT counted done, so it returns via the re-run queue.
    if (run.write_errors > 0) {
      const rec = { type: 'void', corpus, rep, kind, attempt, reason: 'write_errors',
        write_errors: run.write_errors, measurement: run, at: new Date().toISOString() };
      journal(rec);
      return rec;
    }

    if (isTier) assertTierFileSet(run, tier, corpus);

    const g3 = gate3Verdict({ externalMs: run.external_ms, durationMs: run.duration_ms });
    attempts.push({ attempt, duration_ms: run.duration_ms, external_ms: run.external_ms, gate3: g3 });

    if (g3.ok || attempt === budget) {
      // A4-MAT-6. On a third failure the FIRST attempt's data is what enters the fit, not
      // the last: Gate 3 polices the cross-check clock, which never enters the fit at all,
      // so discarding the fitted clock over it would be selective retention — and A1-F5's
      // own analysis says dropping slow small-tier takes biases the slope UP.
      const fitted = g3.ok ? run : { ...run, duration_ms: attempts[0].duration_ms, external_ms: attempts[0].external_ms };
      const rec = {
        type: 'run', corpus, rep, kind, at: new Date().toISOString(),
        chunk_count: run.chunk_count, file_count: run.file_count, duration_ms: fitted.duration_ms,
        external_ms: fitted.external_ms, db_bytes: run.db_bytes, parse_errors: run.parse_errors,
        symbol_count: run.symbol_count, edge_count: run.edge_count,
        potential_call_count: run.potential_call_count,
        tier: isTier ? corpus : null,
        gate3: g3, gate3_attempts: attempts,
        gate3_finding: g3.ok ? null : `Gate 3 failed on all ${attempts.length} attempts; first attempt retained in the fit.`,
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
    process.stdout.write(
      'Usage: node eval/e1-run.mjs [--dry-run] [--calibrate-only] [--recalibrate] [--limit <n>]\n');
    return;
  }

  log('[E1] GATE 0 — binary identity');
  const gate0 = assertGate0();
  log(`     schema_version : ${gate0.schema_version}`);
  log(`     dist hash      : ${gate0.dist_hash}`);
  log(`     node           : ${gate0.node_version}`);

  const manifest = JSON.parse(readFileSync(join(RESULTS_DIR, 'e1-tiers.json'), 'utf-8'));
  const schedule = buildSchedule();

  // Gate 5: the schedule is committed before measuring. A4-MAT-2 pins the binary INTO it,
  // so a rebuild mid-schedule cannot be resumed over silently.
  if (!existsSync(SCHEDULE)) {
    writeResult('e1-schedule.json', {
      created: new Date().toISOString(), gate0, total_runs: TOTAL_RUNS, reps: REPS, schedule,
    });
    log(`[E1] wrote ${SCHEDULE} (schedule + binary pin)`);
  } else {
    const pinned = JSON.parse(readFileSync(SCHEDULE, 'utf-8'));
    if (pinned.gate0.dist_hash !== gate0.dist_hash) {
      throw new Error(
        `GATE 0 FAILED (A4-MAT-2): dist/ has changed since this schedule was committed.\n` +
        `  committed: ${pinned.gate0.dist_hash}\n  now:       ${gate0.dist_hash}\n` +
        `The completed runs measured different code than the remaining ones would, and ` +
        `c was calibrated on the old binary. Resuming is VOID pending an explicit re-decision.`
      );
    }
    if (JSON.stringify(pinned.schedule) !== JSON.stringify(schedule)) {
      throw new Error('The committed schedule does not match the one just built — the seed or corpus list moved.');
    }
  }

  if (opts.dryRun) {
    for (const e of schedule) log(`  ${String(e.slot).padStart(2)}. ${e.kind.padEnd(5)} ${key(e)}`);
    return;
  }

  const calibration = (!existsSync(CALIBRATION) || opts.recalibrate)
    ? await calibrate(gate0)
    : JSON.parse(readFileSync(CALIBRATION, 'utf-8'));
  log(`[E1] calibration c = ${calibration.c_ms} ms`);
  if (opts.calibrateOnly) return;

  const { done, voids, orphans, truncated } = loadJournal();
  if (truncated) log('[E1] FINDING: journal ends in a partial line — an attempt was interrupted mid-write.');
  for (const o of orphans) {
    log(`[E1] FINDING: ${key(o)} attempt ${o.attempt} started at ${o.at} and never completed — re-attempting, flagged.`);
  }

  const orphansByKey = new Map();
  for (const o of orphans) orphansByKey.set(o.key, (orphansByKey.get(o.key) ?? 0) + 1);

  const n8n = assertCorpusPinned('n8n');
  const tierRoots = materialiseTiers(manifest, n8n);
  const ctx = { manifest, tierRoots, orphansByKey };

  const pending = schedule.filter((e) => !done.has(key(e)));
  log(`[E1] ${done.size} complete, ${voids.size} void, ${pending.length} pending of ${TOTAL_RUNS}`);

  let ran = 0;
  for (const entry of pending) {
    if (ran >= opts.limit) break;
    const t0 = Date.now();
    log(`[E1] slot ${String(entry.slot).padStart(2)}/${TOTAL_RUNS}  ${key(entry)} (${entry.kind})`);
    const rec = await executeRun(entry, ctx);
    ran++;

    if (rec.type === 'void') {
      log(`      VOID — ${rec.reason} (${rec.write_errors} write errors); queued for re-run`);
      continue;
    }
    log(`      ${rec.chunk_count} chunks  ${rec.duration_ms} ms  (wall ${Math.round((Date.now() - t0) / 1000)}s)` +
        `${rec.gate3.ok ? '' : '  [Gate 3 finding]'}`);

    // Registered retention. Keyed on the repetition NUMBER: the shuffle runs rep 3 before
    // rep 1 for several corpora, so "delete whichever ran last" would destroy the artifact
    // R3, R4, E2 and R5 all read (Gate 6).
    if (!retainStateDir(entry.rep)) rmSync(rec.measurement.state_dir, { recursive: true, force: true });
  }

  summarise(calibration);
}

/** Post-schedule checks that are cross-run by nature and cannot live inside one run. */
function summarise(calibration) {
  const { done, voids, orphans } = loadJournal();
  log('');
  log(`[E1] ${done.size}/${TOTAL_RUNS} complete, ${voids.size} void, ${orphans.length} interrupted`);

  const findings = [];
  for (const [k, v] of voids) findings.push(`VOID ${k}: ${v.reason}`);
  // A4-MAT-3. Persisted, not printed: the schedule's two interrupted T9 attempts reached
  // the console and nothing else, and were found afterwards by an external review.
  for (const o of orphans) {
    findings.push(`INTERRUPTED ${o.key}: attempt started ${o.at} never completed; re-attempted warmer and charged against the retake cap.`);
  }
  for (const [k, r] of done) if (!r.gate3.ok) findings.push(`Gate 3 ${k}: ${r.gate3_finding}`);

  // Registered: a tier's three repetitions must report IDENTICAL chunk_count; disagreement
  // is a nondeterminism finding that voids that tier pending diagnosis.
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
    if (rs.length === REPS && !ok) findings.push(`NONDETERMINISM ${corpus}: chunk counts ${counts.join(' != ')}`);
  }

  const summary = {
    created: new Date().toISOString(),
    complete: done.size, total: TOTAL_RUNS, voids: [...voids.keys()],
    calibration_c_ms: calibration.c_ms,
    rep_identity: repIdentity,
    findings,
    scoreable: done.size === TOTAL_RUNS && voids.size === 0 && findings.length === 0,
  };
  writeResult('e1-runs-summary.json', summary);

  if (findings.length === 0) log('[E1] no findings');
  else for (const f of findings) log(`[E1] FINDING: ${f}`);
  log(`[E1] scoreable: ${summary.scoreable}`);
}

main().catch((err) => {
  console.error(`\n[E1] FAILED: ${err.message}`);
  process.exitCode = 1;
});
