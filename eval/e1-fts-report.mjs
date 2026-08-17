// E1-FTS — the journal fold, the pending planner, and the cross-run gates.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-FTS PRE-REGISTRATION (2026-08-14),
// as amended by AMENDMENT 1 and AMENDMENT 2 (both pre-run).
//
// NOT an import of `e1-ab-report.mjs`, and the reason is substantive rather
// than hygienic. E1-AB ran four arms sharing ONE control, so only a control
// void poisoned a block; E1-FTS runs exactly two arms whose RATIO is the
// estimator, so a void on either arm leaves the other with nothing to divide
// by. The fold is also keyed and totalled differently. Copying the shape while
// changing the semantics is honest here; parameterising E1-AB's module in place
// would put a completed experiment's scored record behind a moving definition,
// which is the standing rule this whole program follows.
//
// This logic lives here and not in the driver for RR6's reason: driver-private
// logic is what nothing can test, and RR6 was exactly such a defect.
//
// Run from `packages/mast`, never the repo root.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, writeResult } from './e1-common.mjs';
import { FTS_TIERS, FTS_TOTAL_RUNS, dbIdentityVerdict } from './e1-fts-schedule.mjs';
import { scoreFts, VALIDITY_TOLERANCE } from './e1-fts-score.mjs';

/** A cell's identity: arm x rung x block. */
export const ftsKey = (r) => `${r.arm}#${r.tier}#b${r.block}`;

/** A pair's identity — the unit the within-block ratio is taken over. */
export const ftsPairKey = (r) => `${r.tier}#b${r.block}`;

/**
 * Fold an append-only journal into current state.
 *
 * Two behaviours inherited from E1-AB's fold because both were earned there:
 *
 * 1. **The VOID queue dequeues** (RR6). A cell that voided and was later re-run
 *    clean has its void RESOLVED rather than left in the map forever.
 *    E1-PHASE's version left it, which pinned `scoreable` false permanently
 *    once anything had ever voided — unexercised there because nothing voided.
 *    The tiling gate makes a void genuinely plausible here.
 * 2. **Later records win** for a given cell. Not laxity: a voided cell is
 *    re-run TOGETHER WITH its partner, because the estimator is a within-block
 *    ratio and a partner measured hours earlier no longer cancels drift. The
 *    re-paired partner is a second `run` record for a key that already has one,
 *    and it is meant to supersede — but it is also recorded as a supersession,
 *    because silently replacing a record is not something a reader should have
 *    to infer.
 */
export function foldJournal(records) {
  const done = new Map();
  const voids = new Map();
  const resolvedVoids = [];
  const superseded = [];

  for (const rec of records) {
    const k = ftsKey(rec);
    if (rec.type === 'run') {
      if (done.has(k)) superseded.push({ key: k, at: rec.at });
      done.set(k, rec);
      const v = voids.get(k);
      if (v !== undefined) {
        voids.delete(k);
        resolvedVoids.push({ key: k, void_reason: v.reason, resolved_at: rec.at });
      }
    } else if (rec.type === 'void') {
      voids.set(k, rec);
      done.delete(k);
    }
  }
  return { done, voids, resolved_voids: resolvedVoids, superseded };
}

/**
 * The runs that enter the score.
 *
 * An unresolved void on EITHER arm poisons its whole `(tier, block)` pair. With
 * two arms there is no surviving comparison inside that block, and pairing the
 * survivor against a partner from a different block would reintroduce exactly
 * the drift the within-block estimator exists to cancel. Excluded here rather
 * than silently divided.
 */
export function selectFtsRuns(records) {
  const { done, voids, resolved_voids, superseded } = foldJournal(records);

  const poisoned = new Set();
  for (const v of voids.values()) poisoned.add(ftsPairKey(v));

  const runs = [...done.values()].filter((r) => !poisoned.has(ftsPairKey(r)));
  return {
    runs, voids, resolved_voids, superseded,
    poisoned_pairs: [...poisoned],
    complete: done.size === FTS_TOTAL_RUNS,
    // The registered blockers: an unresolved void, or a missing cell. A Gate 3
    // finding is logged and retained and is NOT a blocker (A4-MAT-6).
    scoreable: done.size === FTS_TOTAL_RUNS && voids.size === 0,
  };
}

