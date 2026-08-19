// E1-HOIST — the run driver: 40 runs across 2 arms, 1 rung and 20 blocks.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-HOIST PRE-REGISTRATION (2026-08-18).
//
// Cloned from `e1-hoist-run.mjs`, which is the two-arm precedent, rather than
// generalised out of it: E1-SCAN's 24 records are a scored artifact and must not sit
// behind a moving definition. Gates 1/3 are imported from E1 unchanged; Gates S1/S2
// (arm identity), C (correctness) and L (cross-experiment replication) are carried
// over with this experiment's own pins.
//
// ONE RUNG, TWENTY BLOCKS — the inverse of E1-SCAN's shape, and deliberately so. The
// effect here is a constant factor of ~3.6% at T9, measured before registration; the
// other rungs are omitted because they are unpowered, not because they are uninteresting
// (see the registration's power table). Blocks buy the precision that rungs cannot.
//
// Usage (run from packages/mast, never the repo root — HANDOFF §7):
//   node eval/e1-hoist-run.mjs --dry-run     print the schedule and exit
//   node eval/e1-hoist-run.mjs --limit 1     the next pending run, then exit (smoke)
//   node eval/e1-hoist-run.mjs               the full schedule, resumable
//
// Resumable, on its OWN journal. It never appends to any other experiment's record.
//
// THIS DRIVER RUNS FROM THE REPO but measures binaries in two detached worktrees.
// That inversion is deliberate and is the reason it does not import MAST_BIN from
// e1-common.mjs: that constant resolves `../dist/` relative to itself, so importing
// the harness from a worktree would silently measure that worktree for everything,
// including the arm it was not supposed to be. Here the arm's binary is passed
// explicitly per run and the harness's own MAST_BIN is never used.
//
// NO CALIBRATION STEP. Every statistic is a within-rung ratio between two arms, and
// the empty-corpus constant `c` cancels in a ratio. Measuring it anyway would leave
// an unused number in an artifact, which is an invitation to post-hoc use — E1-AB's
// reasoning, carried over.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import {
  E1_ROOT, RESULTS_DIR, assertCorpusPinned, materialiseTier, readIndexedPaths,
  readGraphCounts, readWalBoundary, readIndexMeta, parseDurationMs, parsePhaseMs,
  parseWriteSpans, parsePragmas, isBuildInput, writeResult, ColdIndexFailure,
} from './e1-common.mjs';
import { REPS, gate3Verdict, orphanedAttempts, remainingAttempts, selectFitted } from './e1-schedule.mjs';
import { median } from './e1-schedule.mjs';
import {
  HOIST_ARMS, HOIST_TIERS, HOIST_TOTAL_RUNS, HOIST_BLOCKS, EXPECTED_ARM_DELTA,
  GATE_L_SCAN_ARM_R_T9_EDGES, GATE_L_BAND, buildHoistSchedule, hoistKey, hoistStateDirName,
  gatePVerdict,
} from './e1-hoist-schedule.mjs';

const JOURNAL = join(RESULTS_DIR, 'e1-hoist-runs.jsonl');
const SCHEDULE = join(RESULTS_DIR, 'e1-hoist-schedule.json');
const TIER_ROOT = join(E1_ROOT, 'tiers');

const log = (...a) => console.log(...a);

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

/**
 * Content hash over an arm's `dist/`, keyed by path RELATIVE to `dist/`.
 *
 * NOT `e1-common.mjs`'s `distContentHash`, and the difference is load-bearing: that
 * one folds the ABSOLUTE path of every file into the digest, so two builds of
 * identical source at two filesystem locations necessarily disagree. Comparing arms
 * across worktrees is exactly what this experiment does, so the path must be
 * relative — while still being included, so an added or deleted file still moves the
 * hash.
 *
 * @returns {{rel_hash: string, n_files: number, per_file: Map<string,string>}}
 */
export function armDistHash(pkgRoot) {
  const distRoot = join(pkgRoot, 'dist');
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(distRoot);
  files.sort((a, b) => (relative(distRoot, a) < relative(distRoot, b) ? -1 : 1));

  const h = createHash('sha256');
  const perFile = new Map();
  for (const p of files) {
    const rel = relative(distRoot, p);
    const bytes = readFileSync(p);
    h.update(rel);
    h.update(bytes);
    perFile.set(rel, createHash('sha256').update(bytes).digest('hex'));
  }
  return { rel_hash: h.digest('hex'), n_files: files.length, per_file: perFile };
}

