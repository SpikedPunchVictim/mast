// Throwaway prototype of "clear the derived tables inside graph.db".
// Everything except the two metrics tables is dropped and created again from the
// statements SQLite itself recorded, in one transaction.
const KEPT = new Set(['metrics', 'metrics_daily']);

/** Tables and indexes to drop and re-create: not kept, not SQLite's own, not an FTS shadow table. */
export function derivedObjects(sqlite) {
  const all = sqlite
    .prepare("select type, name, tbl_name, sql from sqlite_master where name not like 'sqlite_%'")
    .all();
  const virtual = all.filter((o) => /^CREATE VIRTUAL TABLE/i.test(o.sql ?? '')).map((o) => o.name);
  const isShadow = (name) => virtual.some((v) => name !== v && name.startsWith(`${v}_`));
  return all.filter((o) => !KEPT.has(o.tbl_name) && !isShadow(o.name) && o.sql !== null);
}

/**
 * @param rewrite optional (name, sql) => sql, to re-create a table with other columns
 * @returns milliseconds spent, and what was dropped
 */
export function clearDerived(sqlite, rewrite = (_name, sql) => sql) {
  const objects = derivedObjects(sqlite);
  const tables = objects.filter((o) => o.type === 'table');
  const started = process.hrtime.bigint();
  // A DROP TABLE with foreign keys on runs an implicit DELETE and checks every
  // reference. The pragma cannot change inside a transaction.
  const fk = sqlite.pragma('foreign_keys', { simple: true });
  sqlite.pragma('foreign_keys = OFF');
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    for (const t of tables) sqlite.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    for (const t of tables) sqlite.exec(rewrite(t.name, t.sql));
    for (const o of objects.filter((x) => x.type !== 'table')) sqlite.exec(o.sql);
    sqlite.exec('COMMIT');
  } catch (err) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw err;
  } finally {
    sqlite.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
  }
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, dropped: tables.map((t) => t.name) };
}