/**
 * What still has to run.
 *
 * A voided cell is obviously pending. The subtlety is its PARTNER: the
 * estimator is a within-block ratio, so re-running one half hours after its
 * block would pair a fresh measurement against a stale one. The whole pair
 * re-runs, which is what keeps every ratio a temporally adjacent comparison.
 *
 * On a repair the control is emitted FIRST, so the pair is measured in the
 * order and adjacency the estimator assumes. On the INITIAL pass the schedule's
 * own order is registered — the arms alternate by block and by rung index
 * precisely so no arm holds a fixed position — and hoisting the control would
 * defeat the balance the design paid for. So repairs reorder and first passes
 * do not.
 */
export function planPending(schedule, { done, voids }) {
  const repairPairs = new Set();
  for (const v of voids.values()) repairPairs.add(ftsPairKey(v));

  const groups = new Map();
  for (const cell of schedule) {
    const missing = !done.has(ftsKey(cell));
    const repair = repairPairs.has(ftsPairKey(cell));
    if (!missing && !repair) continue;
    const k = ftsPairKey(cell);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...cell, reason: missing ? 'not_run' : 'repair_pair' });
  }

  const out = [];
  for (const cells of groups.values()) {
    const isRepair = cells.some((c) => c.reason === 'repair_pair');
    if (isRepair) out.push(...cells.filter((c) => c.arm === 'A'), ...cells.filter((c) => c.arm !== 'A'));
    else out.push(...cells);
  }
  return out;
}

/**
 * Every run at a rung must report the same chunk count, across both arms and
 * all three blocks.
 *
 * Arm G differs from the control by one flag, and that flag must not change
 * WHAT is indexed — only how the FTS tables are maintained while indexing it. A
 * divergence means the two arms did different work, and every ratio taken
 * across them would be comparing different corpora.
 */
export function chunkIdentityRows(runs) {
  return FTS_TIERS.map((tier) => {
    const at = runs.filter((r) => r.tier === tier);
    const counts = [...new Set(at.map((r) => r.chunk_count))];
    return {
      tier,
      runs: at.length,
      chunk_counts: counts,
      identical: at.length > 0 && counts.length === 1,
    };
  });
}

/**
 * GATE — DATABASE IDENTITY, per `(rung, block)` pair.
 *
 * Arm G's whole claim to being confound-free is that the deletes it skipped
 * matched zero rows, so its finished `graph.db` must be exactly the size of the
 * control's. Graded per PAIR rather than per rung because a pair is the unit
 * both arms were measured under identical conditions in; a rung-level
 * aggregation would let one bad block hide behind two good ones.
 *
 * Exact equality, no tolerance — a tolerance would be a licence for the
 * confound that got arm F cut to hide inside it.
 *
 * A pair that is not yet fully populated is `pending`, NOT a failure. That
 * distinction is load-bearing rather than cosmetic: without it a mid-schedule
 * summary reports fourteen gate failures for pairs that simply have not run, and
 * an operator who learns to scroll past this gate is an operator who will scroll
 * past the one time it fires for real. Nothing is weakened — `scoreable`
 * separately requires all {@link FTS_TOTAL_RUNS} runs, so in any final state
 * every pair is populated and every pair is adjudicated.
 */
export function dbIdentityRows(runs) {
  const rows = [];
  for (const tier of FTS_TIERS) {
    for (const block of [1, 2, 3]) {
      const cell = runs.filter((r) => r.tier === tier && r.block === block);
      const a = cell.find((r) => r.arm === 'A');
      const g = cell.find((r) => r.arm === 'G');
      if (a === undefined && g === undefined) {
        rows.push({
          tier, block, pending: true, ok: null, reason: 'not_yet_run',
          arm_a_bytes: null, arm_g_bytes: null, delta_bytes: null,
        });
        continue;
      }
      rows.push({
        tier,
        block,
        pending: false,
        ...dbIdentityVerdict({
          armA: a?.db_bytes ?? null, armG: g?.db_bytes ?? null,
          rowsA: a ?? null, rowsG: g ?? null,
        }),
      });
    }
  }
  return rows;
}