/** GATE 0b, per arm — the arm's dist must not be older than its own src. */
function assertArmNotStale(pkgRoot) {
  const srcRoot = join(pkgRoot, 'src');
  let newestSrc = 0, newestSrcFile = null;
  const walkSrc = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walkSrc(p); continue; }
      if (!isBuildInput(p)) continue;
      const m = statSync(p).mtimeMs;
      if (m > newestSrc) { newestSrc = m; newestSrcFile = p; }
    }
  };
  walkSrc(srcRoot);

  let newestDist = 0;
  const walkDist = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walkDist(p); continue; }
      if (!p.endsWith('.js')) continue;
      const m = statSync(p).mtimeMs;
      if (m > newestDist) newestDist = m;
    }
  };
  walkDist(join(pkgRoot, 'dist'));

  if (newestSrc > newestDist) {
    throw new Error(
      `GATE 0b FAILED in ${pkgRoot}: dist/ is older than src/ by ` +
      `${Math.round((newestSrc - newestDist) / 1000)} s (newest source ${newestSrcFile}). ` +
      `The binary is not the code. Rebuild that worktree.`
    );
  }
  return { newest_src_file: newestSrcFile, src_newer_by_ms: 0 };
}

/**
 * GATE S1 (arm identity) + GATE S2 (arm delta).
 *
 * A hard stop, never a VOID: a run against the wrong binary is not a noisy
 * measurement of this arm, it is a measurement of a different one, and retaking it
 * produces more of the wrong thing. Gate A's reasoning in E1-AB, applied to a
 * manipulation that lives in the build rather than in a pragma.
 */
function assertArmIdentity(arms) {
  const observed = {};
  for (const arm of arms) {
    const got = armDistHash(arm.pkgRoot);
    if (got.rel_hash !== arm.rel_hash) {
      throw new Error(
        `GATE S1 FAILED (arm ${arm.id}): dist rel-hash is ${got.rel_hash}, ` +
        `registration pins ${arm.rel_hash}. That worktree is not the arm it claims to be.`
      );
    }
    assertArmNotStale(arm.pkgRoot);
    observed[arm.id] = got;
  }

  const [a, b] = arms.map((x) => observed[x.id]);
  const keys = new Set([...a.per_file.keys(), ...b.per_file.keys()]);
  const diff = [...keys].filter((k) => a.per_file.get(k) !== b.per_file.get(k)).sort();
  const expected = [...EXPECTED_ARM_DELTA].sort();
  if (JSON.stringify(diff) !== JSON.stringify(expected)) {
    throw new Error(
      `GATE S2 FAILED: the arms differ in ${diff.length} files ${JSON.stringify(diff)}, ` +
      `registration pins exactly ${JSON.stringify(expected)}. The worktrees differ by ` +
      `something other than the fix.`
    );
  }
  return {
    arm_hashes: Object.fromEntries(arms.map((x) => [x.id, observed[x.id].rel_hash])),
    arm_file_counts: Object.fromEntries(arms.map((x) => [x.id, observed[x.id].n_files])),
    arm_delta: diff,
  };
}

/**
 * One cold index run against an EXPLICIT binary.
 *
 * A near-copy of `e1-common.mjs`'s `runColdIndex`, and the duplication is deliberate:
 * that function hardcodes `MAST_BIN`, which is fixed at module load to the dist of
 * whichever checkout the harness was imported from. Parameterising the shared
 * function would change the argv construction that
 * `eval/__tests__/e1-common-argv.test.mjs` pins for E1, E1-PHASE and E1-AB's
 * completed records. Everything else — the NODE_OPTIONS strip, the phase-timing env,
 * spawnSync over execFileSync, ground-truth counts from graph.db — is carried over
 * unchanged, and the shared readers are imported rather than reimplemented.
 */
