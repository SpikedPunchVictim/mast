/**
 * Unit spec for the SQLite bound-parameter batching helpers (Stage 4.5 S1,
 * IMPLEMENTATION_PLAN.md). Written RED-first against a throwing stub — these
 * tests are the spec `chunkRowsForSqlite`/`chunkValuesForSqlite` must satisfy,
 * not a characterisation of an already-working implementation.
 */
import { describe, it, expect } from 'vitest';
import { SQLITE_MAX_VARIABLES, chunkRowsForSqlite, chunkValuesForSqlite } from '../sqliteBatch.js';

describe('chunkRowsForSqlite', () => {
  it('returns an empty array of batches for empty input', () => {
    expect(chunkRowsForSqlite([])).toEqual([]);
  });

  it('returns a single batch for a single row', () => {
    const rows = [{ a: 1, b: 2 }];
    expect(chunkRowsForSqlite(rows)).toEqual([rows]);
  });

  it('fits exactly `floor(SQLITE_MAX_VARIABLES / columnsPerRow)` rows into one batch', () => {
    // 3 columns/row -> 10,922 rows/batch exactly at the ceiling.
    const columnsPerRow = 3;
    const rowsPerBatch = Math.floor(SQLITE_MAX_VARIABLES / columnsPerRow);
    const rows = Array.from({ length: rowsPerBatch }, (_, i) => ({ a: i, b: i, c: i }));

    const batches = chunkRowsForSqlite(rows);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(rowsPerBatch);
  });

  it('spills the row one past the boundary into a second batch', () => {
    const columnsPerRow = 3;
    const rowsPerBatch = Math.floor(SQLITE_MAX_VARIABLES / columnsPerRow);
    const rows = Array.from({ length: rowsPerBatch + 1 }, (_, i) => ({ a: i, b: i, c: i }));

    const batches = chunkRowsForSqlite(rows);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(rowsPerBatch);
    expect(batches[1]).toHaveLength(1);
  });

  it('a 1-column row shape yields the maximum possible batch size', () => {
    const rows = Array.from({ length: SQLITE_MAX_VARIABLES + 10 }, (_, i) => ({ a: i }));

    const batches = chunkRowsForSqlite(rows);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(SQLITE_MAX_VARIABLES);
    expect(batches[1]).toHaveLength(10);
  });

  it('preserves row content and order across batch boundaries', () => {
    const columnsPerRow = 2;
    const rowsPerBatch = Math.floor(SQLITE_MAX_VARIABLES / columnsPerRow);
    const rows = Array.from({ length: rowsPerBatch + 5 }, (_, i) => ({ id: i, val: `v${i}` }));

    const batches = chunkRowsForSqlite(rows);
    const flattened = batches.flat();

    expect(flattened).toEqual(rows);
  });
});

describe('chunkValuesForSqlite', () => {
  it('returns an empty array of batches for empty input', () => {
    expect(chunkValuesForSqlite([])).toEqual([]);
  });

  it('returns a single batch for a single value', () => {
    expect(chunkValuesForSqlite(['a'])).toEqual([['a']]);
  });

  it('defaults paramsPerValue to 1, batching up to SQLITE_MAX_VARIABLES per batch', () => {
    const values = Array.from({ length: SQLITE_MAX_VARIABLES + 1 }, (_, i) => `name-${i}`);

    const batches = chunkValuesForSqlite(values);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(SQLITE_MAX_VARIABLES);
    expect(batches[1]).toHaveLength(1);
  });

  it('honours an explicit paramsPerValue', () => {
    const paramsPerValue = 2;
    const valuesPerBatch = Math.floor(SQLITE_MAX_VARIABLES / paramsPerValue);
    const values = Array.from({ length: valuesPerBatch + 1 }, (_, i) => i);

    const batches = chunkValuesForSqlite(values, paramsPerValue);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(valuesPerBatch);
    expect(batches[1]).toHaveLength(1);
  });
});