/**
 * Attempts that started and never produced a terminal record — REPAIR-AWARE.
 *
 * E1's `orphanedAttempts` (`eval/e1-schedule.mjs:135-157`) counts every
 * `attempt_start` for a key across the whole journal and subtracts the attempt
 * count of the LAST terminal record. That is correct for a schedule each cell
 * runs once. It is wrong for one with repairs: a cell that ran twice — once on
 * the first pass, once as a re-paired repair — has all of both passes' starts
 * counted against only the second pass's attempt count, and the first pass's
 * attempts are reported as interruptions that never happened.
 *
 * That is not cosmetic. Orphan counts feed `remainingAttempts`, which SHRINKS a
 * resumed cell's Gate 3 retake budget; at the limit it reaches zero and the
 * driver voids the cell with `retake_cap_exhausted_by_interruptions` — a cell
 * voided for interruptions that did not occur. E1-FTS is the first schedule
 * here to both repair pairs and resume, which is why it surfaces now.
 *
 * The rule is E1's own, applied per SEGMENT instead of per key: each terminal
 * record closes a segment, and consumes the last `n` starts in it. Starts left
 * over when a segment closes were genuinely killed. Starts still pending at the
 * end of the journal were genuinely interrupted.
 *
 * `e1-schedule.mjs` is E1's scored instrument and is not modified — this is a
 * separate function, and the defect there is recorded rather than patched in
 * place.
 */
export function ftsOrphanedAttempts(records) {
  const pending = new Map();
  const orphans = [];

  for (const rec of records) {
    const k = ftsKey(rec);
    if (rec.type === 'attempt_start') {
      pending.set(k, [...(pending.get(k) ?? []), rec]);
      continue;
    }
    if (rec.type !== 'run' && rec.type !== 'void') continue;

    const consumed = rec.type === 'run' ? (rec.gate3_attempts?.length ?? 1) : (rec.attempt ?? 0);
    const started = pending.get(k) ?? [];
    // The surviving attempts are the LAST n — a resumed cell re-runs from
    // attempt 1, so anything killed is always earlier in the segment.
    const surplus = started.length - consumed;
    if (surplus > 0) orphans.push(...started.slice(0, surplus).map((s) => ({ ...s, key: k })));
    pending.set(k, []);
  }

  for (const [k, started] of pending) {
    orphans.push(...started.map((s) => ({ ...s, key: k })));
  }
  return orphans;
}

/** How many identity pairs had their FTS row counts actually compared. */
function scored_contentChecked(record) {
  return record.db_identity.filter((r) => r.content_checked === true).length;
}

