// E1-FTS — the arms, the schedule, and the two gates this experiment adds.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-FTS PRE-REGISTRATION (2026-08-14),
// as amended by AMENDMENT 1 (same day, pre-run, instrument-informed: the four
// registered spans became six after the instrument was built and measured).
//
// A SEPARATE module from `e1-schedule.mjs`, `e1-phase-schedule.mjs` and
// `e1-ab-schedule.mjs`, for the reason E1-PHASE gave and E1-AB repeated: those
// are the scored instruments of completed experiments, and extending one in
// place would put a finished record behind a moving definition. What E1-FTS
// inherits unchanged it IMPORTS.
//
// Run every script from `packages/mast`, never the repo root.

/**
 * How within-block ordering is decided.
 *
 * Named for what it actually is. With 2 arms and 3 blocks, exact positional
 * balance is arithmetically unattainable — the position-sum is 3*(1+2) = 9 over
 * 2 arms, so the mean 4.5 is not an integer and one arm MUST go first twice.
 * The alternation attains the forced optimum {4,5}, which is optimal in its
 * class rather than balanced, and this constant says so rather than implying a
 * balance the design cannot deliver.
 */
export const FTS_ORDERING = 'alternating_latin_square_forced_imbalance';

/** Five rungs of E1's frozen manifest — every other rung of the 9-rung ladder. */
export const FTS_TIERS = ['T1', 'T3', 'T5', 'T7', 'T9'];

/** Blocks, not repetitions: each block holds every arm once, so drift loads onto both alike. */
export const FTS_BLOCKS = 3;

/**
 * The six write-phase spans the binary emits (`cli/index-cmd.ts`, `write_spans:`).
 *
 * Order is execution order, not alphabetical, and is load-bearing for every
 * table this instrument prints. `txn` and `lock` are AMENDMENT 1's additions.
 */
export const WRITE_SPANS = ['fts_del', 'fts_ins', 'commit', 'rest', 'txn', 'lock'];

/**
 * The registered tiling floor — the six spans must account for this share of
 * the write phase.
 *
 * Same floor and same reason as E1-PHASE's `GATE_P_FLOOR`
 * (`eval/e1-phase-schedule.mjs`): a decomposition that does not account for the
 * thing it decomposes is not a decomposition. AMENDMENT 1 exists because the
 * four originally-registered spans tiled a smoke build to only 0.746.
 */
export const GATE_TILING_FLOOR = 0.95;

/**
 * The registered arms.
 *
 * Two, and the difference between them is one flag. Arm F — "skip FTS5 writes
 * entirely" — was registered as CUT: it shrinks the database ~69%, and E1-AB
 * established that write time is coupled to database size, so it would have
 * confounded "FTS work removed" with "smaller database" in the direction that
 * FLATTERS a positive result. Arm G has no such confound, because deletes that
 * match nothing leave the finished database byte-identical — which is why that
 * identity is a gate here (see {@link dbIdentityVerdict}) and not an aside.
 */
export const FTS_ARMS = [
  {
    id: 'A',
    label: 'control',
    extraArgs: [],
    rungs: FTS_TIERS,
    role: 'the production write path; every ratio is taken against this arm inside its own block',
  },
  {
    id: 'G',
    label: 'skip FTS deletes',
    extraArgs: ['--unsafe-skip-fts-deletes'],
    rungs: FTS_TIERS,
    role:
      'the causal test, and a rehearsal of the fix. Skips the two DELETE statements at ' +
      'graph/populate.ts, which FTS5 cannot serve from an index (xBestIndex, ' +
      'sqlite3.c:260775-260860) and which on a cold build match zero rows.',
  },
];

/** Arms by id, for the driver and the scorer. */
export const FTS_ARMS_BY_ID = Object.fromEntries(FTS_ARMS.map((a) => [a.id, a]));

/** 2 arms x 5 rungs x 3 blocks. */
export const FTS_TOTAL_RUNS = FTS_ARMS.length * FTS_TIERS.length * FTS_BLOCKS;

/**
 * The committed run order: 3 contiguous blocks, 10 runs each.
 *
 * Within a block the cheap rungs run first and T9 last. Blocks are contiguous
 * because the primary estimator is a WITHIN-BLOCK ratio — an arm and the
 * control it is divided by must be close in time for drift to cancel.
 *
 * The arm order alternates by block AND by rung index. Alternating by block
 * alone would give an arm the same position at every rung within a block, and a
 * position effect whose MAGNITUDE varies by rung does not cancel in a log-log
 * slope — a constant multiplicative factor cancels exactly, a rung-varying one
 * does not. This is AMENDMENT 3 of E1-AB's lesson carried forward at the only
 * cost available: one step of rotation.
 */
