// E1-AB — the run driver: 30 runs across 3 blocks, 4 arms and 3 rungs.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-AB PRE-REGISTRATION (2026-08-13),
// as amended by AMENDMENT 1. Gates 0/1/3/P inherited from E1 and E1-PHASE
// unchanged (imported, never re-implemented); Gate A and the strengthened Gate
// P2 are new here.
//
// Usage (run from packages/mast, never the repo root — HANDOFF §7):
//   node eval/e1-ab-run.mjs --dry-run       print the schedule and exit
//   node eval/e1-ab-run.mjs --limit 1       the next pending run, then exit (smoke)
//   node eval/e1-ab-run.mjs                 the full schedule, resumable
//
// Resumable, on its OWN journal. It never appends to `e1-runs.jsonl` or
// `e1-phase-runs.jsonl`: those are the scored records of completed experiments.
//
// NO CALIBRATION STEP, deliberately. E1 and E1-PHASE each measured an
// empty-corpus constant `c` because they fitted an exponent on adjusted
// `durationMs`. Every statistic here is either a within-rung RATIO or a
// write-phase slope, and `c` enters neither. Measuring it anyway would leave an
// unused number lying in an artifact, which is an invitation to post-hoc use.

import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E1_ROOT, RESULTS_DIR, assertGate0, assertCorpusPinned, materialiseTier,
  runColdIndex, readIndexedPaths, writeResult,
} from './e1-common.mjs';
import { gate3Verdict, remainingAttempts, selectFitted, orphanedAttempts } from './e1-schedule.mjs';
import { gatePVerdict } from './e1-phase-schedule.mjs';
import {
  AB_ARMS_BY_ID, AB_TIERS, AB_TOTAL_RUNS, AB_BLOCKS, AB_ORDERING,
  buildAbSchedule, gateAVerdict, abStateDirName,
} from './e1-ab-schedule.mjs';
import { foldJournal, planPending, selectAbRuns, gateP2, abKey } from './e1-ab-report.mjs';

const JOURNAL = join(RESULTS_DIR, 'e1-ab-runs.jsonl');
const SCHEDULE = join(RESULTS_DIR, 'e1-ab-schedule.json');
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

const log = (...a) => console.log(...a);

/** Read the journal. The fold — including RR6's dequeue — lives in the report module, and is tested. */
function loadJournal() {
  if (!existsSync(JOURNAL)) {
    return { records: [], done: new Map(), voids: new Map(), orphans: [], truncated: false };
  }
  const lines = readFileSync(JOURNAL, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  const records = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      if (i === lines.length - 1) { truncated = true; continue; }
      throw new Error(`Journal line ${i + 1} is unparseable and is not the trailing line — ${JOURNAL} is corrupt.`);
    }
  }
  return { records, ...foldJournal(records), orphans: orphanedAttempts(records, abKey), truncated };
}

function journal(rec) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(JOURNAL, JSON.stringify(rec) + '\n');
}