async function runColdIndexWithBin({ bin, projectRoot, stateDir }) {
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });

  if (process.env.MAST_STATE_DIR !== undefined) {
    throw new Error(`GATE 1 FAILED: MAST_STATE_DIR is set (${process.env.MAST_STATE_DIR}).`);
  }
  const stray = join(projectRoot, 'mast.config.json');
  if (existsSync(stray)) throw new Error(`GATE 1 FAILED: ${stray} exists and would override the pinned config.`);

  const args = [bin, 'index', projectRoot, '--state-dir', stateDir];
  const { NODE_OPTIONS: inheritedNodeOptions, ...inherited } = process.env;
  const env = { ...inherited, ENABLE_MAST_PHASE_TIMING: 'true' };

  const externalStart = Date.now();
  const proc = spawnSync(process.execPath, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, env });
  const externalMs = Date.now() - externalStart;

  if (proc.error) throw proc.error;
  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';

  let meta, truth, wal;
  try {
    meta = readIndexMeta(stateDir);
    truth = readGraphCounts(stateDir);
    wal = readWalBoundary(stateDir);
  } catch (cause) {
    throw new ColdIndexFailure({ stateDir, status: proc.status, signal: proc.signal, stdout, stderr, cause });
  }

  return {
    bin,
    project_root: projectRoot,
    state_dir: stateDir,
    duration_ms: parseDurationMs(stdout),
    phase_ms: parsePhaseMs(stdout),
    write_spans: parseWriteSpans(stdout),
    pragmas: parsePragmas(stdout),
    external_ms: externalMs,
    ...truth,
    parse_errors: meta.parse_errors ?? 0,
    write_errors: meta.write_errors ?? 0,
    exit_status: proc.status,
    stdout_tail: stdout.trim().split('\n').slice(-3),
    stderr_tail: stderr.trim() === '' ? [] : stderr.trim().split('\n').slice(-20),
    wal_boundary: wal,
    env: { node_version: process.version, node_options_stripped: inheritedNodeOptions ?? null },
  };
}

/**
 * The import lookup's query plan and row shape, recorded once per run.
 *
 * This is the query the hoist removes copies of, so its plan is the corroborating
 * evidence for the mechanism — the analogue of E1-SCAN recording the LIKE-vs-range
 * plans. `imports_rows_per_file` is the multiplier on the work the old path repeated:
 * arm N re-read and re-parsed all of a file's import rows once per distinct call name.
 *
 * NOT opened with `?mode=ro&immutable=1` — that is WAL-blind and returns stale data
 * (FINDINGS.md §5). `readonly: true` alone is the safe form.
 */
function resolverPlan(stateDir) {
  const db = new Database(join(stateDir, 'graph.db'), { readonly: true });
  try {
    const importsPlan = db.prepare('EXPLAIN QUERY PLAN SELECT symbols, resolved_path FROM imports WHERE file_id = ?').all(1);
    const rows = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT file_id) AS f FROM imports').get();
    return {
      imports_lookup: importsPlan.map((r) => r.detail),
      imports_rows: rows.n,
      imports_files: rows.f,
      imports_rows_per_file: rows.f > 0 ? rows.n / rows.f : null,
    };
  } finally {
    db.close();
  }
}

function loadJournal() {
  if (!existsSync(JOURNAL)) return { records: [], done: new Map(), orphans: [], truncated: false };
  const lines = readFileSync(JOURNAL, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  const records = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    try { records.push(JSON.parse(lines[i])); }
    catch {
      if (i === lines.length - 1) { truncated = true; continue; }
      throw new Error(`Journal line ${i + 1} is unparseable and is not the trailing line — ${JOURNAL} is corrupt.`);
    }
  }
  const done = new Map();
  for (const r of records) if (r.type === 'run') done.set(hoistKey(r), r);
  return { records, done, orphans: orphanedAttempts(records, hoistKey), truncated };
}

function journal(rec) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(JOURNAL, JSON.stringify(rec) + '\n');
}