export function buildFtsSchedule() {
  const cells = [];
  for (let block = 1; block <= FTS_BLOCKS; block++) {
    FTS_TIERS.forEach((tier, rungIndex) => {
      const armsFirst = (block + rungIndex) % 2 === 0;
      const ordered = armsFirst ? ['A', 'G'] : ['G', 'A'];
      for (const arm of ordered) cells.push({ block, tier, arm });
    });
  }
  return cells.map((c, i) => ({ slot: i + 1, ...c }));
}

/** The six spans summed, in ms. */
export function spanSum(spans) {
  return WRITE_SPANS.reduce((total, key) => total + (spans[key] ?? 0), 0);
}

/**
 * GATE — TILING. The six spans must account for >= {@link GATE_TILING_FLOOR} of
 * the write phase, and must not exceed it.
 *
 * Two distinct failures, reported distinctly. UNDER-attribution means some
 * region of the write phase is unmeasured, and whatever is unmeasured cannot be
 * ruled out as the carrier of the exponent — which is the entire question.
 * OVER-attribution means two spans double-counted the same work, which is a
 * different defect and must not be allowed to read as an especially good tiling.
 *
 * A missing `write_spans:` line voids the run rather than reading as zero:
 * `parseWriteSpans` returns null instead of throwing precisely so the failure
 * arrives here, where the cell can be named.
 *
 * @param {{spans: object|null, writeMs: number}} run
 */
export function tilingVerdict({ spans, writeMs }) {
  if (spans === null || spans === undefined) {
    return { ok: false, reason: 'write_spans_line_absent', tiling: null, span_sum_ms: null };
  }
  const missing = WRITE_SPANS.filter((key) => typeof spans[key] !== 'number');
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `spans_missing_${missing.join('_')}`,
      tiling: null,
      span_sum_ms: null,
    };
  }
  const sum = spanSum(spans);
  if (!(writeMs > 0)) {
    return { ok: false, reason: 'write_phase_not_positive', tiling: null, span_sum_ms: sum };
  }
  const tiling = sum / writeMs;
  if (tiling > 1) {
    return { ok: false, reason: 'spans_exceed_write_phase', tiling, span_sum_ms: sum };
  }
  if (tiling < GATE_TILING_FLOOR) {
    return { ok: false, reason: 'tiling_below_floor', tiling, span_sum_ms: sum };
  }
  return { ok: true, reason: null, tiling, span_sum_ms: sum };
}

/**
 * GATE — DATABASE IDENTITY. Arm G's finished `graph.db` must be exactly the
 * size of arm A's, per rung.
 *
 * This is the premise arm G rests on, so it is graded rather than assumed. On a
 * cold build the skipped deletes matched zero rows, so the two arms must
 * produce the same bytes; if they do not, then arm G removed real work and the
 * comparison has inherited exactly the confound that got arm F cut.
 *
 * Exact equality, not a tolerance — a tolerance here would be a licence for the
 * confound to hide inside it.
 *
 * **Size alone is a proxy, and the E1-FTS results review was right to say so** —
 * two databases can share a byte count and differ in content. `rowsA`/`rowsG`
 * close that gap for THIS arm exactly: arm G differs from the control only by
 * skipping DELETEs, so the sole way its content can diverge is extra or missing
 * FTS rows. Counting them is necessary and sufficient here; a full content
 * digest would be strictly stronger but answers a question this arm cannot pose.
 *
 * Row counts are OPTIONAL. The first schedule did not record them, and a check
 * added afterwards must not retroactively fail a completed experiment — that
 * would be grading old data against an instrument it never ran under. When they
 * are absent the verdict says `content_not_recorded` and passes on size, which
 * is exactly the weakness the E1-FTS RESULT block already names.
 *
 * @param {{armA: number|null, armG: number|null, rowsA?: object|null, rowsG?: object|null}} sizes
 */
export function dbIdentityVerdict({ armA, armG, rowsA = null, rowsG = null }) {
  if (typeof armA !== 'number' || typeof armG !== 'number') {
    return {
      ok: false,
      reason: 'db_size_unreadable',
      arm_a_bytes: armA ?? null,
      arm_g_bytes: armG ?? null,
      delta_bytes: null,
      content_checked: false,
    };
  }
  const delta = armG - armA;
  if (delta !== 0) {
    return {
      ok: false, reason: 'db_bytes_differ',
      arm_a_bytes: armA, arm_g_bytes: armG, delta_bytes: delta, content_checked: false,
    };
  }

  const base = { arm_a_bytes: armA, arm_g_bytes: armG, delta_bytes: 0 };
  const countable = rowsA !== null && rowsG !== null
    && typeof rowsA.chunk_fts_count === 'number' && typeof rowsG.chunk_fts_count === 'number'
    && typeof rowsA.identifier_fts_count === 'number' && typeof rowsG.identifier_fts_count === 'number';
  if (!countable) {
    // Passes on size, but never claims content was verified.
    return { ...base, ok: true, reason: 'content_not_recorded', content_checked: false };
  }

  const rowDeltas = {
    chunk_fts: rowsG.chunk_fts_count - rowsA.chunk_fts_count,
    identifier_fts: rowsG.identifier_fts_count - rowsA.identifier_fts_count,
  };
  const rowsMatch = rowDeltas.chunk_fts === 0 && rowDeltas.identifier_fts === 0;
  return {
    ...base,
    ok: rowsMatch,
    reason: rowsMatch ? null : 'fts_row_counts_differ',
    content_checked: true,
    fts_row_deltas: rowDeltas,
    arm_a_fts_rows: { chunk_fts: rowsA.chunk_fts_count, identifier_fts: rowsA.identifier_fts_count },
  };
}