/** Reuse E1's hardlink tier trees, rebuilding only on a manifest mismatch. */
function materialiseTiers(manifest, n8nWorktree) {
  mkdirSync(TIER_ROOT, { recursive: true });
  const roots = {};
  for (const name of AB_TIERS) {
    const tier = manifest.tiers[name];
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

/** One scored cell: Gate 3's retakes, then Gate A and Gate P on the fitted attempt. */
async function executeCell(cell, ctx) {
  const { arm, tier, block } = cell;
  const spec = AB_ARMS_BY_ID[arm];
  const stateDir = join(E1_ROOT, abStateDirName(arm, tier, block));
  const manifestTier = ctx.manifest.tiers[tier];
  const projectRoot = ctx.tierRoots[tier];

  // Re-asserted per run: the tier trees are hardlinks into the n8n worktree, so
  // an in-place write there would change their content mid-schedule (A4-MAT-4).
  assertCorpusPinned('n8n');

  const spent = ctx.orphansByKey.get(abKey(cell)) ?? 0;
  const budget = remainingAttempts(spent);
  if (budget === 0) {
    const rec = { type: 'void', arm, tier, block, attempt: spent,
      reason: 'retake_cap_exhausted_by_interruptions', measurement: null, at: new Date().toISOString() };
    journal(rec);
    return rec;
  }

  const attempts = [];
  for (let attempt = 1; attempt <= budget; attempt++) {
    journal({ type: 'attempt_start', arm, tier, block, attempt, at: new Date().toISOString() });

    const run = await runColdIndex({ projectRoot, stateDir, extraArgs: spec.extraArgs });

    if (run.write_errors > 0) {
      const rec = { type: 'void', arm, tier, block, attempt, reason: 'write_errors',
        write_errors: run.write_errors, measurement: run, at: new Date().toISOString() };
      journal(rec);
      return rec;
    }

    // GATE A — arm identity, checked BEFORE Gate 3's retake logic. A run whose
    // pragmas did not take effect is not a slow or fast measurement of this arm;
    // it is a measurement of a different arm, and retaking it would just produce
    // more of the wrong thing.
    const ga = gateAVerdict({ arm, pragmas: run.pragmas });
    if (!ga.ok) {
      const rec = { type: 'void', arm, tier, block, attempt, reason: `gate_a_${ga.reason}`,
        gate_a: ga, measurement: run, at: new Date().toISOString() };
      journal(rec);
      return rec;
    }

    assertTierFileSet(run, manifestTier, tier);

    const g3 = gate3Verdict({ externalMs: run.external_ms, durationMs: run.duration_ms });
    attempts.push({ attempt, duration_ms: run.duration_ms, external_ms: run.external_ms,
      phase_ms: run.phase_ms, gate3: g3 });

    if (g3.ok || attempt === budget) {
      // A4-MAT-6. `selectFitted` keeps the clock and its decomposition on ONE
      // attempt — without it a thrice-failing cell would divide a warm attempt's
      // phases by a cold attempt's total.
      const fitted = selectFitted(run, attempts, g3.ok);

      const gp = gatePVerdict({ phaseMs: fitted.phase_ms, durationMs: fitted.duration_ms });
      if (!gp.ok) {
        const rec = { type: 'void', arm, tier, block, attempt, reason: `gate_p_${gp.reason}`,
          gate_p: gp, measurement: run, at: new Date().toISOString() };
        journal(rec);
        return rec;
      }

      const rec = {
        type: 'run', arm, tier, block, at: new Date().toISOString(),
        // The primary series. E1-PHASE measured write at 94.01% of the clock at
        // T9, which is why the ratio is taken on it and not on duration_ms.
        write_ms: fitted.phase_ms.write,
        duration_ms: fitted.duration_ms,
        external_ms: fitted.external_ms,
        phase_ms: fitted.phase_ms,
        chunk_count: run.chunk_count, file_count: run.file_count,
        symbol_count: run.symbol_count, edge_count: run.edge_count,
        // Reported as a FINDING, never a gate: the run-to-run determinism of
        // this number has not been measured, and Gate P's precedent is that a
        // threshold with no measurement behind it does not belong here.
        db_bytes: run.db_bytes,
        parse_errors: run.parse_errors,
        pragmas: run.pragmas, extra_args: run.extra_args,
        gate_a: ga, gate3: g3, gate3_attempts: attempts,
        gate3_finding: g3.ok ? null : `Gate 3 failed on all ${attempts.length} attempts; first attempt retained.`,
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
    process.stdout.write('Usage: node eval/e1-ab-run.mjs [--dry-run] [--limit <n>]\n');
    return;
  }

  log('[E1-AB] GATE 0 — binary identity');
  const gate0 = assertGate0();
  log(`     schema_version : ${gate0.schema_version}`);
  log(`     dist hash      : ${gate0.dist_hash}`);
  log(`     node           : ${gate0.node_version}`);
  log('     NOTE: this hash has MOVED since E1-PHASE (ef8d83e added the tuning');
  log('           parameter). Absolute timings here are NOT comparable to the');
  log("           15-run ladder's. Both arms share this binary, which is what");
  log('           keeps the A/B internally valid.');

  const manifest = JSON.parse(readFileSync(join(RESULTS_DIR, 'e1-tiers.json'), 'utf-8'));
  const schedule = buildAbSchedule();

  if (!existsSync(SCHEDULE)) {
    writeResult('e1-ab-schedule.json', {
      created: new Date().toISOString(), gate0, ordering: AB_ORDERING,
      total_runs: AB_TOTAL_RUNS, blocks: AB_BLOCKS, tiers: AB_TIERS, schedule,
    });
    log(`[E1-AB] wrote ${SCHEDULE} (schedule + binary pin)`);
  } else {
    const pinned = JSON.parse(readFileSync(SCHEDULE, 'utf-8'));
    if (pinned.gate0.dist_hash !== gate0.dist_hash) {
      throw new Error(
        `GATE 0 FAILED (A4-MAT-2): dist/ has changed since this schedule was committed.\n` +
        `  committed: ${pinned.gate0.dist_hash}\n  now:       ${gate0.dist_hash}\n` +
        `Completed runs measured different code than the remaining ones would. Resuming is ` +
        `VOID pending an explicit re-decision.`
      );
    }
    if (JSON.stringify(pinned.schedule) !== JSON.stringify(schedule)) {
      throw new Error('The committed schedule does not match the one just built — the seed or arm list moved.');
    }
  }

  if (opts.dryRun) {
    for (const c of schedule) {
      const spec = AB_ARMS_BY_ID[c.arm];
      log(`  ${String(c.slot).padStart(2)}. block ${c.block}  ${c.tier.padEnd(3)} arm ${c.arm} ` +
          `${spec.label.padEnd(15)} ${spec.extraArgs.join(' ') || '(no flags)'}`);
    }
    return;
  }

  const { done, voids, orphans, truncated } = loadJournal();
  if (truncated) log('[E1-AB] FINDING: journal ends in a partial line — an attempt was interrupted mid-write.');
  for (const o of orphans) {
    log(`[E1-AB] FINDING: ${o.key} attempt ${o.attempt} started at ${o.at} and never completed — re-attempting, flagged.`);
  }
  const orphansByKey = new Map();
  for (const o of orphans) orphansByKey.set(o.key, (orphansByKey.get(o.key) ?? 0) + 1);

  const n8n = assertCorpusPinned('n8n');
  const tierRoots = materialiseTiers(manifest, n8n);
  const ctx = { manifest, tierRoots, orphansByKey };

  const pending = planPending(schedule, { done, voids });
  log(`[E1-AB] ${done.size} complete, ${voids.size} unresolved void, ${pending.length} to run of ${AB_TOTAL_RUNS}`);

  let ran = 0;
  for (const cell of pending) {
    if (ran >= opts.limit) break;
    const spec = AB_ARMS_BY_ID[cell.arm];
    const t0 = Date.now();
    log(`[E1-AB] block ${cell.block}  ${cell.tier}  arm ${cell.arm} (${spec.label})` +
        `${cell.reason === 'repair_pair' ? '  [re-paired, AMENDMENT 2]' : ''}`);
    const rec = await executeCell(cell, ctx);
    ran++;

    if (rec.type === 'void') {
      log(`      VOID — ${rec.reason}; the whole (${cell.tier}, block ${cell.block}) group re-runs`);
      continue;
    }
    log(`      ${rec.chunk_count} chunks  write ${rec.write_ms} ms  total ${rec.duration_ms} ms  ` +
        `db ${(rec.db_bytes / 1048576).toFixed(1)} MiB  ` +
        `(wall ${Math.round((Date.now() - t0) / 1000)}s)${rec.gate3.ok ? '' : '  [Gate 3 finding]'}`);
    log(`      pragmas ${JSON.stringify(rec.pragmas)}`);

    // Every state dir is removed. At T9 each is ~420 MiB and there are nine of
    // them; the registration's cost line promises peak transient disk of ONE.
    // Nothing downstream reads these — `db_bytes` and the counts are already in
    // the record — unlike E1 and E1-PHASE, whose rep-3 dirs Gate 6 sequences
    // later work to read.
    rmSync(rec.measurement.state_dir, { recursive: true, force: true });
  }

  summarise();
}

/** Post-schedule checks that are cross-run by nature and cannot live inside one run. */
function summarise() {
  const { records, orphans } = loadJournal();
  const sel = selectAbRuns(records);
  const p2 = gateP2(sel.runs);

  log('');
  log(`[E1-AB] ${sel.runs.length}/${AB_TOTAL_RUNS} scoreable runs, ` +
      `${sel.voids.size} unresolved void, ${sel.resolved_voids.length} resolved, ${orphans.length} interrupted`);

  const findings = [];
  for (const [k, v] of sel.voids) findings.push(`VOID ${k}: ${v.reason}`);
  for (const r of sel.resolved_voids) findings.push(`VOID RESOLVED ${r.key}: was ${r.void_reason}, re-run clean`);
  for (const s of sel.superseded) findings.push(`SUPERSEDED ${s.key}: re-paired control replaced the stale record (AMENDMENT 2)`);
  for (const o of orphans) {
    findings.push(`INTERRUPTED ${o.key}: attempt started ${o.at} never completed; re-attempted warmer and charged against the retake cap.`);
  }
  for (const r of sel.runs) if (!r.gate3.ok) findings.push(`Gate 3 ${abKey(r)}: ${r.gate3_finding}`);
  for (const row of p2) {
    if (row.runs === row.expected && !row.identical) {
      findings.push(`GATE P2 ${row.tier}: chunk counts ${row.chunk_counts.join(' != ')} across arms`);
    }
  }

  // Reported, not gated — see the run record's `db_bytes` comment.
  for (const tier of AB_TIERS) {
    const sizes = sel.runs.filter((r) => r.tier === tier).map((r) => r.db_bytes);
    if (sizes.length < 2) continue;
    const spread = (Math.max(...sizes) - Math.min(...sizes)) / Math.min(...sizes);
    if (spread > 0.01) {
      findings.push(`DB SIZE ${tier}: graph.db differs by ${(spread * 100).toFixed(2)}% across arms — the arms may not have done identical work`);
    }
  }

  writeResult('e1-ab-runs-summary.json', {
    created: new Date().toISOString(),
    complete: sel.complete, total: AB_TOTAL_RUNS,
    unresolved_voids: [...sel.voids.keys()],
    resolved_voids: sel.resolved_voids,
    superseded: sel.superseded,
    poisoned_pairs: sel.poisoned_pairs,
    gate_p2: p2,
    findings,
    scoreable: sel.scoreable && p2.every((r) => r.identical),
  });

  if (findings.length === 0) log('[E1-AB] no findings');
  else for (const f of findings) log(`[E1-AB] FINDING: ${f}`);
  log(`[E1-AB] scoreable: ${sel.scoreable && p2.every((r) => r.identical)}`);
}

main().catch((err) => {
  console.error(`\n[E1-AB] FAILED: ${err.message}`);
  process.exitCode = 1;
});