function main() {
  const records = readFileSync(join(RESULTS_DIR, 'e1-fts-runs.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const summary = JSON.parse(readFileSync(join(RESULTS_DIR, 'e1-fts-runs-summary.json'), 'utf8'));

  const sel = selectFtsRuns(records);
  const scored = scoreFts(sel.runs);

  const record = {
    created: new Date().toISOString(),
    what_this_is:
      'E1-FTS tests whether the per-file FTS5 delete-scan carries the write phase\'s ' +
      'super-linear exponent. It cannot re-adjudicate E1\'s SUPER-LINEAR verdict, which stands ' +
      'regardless; it licenses nothing about the UPDATE path, where the deletes are real work; ' +
      'and it does not explain E1-AB\'s rho_D(T9) = 0.8486, which remains open. The fix is not ' +
      'shipped on the strength of this — it is verified by re-running E1\'s full 9-rung ladder.',
    expected_outcome_declared_in_advance:
      'MECHANISM_IDENTIFIED was registered as the EXPECTED outcome before the run. A favourable ' +
      'result confirms a prediction made in advance; it is not a discovery made by the experiment.',
    complete: sel.complete,
    scoreable: sel.scoreable,
    unresolved_voids: [...sel.voids.keys()],
    resolved_voids: sel.resolved_voids,
    superseded: sel.superseded,
    poisoned_pairs: sel.poisoned_pairs,
    chunk_identity: chunkIdentityRows(sel.runs),
    db_identity: dbIdentityRows(sel.runs),
    driver_findings: summary.findings,
    ...scored,
  };
  const out = writeResult('e1-fts-verdict.json', record);

  const f = (x, d = 4) => (typeof x === 'number' ? x.toFixed(d) : String(x));
  const pct = (x) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : String(x));

  console.log('');
  console.log('  rung   write_A ms   write_G ms   ratio A/G   blocks');
  for (const tier of FTS_TIERS) {
    const r = scored.write_ratio[tier];
    const a = sel.runs.filter((x) => x.tier === tier && x.arm === 'A').map((x) => x.phase_ms.write);
    const g = sel.runs.filter((x) => x.tier === tier && x.arm === 'G').map((x) => x.phase_ms.write);
    const med = (v) => (v.length ? [...v].sort((p, q) => p - q)[Math.floor(v.length / 2)] : NaN);
    console.log(`  ${tier.padEnd(6)} ${String(med(a)).padEnd(12)} ${String(med(g)).padEnd(12)} ` +
      `${f(r.median, 3).padEnd(11)} ${r.per_block.map((x) => f(x, 3)).join(' ')}`);
  }

  console.log('');
  console.log('  arm A span shares of the write phase (median run)');
  console.log(`  rung   ${['fts_del', 'fts_ins', 'commit', 'rest', 'txn', 'lock'].map((s) => s.padEnd(9)).join('')}`);
  for (const tier of FTS_TIERS) {
    console.log(`  ${tier.padEnd(6)} ` +
      ['fts_del', 'fts_ins', 'commit', 'rest', 'txn', 'lock']
        .map((s) => pct(scored.shares[tier][s].median_run).padEnd(9)).join(''));
  }

  console.log('');
  console.log('  exponent (ln series on ln chunks; HC3 interval is CONTEXT, not a bar)');
  for (const [k, v] of Object.entries(scored.exponents)) {
    console.log(`  ${k.padEnd(12)} ${v.degenerate ? `DEGENERATE ${v.degenerate}` :
      `${f(v.b)}   ci [${f(v.ci_hc3[0], 3)}, ${f(v.ci_hc3[1], 3)}]  df ${v.df}`}`);
  }

  console.log('');
  console.log('  eviction spillover — arm A\'s non-delete work minus arm G\'s (a FINDING, adjudicates nothing)');
  console.log('  rung   spillover ms   share of delta   where it lands');
  for (const row of scored.spillover) {
    if (row.spillover_ms === null) { console.log(`  ${row.tier.padEnd(6)} (no complete pair)`); continue; }
    const top = Object.entries(row.by_span).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k} ${v.toFixed(0)}`).join('  ');
    console.log(`  ${row.tier.padEnd(6)} ${row.spillover_ms.toFixed(0).padEnd(14)} ` +
      `${pct(row.share_of_delta).padEnd(16)} ${top}`);
  }

  console.log('');
  console.log(`  db identity: content verified on ${scored_contentChecked(record)} of ${record.db_identity.length} pairs`);

  console.log('');
  for (const tier of ['T7', 'T9']) {
    const v = scored.instrument_validity[tier];
    console.log(`  instrument validity ${tier}: ${v.ok ? 'ok' : `DISAGREE (${v.reason})`}  ` +
      `rel err ${f(v.relative_error, 4)} (tolerance ${v.tolerance ?? VALIDITY_TOLERANCE}) — adjudicates nothing`);
  }

  console.log('');
  for (const c of scored.verdict.conditions) {
    console.log(`  ${c.met ? 'MET    ' : 'UNMET  '} ${c.id.padEnd(18)} ${f(c.value)} vs ${c.threshold}   ${c.label}`);
  }
  console.log('');
  console.log(`[E1-FTS] OUTCOME   ${scored.verdict.outcome}${scored.verdict.reason ? `  (${scored.verdict.reason})` : ''}`);
  console.log(`[E1-FTS] scoreable: ${sel.scoreable}`);
  console.log(`\nwrote ${out}`);
}

if (process.argv[1] && process.argv[1].endsWith('e1-fts-report.mjs')) main();
