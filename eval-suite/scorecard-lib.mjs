/**
 * The arithmetic of the graph scorecard (`graph-scorecard.mjs`): how two sets of keys are
 * scored against each other, and how two scorecards are compared. Pure, no I/O, tested in
 * `__tests__/scorecard-lib.test.mjs`.
 *
 * A scorecard is `{ items: { <line item>: Buckets } }`. A key names one thing mast stores
 * (a symbol, an edge, an import) by path and name, never by line or row id, so the same
 * thing has the same key in two runs. Each key of an item is in exactly one bucket:
 *
 *   agree     the reference and mast both have it
 *   wrong     mast has it, and the reference puts it somewhere else
 *   lacks     the reference has it and mast does not
 *   extra     mast has it and the reference has nothing there (symbols and imports)
 *   unjudged  mast has it and the reference cannot say
 */

export const BUCKETS = ['agree', 'wrong', 'lacks', 'extra', 'unjudged'];

const sortedUnique = (keys) => [...new Set(keys)].sort();

/** Empty buckets, for an item that is filled key by key. */
export function emptyBuckets() {
  return { agree: [], wrong: [], lacks: [], extra: [], unjudged: [] };
}

/** Score two sets of keys where a key is either present or not, with nothing to get wrong. */
export function scoreSets(referenceKeys, mastKeys) {
  const reference = new Set(referenceKeys);
  const mast = new Set(mastKeys);
  return {
    ...emptyBuckets(),
    agree: sortedUnique([...reference].filter((k) => mast.has(k))),
    lacks: sortedUnique([...reference].filter((k) => !mast.has(k))),
    extra: sortedUnique([...mast].filter((k) => !reference.has(k))),
  };
}

/** Sort and de-duplicate every bucket, so two runs of the same graph give the same file. */
export function normalise(buckets) {
  return Object.fromEntries(BUCKETS.map((b) => [b, sortedUnique(buckets[b] ?? [])]));
}

/**
 * The numbers of one row. `reference` is what the reference says exists: a thing mast has
 * wrong is one the reference has. `mast` is what mast stores.
 */
export function countsOf(buckets) {
  const n = Object.fromEntries(BUCKETS.map((b) => [b, (buckets[b] ?? []).length]));
  return {
    reference: n.agree + n.wrong + n.lacks,
    mast: n.agree + n.wrong + n.extra + n.unjudged,
    ...n,
  };
}

function stateOfEachKey(buckets) {
  const state = new Map();
  for (const b of BUCKETS) for (const key of buckets[b] ?? []) state.set(key, b);
  return state;
}

/**
 * Compare two scorecards item by item and key by key.
 *
 * Counts alone hide a trade: five keys leaving and five arriving is a delta of zero. So
 * each row also carries `moves`, every key whose bucket changed, grouped as
 * `"<before> -> <after>"` with `absent` for a key the run does not have.
 *
 * The comparison fails on either of two things, and lists the keys:
 *   - `lostAgree`: a key that agreed and no longer does. A key that is gone from both
 *     sides is listed as a move and is not a loss: the corpus changed, and had the
 *     reference kept it the key would be in `lacks`.
 *   - `newWrong`: a key that is wrong and was not wrong before
 */
export function compareScorecards(before, after) {
  const items = sortedUnique([...Object.keys(before.items), ...Object.keys(after.items)]);
  const rows = [];
  const lostAgree = [];
  const newWrong = [];
  for (const item of items) {
    const was = before.items[item] ?? emptyBuckets();
    const now = after.items[item] ?? emptyBuckets();
    const wasCounts = countsOf(was);
    const nowCounts = countsOf(now);
    const delta = Object.fromEntries(Object.keys(nowCounts).map((k) => [k, nowCounts[k] - wasCounts[k]]));

    const wasState = stateOfEachKey(was);
    const nowState = stateOfEachKey(now);
    const moves = {};
    for (const key of sortedUnique([...wasState.keys(), ...nowState.keys()])) {
      const from = wasState.get(key) ?? 'absent';
      const to = nowState.get(key) ?? 'absent';
      if (from === to) continue;
      (moves[`${from} -> ${to}`] ??= []).push(key);
      if (from === 'agree' && to !== 'absent') lostAgree.push({ item, key, now: to });
      if (to === 'wrong') newWrong.push({ item, key, was: from });
    }
    rows.push({ item, before: wasCounts, after: nowCounts, delta, moves });
  }
  return { rows, lostAgree, newWrong, pass: lostAgree.length === 0 && newWrong.length === 0 };
}

const COLUMNS = ['reference', 'mast', ...BUCKETS];
const pad = (text, width) => String(text).padStart(width);

/** One scorecard as a table, a row per line item. */
export function formatScorecard(card) {
  const names = Object.keys(card.items).sort();
  const width = Math.max(10, ...names.map((n) => n.length));
  const lines = [`${'line item'.padEnd(width)} ${COLUMNS.map((c) => pad(c, 9)).join(' ')}`];
  for (const name of names) {
    const counts = countsOf(card.items[name]);
    lines.push(`${name.padEnd(width)} ${COLUMNS.map((c) => pad(counts[c], 9)).join(' ')}`);
  }
  return lines.join('\n');
}

const signed = (n) => (n === 0 ? '.' : n > 0 ? `+${n}` : String(n));

/** A comparison as a table of deltas, then the keys that moved, then the verdict. */
export function formatComparison(comparison, { keysPerMove = 20 } = {}) {
  const width = Math.max(10, ...comparison.rows.map((r) => r.item.length));
  const lines = [`${'line item'.padEnd(width)} ${COLUMNS.map((c) => pad(c, 9)).join(' ')}   (after, change)`];
  for (const row of comparison.rows) {
    lines.push(`${row.item.padEnd(width)} ${COLUMNS.map((c) => pad(row.after[c], 9)).join(' ')}`);
    if (COLUMNS.some((c) => row.delta[c] !== 0)) {
      lines.push(`${''.padEnd(width)} ${COLUMNS.map((c) => pad(signed(row.delta[c]), 9)).join(' ')}`);
    }
  }
  const moved = comparison.rows.filter((r) => Object.keys(r.moves).length > 0);
  if (moved.length > 0) lines.push('', 'Keys that changed bucket:');
  for (const row of moved) {
    for (const [move, keys] of Object.entries(row.moves).sort()) {
      lines.push(`  ${row.item}: ${move} (${keys.length})`);
      for (const key of keys.slice(0, keysPerMove)) lines.push(`    ${key}`);
      if (keys.length > keysPerMove) lines.push(`    ... ${keys.length - keysPerMove} more, in the JSON`);
    }
  }
  lines.push(
    '',
    comparison.pass
      ? 'PASS: nothing that agreed was lost, and nothing new is wrong.'
      : `FAIL: ${comparison.lostAgree.length} that agreed no longer do, ${comparison.newWrong.length} newly wrong.`,
  );
  return lines.join('\n');
}
