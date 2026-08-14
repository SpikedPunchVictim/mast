// E1-FTS — the run driver: 30 runs across 3 blocks, 2 arms and 5 rungs.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-FTS PRE-REGISTRATION (2026-08-14),
// as amended by AMENDMENT 1 (four spans became six) and AMENDMENT 2 (`b_rest`
// is blocking; the T9 share is read off the median run). Gates 0/1/3/P are
// inherited from E1 and E1-PHASE unchanged — IMPORTED, never re-implemented.
// The TILING gate and the DATABASE IDENTITY gate are new here.
//
// Usage (run from packages/mast, never the repo root — HANDOFF §7):
//   node eval/e1-fts-run.mjs --dry-run     print the schedule and exit
//   node eval/e1-fts-run.mjs --limit 2     the next pending runs, then exit (smoke)
//   node eval/e1-fts-run.mjs               the full schedule, resumable
//
// Resumable, on its OWN journal. It never appends to `e1-runs.jsonl`,
// `e1-phase-runs.jsonl` or `e1-ab-runs.jsonl`: those are the scored records of
// completed experiments.
//
// NO CALIBRATION STEP, for E1-AB's reason: every statistic here is a within-rung
// ratio or a log-log slope, and the empty-corpus constant `c` enters neither.
// Measuring it anyway would leave an unused number in an artifact, which is an
// invitation to post-hoc use.

import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E1_ROOT, RESULTS_DIR, assertGate0, assertCorpusPinned, materialiseTier,
  runColdIndex, readIndexedPaths, writeResult,
} from './e1-common.mjs';
import { gate3Verdict, remainingAttempts, selectFitted, orphanedAttempts } from './e1-schedule.mjs';
import { gatePVerdict } from './e1-phase-schedule.mjs';
import {
  FTS_ARMS_BY_ID, FTS_TIERS, FTS_TOTAL_RUNS, FTS_BLOCKS, FTS_ORDERING, WRITE_SPANS,
  buildFtsSchedule, tilingVerdict, armIdentityVerdict, ftsStateDirName,
} from './e1-fts-schedule.mjs';
import {
  foldJournal, planPending, selectFtsRuns, chunkIdentityRows, dbIdentityRows, ftsKey,
} from './e1-fts-report.mjs';

const JOURNAL = join(RESULTS_DIR, 'e1-fts-runs.jsonl');
const SCHEDULE = join(RESULTS_DIR, 'e1-fts-schedule.json');
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

/** Read the journal. The fold lives in the report module, and is tested. */
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
      // Only the LAST line may be partial — that is an interrupted append. A
      // corrupt line anywhere else means the file was damaged, and silently
      // skipping it would drop a real measurement from the record.
      if (i === lines.length - 1) { truncated = true; continue; }
      throw new Error(`Journal line ${i + 1} is unparseable and is not the trailing line — ${JOURNAL} is corrupt.`);
    }
  }
  return { records, ...foldJournal(records), orphans: orphanedAttempts(records, ftsKey), truncated };
}

function journal(rec) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(JOURNAL, JSON.stringify(rec) + '\n');
}

