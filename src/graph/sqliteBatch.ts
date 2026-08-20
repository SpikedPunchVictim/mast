// ---------------------------------------------------------------------------
// SQLite bound-parameter batching (Stage 4.5 S1, IMPLEMENTATION_PLAN.md
// "batch `replaceChunksForFile`'s insert", added 2026-08-07).
//
// Placed in graph/ (alongside db.ts) rather than store/: `store/sqliteChunkStore.ts`
// already imports `Db` from `../graph/db.js`, so store -> graph is the existing
// dependency direction. Putting the shared batching helper here lets both
// `store/sqliteChunkStore.ts` and `graph/populate.ts` import it without
// introducing a new edge (graph -> store would be the alternative, and mast has
// no such edge today). mast is one flat align component (CLAUDE.md), so this is
// a placement choice, not a conformance requirement — stated here for the record.
// ---------------------------------------------------------------------------

/**
 * better-sqlite3 12.11.1 / SQLite 3.53.2's default `MAX_VARIABLE_NUMBER` — the
 * maximum number of `?` bound parameters a single statement may carry. A
 * multi-row `INSERT ... VALUES (?, ?, ...), (?, ?, ...), ...` binds
 * `columns * rows` parameters; exceeding this throws `SqliteError: too many
 * SQL variables` and (inside a transaction) rolls back everything the
 * transaction had written so far. Already documented at
 * `store/sqliteChunkStore.ts`'s `getChunksByIds` (bounded by the caller, no
 * batching needed there); this constant is the shared source of truth for
 * every site that DOES need batching.
 */
export const SQLITE_MAX_VARIABLES = 32_766;

/**
 * Splits `rows` into batches sized so that `batch.length * columnsPerRow`
 * never exceeds {@link SQLITE_MAX_VARIABLES}, where `columnsPerRow` is the
 * number of keys on `rows[0]`.
 *
 * ASSUMPTION: every row in `rows` has the same key count as `rows[0]`. This
 * holds for every call site in mast — each builds its rows through one
 * fixed-shape mapper (`chunkToRow`, the `symbols.map(...)` object literal in
 * `populate.ts`, etc.), never a mapper that conditionally includes/omits
 * keys — so row 0 is authoritative and this function does not re-check every
 * row (that would defeat the point of a cheap batching helper).
 *
 * Empty input returns `[]`, not `[[]]` — callers that already guard
 * `if (rows.length > 0)` before inserting keep that guard; this only removes
 * the *second* guard (staying under the parameter ceiling).
 */
export function chunkRowsForSqlite<T extends object>(
  rows: readonly T[],
): readonly (readonly T[])[] {
  if (rows.length === 0) return [];
  const first = rows[0];
  // Unreachable given the length check above; `noUncheckedIndexedAccess`
  // still types `rows[0]` as `T | undefined`, so this is a real (if
  // defensive) branch rather than a `!` assertion (CLAUDE.md §3.1).
  if (first === undefined) return [];
  const columnsPerRow = Object.keys(first).length;
  // A 0-column row shape binds no parameters at all, so the whole array fits
  // in one batch; guard division-by-zero rather than let it fall out of the
  // Math.floor below.
  const rowsPerBatch = columnsPerRow > 0
    ? Math.max(1, Math.floor(SQLITE_MAX_VARIABLES / columnsPerRow))
    : rows.length;
  return chunk(rows, rowsPerBatch);
}

/**
 * Splits `values` into batches sized so that `batch.length * paramsPerValue`
 * never exceeds {@link SQLITE_MAX_VARIABLES}. Sibling to
 * {@link chunkRowsForSqlite} for call sites binding bare scalars (e.g. an
 * `IN (?, ?, ...)` name list) rather than object rows — `paramsPerValue`
 * defaults to 1, the parameter each value contributes to an `IN` list.
 *
 * `reservedParams` is the number of bound parameters the SAME statement binds
 * outside this list — a `MATCH` expression, a `LIMIT`, any other predicate.
 * It defaults to 0 because most call sites bind nothing else, but a batch
 * sized to exactly the ceiling overflows the moment the statement binds one
 * more: measured, `searchFts` (whose statement also binds its MATCH
 * expression and its LIMIT) threw `too many SQL variables` at a batch of
 * exactly {@link SQLITE_MAX_VARIABLES} paths until it declared its two.
 *
 * Empty input returns `[]`, matching {@link chunkRowsForSqlite}.
 */
export function chunkValuesForSqlite<T>(
  values: readonly T[],
  paramsPerValue = 1,
  reservedParams = 0,
): readonly (readonly T[])[] {
  if (values.length === 0) return [];
  const budget = SQLITE_MAX_VARIABLES - reservedParams;
  const valuesPerBatch = paramsPerValue > 0
    ? Math.max(1, Math.floor(budget / paramsPerValue))
    : values.length;
  return chunk(values, valuesPerBatch);
}

/** Plain array-slicing chunker shared by both batching functions above. */
function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