function materialiseTiers(manifest, n8nWorktree) {
  mkdirSync(TIER_ROOT, { recursive: true });
  const roots = {};
  for (const name of HOIST_TIERS) {
    const tier = manifest.tiers[name];
    const root = join(TIER_ROOT, name);
    const sidecar = `${root}.manifest.json`;
    const want = { tier: name, file_count: tier.file_count, chunk_count: tier.chunk_count, seed: manifest.seed };
    if (existsSync(sidecar) && existsSync(root) && readFileSync(sidecar, 'utf-8') === JSON.stringify(want)) {
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
  const { arm, tier, block } = cell;
  const spec = ctx.armsById[arm];
  const stateDir = join(E1_ROOT, hoistStateDirName(arm, tier, block));
  const manifestTier = ctx.manifest.tiers[tier];
  const projectRoot = ctx.tierRoots[tier];

  // Re-asserted per run: the tier trees hardlink into the n8n worktree, so an
  // in-place write there would change their content mid-schedule (A4-MAT-4).
  assertCorpusPinned('n8n');
  // Re-asserted per run: a rebuild of either worktree mid-schedule would split the
  // journal across two binaries with nothing recording the seam.
  assertArmIdentity(ctx.arms);

  const spent = ctx.orphansByKey.get(hoistKey(cell)) ?? 0;
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

    const run = await runColdIndexWithBin({ bin: spec.bin, projectRoot, stateDir });

    if (run.write_errors > 0) {
      const rec = { type: 'void', arm, tier, block, attempt, reason: 'write_errors',
        write_errors: run.write_errors, measurement: run, at: new Date().toISOString() };
      journal(rec);
      return rec;
    }

    assertTierFileSet(run, manifestTier, tier);

    const g3 = gate3Verdict({ externalMs: run.external_ms, durationMs: run.duration_ms });
    attempts.push({ attempt, duration_ms: run.duration_ms, external_ms: run.external_ms,
      phase_ms: run.phase_ms, gate3: g3 });

    if (g3.ok || attempt === budget) {
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
        // The primary series.
        edges_ms: fitted.phase_ms.edges,
        duration_ms: fitted.duration_ms,
        external_ms: fitted.external_ms,
        phase_ms: fitted.phase_ms,
        write_spans: fitted.write_spans ?? run.write_spans,
        // Gate C's inputs — read from graph.db, never from stdout.
        file_count: run.file_count, chunk_count: run.chunk_count,
        symbol_count: run.symbol_count, edge_count: run.edge_count,
        potential_call_count: run.potential_call_count,
        chunk_fts_count: run.chunk_fts_count, identifier_fts_count: run.identifier_fts_count,
        db_bytes: run.db_bytes, parse_errors: run.parse_errors,
        query_plan: resolverPlan(run.state_dir),
        arm_commit: spec.commit, arm_rel_hash: spec.rel_hash, bin: spec.bin,
        gate3: g3, gate3_attempts: attempts,
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
    process.stdout.write('Usage: node eval/e1-hoist-run.mjs [--dry-run] [--limit <n>]\n');
    return;
  }

  const arms = HOIST_ARMS.map((a) => ({ ...a, bin: join(a.pkgRoot, 'dist', 'cli', 'index.js') }));
  for (const a of arms) {
    if (!existsSync(a.bin)) {
      throw new Error(`Arm ${a.id}: ${a.bin} does not exist. Build that worktree with \`tsc\` first.`);
    }
  }

  log('[E1-HOIST] GATES S1/S2 — arm identity and arm delta');
  const identity = assertArmIdentity(arms);
  for (const a of arms) {
    log(`     arm ${a.id} (${a.label})  ${a.commit}  ${identity.arm_file_counts[a.id]} files  ${identity.arm_hashes[a.id].slice(0, 16)}…`);
  }
  log(`     arm delta: ${identity.arm_delta.join(', ')}`);

  const manifest = JSON.parse(readFileSync(join(RESULTS_DIR, 'e1-tiers.json'), 'utf-8'));
  const schedule = buildHoistSchedule();

  if (!existsSync(SCHEDULE)) {
    writeResult('e1-hoist-schedule.json', {
      created: new Date().toISOString(),
      arms: HOIST_ARMS.map(({ id, label, commit, rel_hash }) => ({ id, label, commit, rel_hash })),
      identity, tiers: HOIST_TIERS, blocks: HOIST_BLOCKS, reps: REPS,
      total_runs: HOIST_TOTAL_RUNS, schedule,
      node_version: process.version,
    });
    log(`[E1-HOIST] wrote ${SCHEDULE} (schedule + arm pins)`);
  } else {
    const pinned = JSON.parse(readFileSync(SCHEDULE, 'utf-8'));
    for (const a of arms) {
      if (pinned.identity.arm_hashes[a.id] !== identity.arm_hashes[a.id]) {
        throw new Error(
          `GATE S1 FAILED on resume (arm ${a.id}): the worktree was rebuilt since this schedule ` +
          `was committed.\n  committed: ${pinned.identity.arm_hashes[a.id]}\n  now:       ${identity.arm_hashes[a.id]}`
        );
      }
    }
    if (JSON.stringify(pinned.schedule) !== JSON.stringify(schedule)) {
      throw new Error('The committed schedule does not match the one just built — the rung list or ordering moved.');
    }
  }

  if (opts.dryRun) {
    const armsById = Object.fromEntries(arms.map((a) => [a.id, a]));
    for (const c of schedule) {
      log(`  ${String(c.slot).padStart(2)}. block ${String(c.block).padStart(2)}  ${c.tier.padEnd(3)} arm ${c.arm} (${armsById[c.arm].label})`);
    }
    return;
  }

  const { done, orphans, truncated } = loadJournal();
  if (truncated) log('[E1-HOIST] FINDING: journal ends in a partial line — an attempt was interrupted mid-write.');
  const orphansByKey = new Map();
  for (const o of orphans) {
    log(`[E1-HOIST] FINDING: ${o.key} attempt ${o.attempt} started at ${o.at} and never completed — re-attempting, flagged.`);
    orphansByKey.set(o.key, (orphansByKey.get(o.key) ?? 0) + 1);
  }

  const n8n = assertCorpusPinned('n8n');
  const tierRoots = materialiseTiers(manifest, n8n);
  const armsById = Object.fromEntries(arms.map((a) => [a.id, a]));
  const ctx = { manifest, tierRoots, orphansByKey, arms, armsById };

  const pending = schedule.filter((c) => !done.has(hoistKey(c)));
  log(`[E1-HOIST] ${done.size} complete, ${pending.length} pending of ${HOIST_TOTAL_RUNS}`);

  let ran = 0;
  for (const cell of pending) {
    if (ran >= opts.limit) break;
    const t0 = Date.now();
    log(`[E1-HOIST] slot ${String(cell.slot).padStart(2)}/${HOIST_TOTAL_RUNS}  block ${cell.block}  ${cell.tier}  arm ${cell.arm}`);
    const rec = await executeCell(cell, ctx);
    ran++;

    if (rec.type === 'void') {
      log(`      VOID — ${rec.reason}`);
      continue;
    }
    log(`      ${rec.chunk_count} chunks  edges ${rec.edges_ms} ms  total ${rec.duration_ms} ms  ` +
        `(wall ${Math.round((Date.now() - t0) / 1000)}s)${rec.gate3.ok ? '' : '  [Gate 3 finding]'}`);

    // Every state dir is removed: at T9 each is ~420 MiB and the registration's cost
    // line promises peak transient disk of ONE. Nothing downstream reads them —
    // counts, plan and spans are already in the record.
    rmSync(rec.measurement.state_dir, { recursive: true, force: true });
  }

  summarise();
}

/** Cross-run checks that cannot live inside one run — Gate C among them. */
function summarise() {
  const { done, orphans } = loadJournal();
  const runs = [...done.values()];
  log('');
  log(`[E1-HOIST] ${runs.length}/${HOIST_TOTAL_RUNS} scoreable runs, ${orphans.length} interrupted`);

  const findings = [];
  for (const o of orphans) findings.push(`INTERRUPTED ${o.key}: attempt started ${o.at} never completed.`);
  for (const r of runs) if (!r.gate3.ok) findings.push(`Gate 3 ${hoistKey(r)}: ${r.gate3_finding}`);

  // GATE C — the arms must build an identical graph at every rung.
  const COUNTS = ['file_count', 'chunk_count', 'symbol_count', 'edge_count', 'potential_call_count'];
  const gateC = [];
  for (const tier of HOIST_TIERS) {
    const byArm = {};
    for (const a of HOIST_ARMS) {
      const rs = runs.filter((r) => r.tier === tier && r.arm === a.id);
      if (rs.length === 0) continue;
      byArm[a.id] = Object.fromEntries(COUNTS.map((c) => [c, [...new Set(rs.map((r) => r[c]))]]));
    }
    if (Object.keys(byArm).length < 2) continue;
    const mismatches = [];
    for (const c of COUNTS) {
      const vals = HOIST_ARMS.map((a) => byArm[a.id]?.[c] ?? []);
      const flat = [...new Set(vals.flat())];
      if (flat.length !== 1) mismatches.push({ count: c, by_arm: Object.fromEntries(HOIST_ARMS.map((a, i) => [a.id, vals[i]])) });
    }
    gateC.push({ tier, ok: mismatches.length === 0, mismatches });
    if (mismatches.length > 0) {
      findings.push(
        `GATE C ${tier}: the arms built DIFFERENT graphs — ` +
        mismatches.map((m) => `${m.count} ${JSON.stringify(m.by_arm)}`).join('; ') +
        '. This is a CORRECTNESS finding and outranks every timing number here (registration, Gate C).'
      );
    }
  }

  // GATE L — cross-experiment replication, a FINDING and never a blocker.
  //
  // Arm N is source-identical to E1-SCAN's arm R (same dist rel-hash, verified by
  // Gate S1 against the pin in the schedule module), so its T9 edges median is a
  // RE-RUN of a committed measurement and should reproduce. Machine state legitimately
  // varies between sessions — E1-LADDER's own Gate L came in at +10.0% on this rung
  // against this same comparator — so a miss is recorded, not fatal.
  //
  // What it protects against is the failure no internal check can see: a rig that has
  // drifted so far from the one that produced the comparator that the arms are being
  // compared under conditions nothing else in the record shares.
  const armN = runs.filter((r) => r.arm === 'N').map((r) => r.phase_ms.edges).sort((a, b) => a - b);
  let gateL = null;
  if (armN.length > 0) {
    // D016: this used `armN[Math.floor(n / 2)]`, the UPPER element, while
    // `e1-hoist-score.mjs` averaged the middle two. On E1-HOIST's even n = 30 the
    // two disagreed — 2623 ms against 2617 ms, Gate L 18.31% against 18.04%. The
    // scorer is authoritative and is already published, so the runner adopts its
    // convention; only future runs' Gate L arithmetic changes.
    const observed = median(armN);
    const delta = (observed - GATE_L_SCAN_ARM_R_T9_EDGES) / GATE_L_SCAN_ARM_R_T9_EDGES;
    gateL = {
      comparator: 'e1-scan arm R, T9, phase_ms.edges median',
      comparator_ms: GATE_L_SCAN_ARM_R_T9_EDGES,
      observed_ms: observed,
      delta,
      band: GATE_L_BAND,
      within_band: Math.abs(delta) <= GATE_L_BAND,
    };
    if (!gateL.within_band) {
      findings.push(
        `GATE L: arm N's T9 edges median is ${median} ms against E1-SCAN arm R's ` +
        `${GATE_L_SCAN_ARM_R_T9_EDGES} ms (${(delta * 100).toFixed(1)}%, band +/-${GATE_L_BAND * 100}%). ` +
        'Same binary, different session. A FINDING, not a blocker — but the paired ratio is the ' +
        'only statistic here that survives this much drift, and it is the registered primary.'
      );
    }
  }

  const summary = {
    created: new Date().toISOString(),
    complete: runs.length, total: HOIST_TOTAL_RUNS,
    gate_c: gateC,
    gate_l: gateL,
    findings,
    // Gate L is deliberately ABSENT from this predicate. It is a statement about the
    // rig, not about the runs, and the paired design is what makes the primary robust
    // to exactly the drift Gate L reports.
    scoreable: runs.length === HOIST_TOTAL_RUNS && gateC.every((g) => g.ok),
  };
  writeResult('e1-hoist-runs-summary.json', summary);

  if (findings.length === 0) log('[E1-HOIST] no findings');
  else for (const f of findings) log(`[E1-HOIST] FINDING: ${f}`);
  log(`[E1-HOIST] scoreable: ${summary.scoreable}`);
}

main().catch((err) => {
  console.error(`\n[E1-HOIST] FAILED: ${err.message}`);
  process.exitCode = 1;
});