/** Reuse E1's hardlink tier trees, rebuilding only on a manifest mismatch. */
function materialiseTiers(manifest, n8nWorktree) {
  mkdirSync(TIER_ROOT, { recursive: true });
  const roots = {};
  for (const name of FTS_TIERS) {
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

/** One scored cell: Gate 3's retakes, then Gate P and the TILING gate on the fitted attempt. */
async function executeCell(cell, ctx) {
  const { arm, tier, block } = cell;
  const spec = FTS_ARMS_BY_ID[arm];
  const stateDir = join(E1_ROOT, ftsStateDirName(arm, tier, block));
  const manifestTier = ctx.manifest.tiers[tier];
  const projectRoot = ctx.tierRoots[tier];

  // Re-asserted per run: the tier trees are hardlinks into the n8n worktree, so
  // an in-place write there would change their content mid-schedule (A4-MAT-4).
  assertCorpusPinned('n8n');

  const spent = ctx.orphansByKey.get(ftsKey(cell)) ?? 0;
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

    // ARM IDENTITY, checked BEFORE Gate 3's retake logic — Gate A's lesson,
    // carried over in the only form available here. E1-AB could echo the
    // pragmas SQLite actually applied; a boolean flag has no such echo, so the
    // check is that the flag reached the process at all AND that its one
    // observable consequence holds: arm G must report exactly zero delete time,
    // and the control must report more than zero. A run whose flag silently did
    // not take effect is not a slow or fast measurement of this arm — it is a
    // measurement of the OTHER arm, and retaking it would produce more of the
    // wrong thing. Without this the two arms would be identical and the
    // experiment would return a clean, credible-looking null.
    const ident = armIdentityVerdict({ arm, spans: run.write_spans, extraArgs: run.extra_args });
    if (!ident.ok) {
      const rec = { type: 'void', arm, tier, block, attempt, reason: `arm_identity_${ident.reason}`,
        arm_identity: ident, measurement: run, at: new Date().toISOString() };
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
      // phases by a cold attempt's total. The spans belong to the same attempt
      // for the same reason, so they are taken from `run` only when the fitted
      // attempt IS this run.
      const fitted = selectFitted(run, attempts, g3.ok);
      const spansAreFitted = fitted.duration_ms === run.duration_ms;

      const gp = gatePVerdict({ phaseMs: fitted.phase_ms, durationMs: fitted.duration_ms });
      if (!gp.ok) {
        const rec = { type: 'void', arm, tier, block, attempt, reason: `gate_p_${gp.reason}`,
          gate_p: gp, measurement: run, at: new Date().toISOString() };
        journal(rec);
        return rec;
      }

      // GATE — TILING. The six spans must account for >= 95% of the write phase.
      // This is the gate AMENDMENT 1 exists because of: built to the four
      // originally-registered spans it read 0.746 on a real build, and whatever
      // is unattributed cannot be ruled out as the carrier of the exponent —
      // which is the entire question this experiment asks.
      const gt = tilingVerdict({ spans: run.write_spans, writeMs: fitted.phase_ms.write });
      if (!gt.ok) {
        const rec = { type: 'void', arm, tier, block, attempt, reason: `gate_tiling_${gt.reason}`,
          gate_tiling: gt, measurement: run, at: new Date().toISOString() };
        journal(rec);
        return rec;
      }

      const rec = {
        type: 'run', arm, tier, block, at: new Date().toISOString(),
        // The primary series. E1-PHASE measured write at 94.01% of the clock at
        // T9, which is why every ratio is taken on it and not on duration_ms.
        write_ms: fitted.phase_ms.write,
        write_spans: run.write_spans,
        duration_ms: fitted.duration_ms,
        external_ms: fitted.external_ms,
        phase_ms: fitted.phase_ms,
        chunk_count: run.chunk_count, file_count: run.file_count,
        symbol_count: run.symbol_count, edge_count: run.edge_count,
        // A GATE here, unlike E1-AB where it was a finding. Arm G's whole claim
        // to being confound-free is that it changed no bytes; graded per pair in
        // `dbIdentityRows`.
        db_bytes: run.db_bytes,
        parse_errors: run.parse_errors,
        extra_args: run.extra_args,
        arm_identity: ident, gate3: g3, gate3_attempts: attempts,
        gate3_finding: g3.ok ? null : `Gate 3 failed on all ${attempts.length} attempts; first attempt retained.`,
        // Stated in the record rather than left for a reader to reconstruct: a
        // Gate 3 retake can make the fitted CLOCK come from a different attempt
        // than the spans, and a reader comparing spans against `write_ms` needs
        // to know when that happened.
        spans_from_fitted_attempt: spansAreFitted,
        gate_p: gp, gate_tiling: gt,
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
    process.stdout.write('Usage: node eval/e1-fts-run.mjs [--dry-run] [--limit <n>]\n');
    return;
  }

  log('[E1-FTS] GATE 0 — binary identity');
  const gate0 = assertGate0();
  log(`     schema_version : ${gate0.schema_version}`);
  log(`     dist hash      : ${gate0.dist_hash}`);
  log(`     node           : ${gate0.node_version}`);
  log('     NOTE: this hash has MOVED since E1-AB (the write-span instrument and');
  log('           the delete-skip flag). Absolute timings here are NOT comparable');
  log('           to E1, E1-PHASE or E1-AB. Both arms share this binary, which is');
  log('           what keeps the comparison internally valid.');

  const manifest = JSON.parse(readFileSync(join(RESULTS_DIR, 'e1-tiers.json'), 'utf-8'));
  const schedule = buildFtsSchedule();

  if (!existsSync(SCHEDULE)) {
    writeResult('e1-fts-schedule.json', {
      created: new Date().toISOString(), gate0, ordering: FTS_ORDERING,
      total_runs: FTS_TOTAL_RUNS, blocks: FTS_BLOCKS, tiers: FTS_TIERS,
      write_spans: WRITE_SPANS, schedule,
    });
    log(`[E1-FTS] wrote ${SCHEDULE} (schedule + binary pin)`);
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
      throw new Error('The committed schedule does not match the one just built — the arm list or ladder moved.');
    }
    // AMENDMENT 1 added two spans. A schedule pinned before that would silently
    // grade runs against a four-span tiling gate the binary no longer matches.
    if (JSON.stringify(pinned.write_spans) !== JSON.stringify(WRITE_SPANS)) {
      throw new Error(
        `The committed span list does not match the current one — AMENDMENT 1 changed what the\n` +
        `  tiling gate measures.\n  committed: ${JSON.stringify(pinned.write_spans)}\n` +
        `  now:       ${JSON.stringify(WRITE_SPANS)}`
      );
    }
  }

  if (opts.dryRun) {
    for (const c of schedule) {
      const spec = FTS_ARMS_BY_ID[c.arm];
      log(`  ${String(c.slot).padStart(2)}. block ${c.block}  ${c.tier.padEnd(3)} arm ${c.arm} ` +
          `${spec.label.padEnd(18)} ${spec.extraArgs.join(' ') || '(no flags)'}`);
    }
    return;
  }

  const { done, voids, orphans, truncated } = loadJournal();
  if (truncated) log('[E1-FTS] FINDING: journal ends in a partial line — an attempt was interrupted mid-write.');
  for (const o of orphans) {
    log(`[E1-FTS] FINDING: ${o.key} attempt ${o.attempt} started at ${o.at} and never completed — re-attempting, flagged.`);
  }
  const orphansByKey = new Map();
  for (const o of orphans) orphansByKey.set(o.key, (orphansByKey.get(o.key) ?? 0) + 1);

  const n8n = assertCorpusPinned('n8n');
  const tierRoots = materialiseTiers(manifest, n8n);
  const ctx = { manifest, tierRoots, orphansByKey };

  const pending = planPending(schedule, { done, voids });
  log(`[E1-FTS] ${done.size} complete, ${voids.size} unresolved void, ${pending.length} to run of ${FTS_TOTAL_RUNS}`);

  let ran = 0;
  for (const cell of pending) {
    if (ran >= opts.limit) break;
    const spec = FTS_ARMS_BY_ID[cell.arm];
    const t0 = Date.now();
    log(`[E1-FTS] block ${cell.block}  ${cell.tier}  arm ${cell.arm} (${spec.label})` +
        `${cell.reason === 'repair_pair' ? '  [re-paired]' : ''}`);
    const rec = await executeCell(cell, ctx);
    ran++;

    if (rec.type === 'void') {
      log(`      VOID — ${rec.reason}; the whole (${cell.tier}, block ${cell.block}) pair re-runs`);
      continue;
    }
    const s = rec.write_spans;
    log(`      ${rec.chunk_count} chunks  write ${rec.write_ms} ms  total ${rec.duration_ms} ms  ` +
        `db ${(rec.db_bytes / 1048576).toFixed(1)} MiB  (wall ${Math.round((Date.now() - t0) / 1000)}s)` +
        `${rec.gate3.ok ? '' : '  [Gate 3 finding]'}`);
    log(`      spans  ${WRITE_SPANS.map((k) => `${k} ${Math.round(s[k])}`).join('  ')}` +
        `   tiling ${rec.gate_tiling.tiling.toFixed(3)}`);

    // Every state dir is removed. At T9 each is ~420 MiB and there are thirty
    // runs; the registration's cost line promises peak transient disk of ONE.
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
  const sel = selectFtsRuns(records);
  const chunkRows = chunkIdentityRows(sel.runs);
  const dbRows = dbIdentityRows(sel.runs);

  log('');
  log(`[E1-FTS] ${sel.runs.length}/${FTS_TOTAL_RUNS} scoreable runs, ` +
      `${sel.voids.size} unresolved void, ${sel.resolved_voids.length} resolved, ${orphans.length} interrupted`);

  const findings = [];
  for (const [k, v] of sel.voids) findings.push(`VOID ${k}: ${v.reason}`);
  for (const r of sel.resolved_voids) findings.push(`VOID RESOLVED ${r.key}: was ${r.void_reason}, re-run clean`);
  for (const s of sel.superseded) findings.push(`SUPERSEDED ${s.key}: a re-paired run replaced the stale record`);
  for (const o of orphans) {
    findings.push(`INTERRUPTED ${o.key}: attempt started ${o.at} never completed; re-attempted warmer and charged against the retake cap.`);
  }
  for (const r of sel.runs) if (!r.gate3.ok) findings.push(`Gate 3 ${ftsKey(r)}: ${r.gate3_finding}`);
  for (const r of sel.runs) {
    if (r.spans_from_fitted_attempt === false) {
      findings.push(`SPAN/CLOCK ${ftsKey(r)}: Gate 3 retakes made the fitted clock a different attempt than the spans.`);
    }
  }
  for (const row of chunkRows) {
    if (row.runs > 0 && !row.identical) {
      findings.push(`CHUNK IDENTITY ${row.tier}: chunk counts ${row.chunk_counts.join(' != ')} across arms — the arms indexed different corpora`);
    }
  }
  // The gate that makes arm G confound-free. A failure here is not a finding to
  // weigh against others; it means the arm measured something else.
  for (const row of dbRows) {
    if (row.pending !== true && !row.ok) {
      findings.push(
        `GATE DB IDENTITY ${row.tier} b${row.block}: ${row.reason} ` +
        `(A ${row.arm_a_bytes} vs G ${row.arm_g_bytes}, delta ${row.delta_bytes})`
      );
    }
  }

  // Pending pairs are excluded here rather than counted as failures — see
  // `dbIdentityRows`. `sel.scoreable` separately requires all 30 runs, so no
  // pair can slip past the gate by still being pending in the final state.
  const gatesOk = chunkRows.every((r) => r.runs === 0 || r.identical)
    && dbRows.every((r) => r.pending === true || r.ok);
  const scoreable = sel.scoreable && gatesOk;

  writeResult('e1-fts-runs-summary.json', {
    created: new Date().toISOString(),
    complete: sel.complete, total: FTS_TOTAL_RUNS,
    unresolved_voids: [...sel.voids.keys()],
    resolved_voids: sel.resolved_voids,
    superseded: sel.superseded,
    poisoned_pairs: sel.poisoned_pairs,
    chunk_identity: chunkRows,
    db_identity: dbRows,
    findings,
    scoreable,
  });

  if (findings.length === 0) log('[E1-FTS] no findings');
  else for (const f of findings) log(`[E1-FTS] FINDING: ${f}`);
  log(`[E1-FTS] scoreable: ${scoreable}`);
}

main().catch((err) => {
  console.error(`\n[E1-FTS] FAILED: ${err.message}`);
  process.exitCode = 1;
});
