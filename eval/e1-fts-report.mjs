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

import { FTS_TIERS, FTS_TOTAL_RUNS, dbIdentityVerdict } from './e1-fts-schedule.mjs';

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
 */
export function dbIdentityRows(runs) {
  const rows = [];
  for (const tier of FTS_TIERS) {
    for (const block of [1, 2, 3]) {
      const cell = runs.filter((r) => r.tier === tier && r.block === block);
      const a = cell.find((r) => r.arm === 'A');
      const g = cell.find((r) => r.arm === 'G');
      rows.push({
        tier,
        block,
        ...dbIdentityVerdict({ armA: a?.db_bytes ?? null, armG: g?.db_bytes ?? null }),
      });
    }
  }
  return rows;
}