/**
 * Per-(arm, tier, block) state directory name.
 *
 * NAMESPACED THREE WAYS, because `runColdIndex` wipes its state dir before
 * every run — a name collision destroys artifacts rather than merely confusing
 * them. E1 retained `run-<tier>-r3`, E1-PHASE `phase-run-<tier>-r3` and E1-AB
 * `e1ab-run-*`, and Gate 6 sequences later work to read them.
 */
export function ftsStateDirName(arm, tier, block) {
  return `e1fts-run-${arm}-${tier}-b${block}`;
}

/**
 * GATE — ARM IDENTITY. The analogue of E1-AB's Gate A, for a boolean lever.
 *
 * E1-AB could grade its arms against the pragmas SQLite reported for its own
 * connection. A flag has no such echo, so this grades the two things that ARE
 * observable: the flag appears in the argv the run recorded, and the flag's one
 * necessary consequence holds — arm G must report `fts_del == 0`, because the
 * statements that span times did not execute, and the control must report more
 * than zero, because they did.
 *
 * Checked BEFORE Gate 3's retake logic, for Gate A's reason: a run whose flag
 * silently failed to take effect is not a slow or fast measurement of this arm,
 * it is a measurement of the OTHER arm, and retaking it would produce more of
 * the wrong thing. Without this the two arms would be identical and the
 * experiment would return a clean, credible-looking null.
 *
 * @param {{arm: string, spans: object|null, extraArgs: string[]|undefined}} run
 */
export function armIdentityVerdict({ arm, spans, extraArgs }) {
  const expected = FTS_ARMS_BY_ID[arm];
  if (expected === undefined) {
    return { ok: false, reason: `unknown_arm_${arm}`, arm, fts_del_ms: null };
  }
  if (spans === null || spans === undefined) {
    return { ok: false, reason: 'write_spans_absent', arm, fts_del_ms: null };
  }
  const args = extraArgs ?? [];
  if (JSON.stringify(args) !== JSON.stringify(expected.extraArgs)) {
    return {
      ok: false, reason: 'extra_args_mismatch', arm,
      expected: expected.extraArgs, actual: args, fts_del_ms: null,
    };
  }
  const ftsDel = spans.fts_del;
  if (typeof ftsDel !== 'number') {
    return { ok: false, reason: 'fts_del_not_a_number', arm, fts_del_ms: ftsDel ?? null };
  }
  if (arm === 'G' && ftsDel !== 0) {
    return { ok: false, reason: 'skip_flag_did_not_take_effect', arm, fts_del_ms: ftsDel };
  }
  if (arm === 'A' && !(ftsDel > 0)) {
    return { ok: false, reason: 'control_recorded_no_delete_time', arm, fts_del_ms: ftsDel };
  }
  return { ok: true, reason: null, arm, fts_del_ms: ftsDel };
}

/**
 * The spans belonging to the attempt whose clock was retained.
 *
 * MIRRORS `selectFitted`'s rule (`eval/e1-schedule.mjs`) exactly, and exists
 * because that function predates this experiment and cannot be changed: it is
 * E1's, and every completed record depends on it.
 *
 * The defect this closes was real and it fired on the first schedule. Gate 3
 * retakes a cell up to three times; when every attempt misses, `selectFitted`
 * retains the FIRST attempt's clock and phases. The driver was pairing that
 * with the LAST attempt's spans, so the tiling gate divided one attempt's spans
 * by another attempt's write phase. It read 0.7318 on a run that actually tiled
 * to 0.9945 and voided it — a false void, and in the opposite direction it
 * would have been a false pass.
 *
 * A ratio of two quantities measured in different runs is not a ratio of
 * anything. Every span/clock pair in a record must come from one attempt.
 *
 * @param {object[]} attempts each carrying its own `write_spans`
 * @param {boolean} gate3Ok whether the final attempt passed Gate 3
 */
export function selectFittedSpans(attempts, gate3Ok) {
  if (attempts.length === 0) return null;
  const fitted = gate3Ok ? attempts[attempts.length - 1] : attempts[0];
  return fitted.write_spans ?? null;
}
