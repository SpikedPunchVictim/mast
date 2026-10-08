// Q1, Q2, Q5: what a second connection sees when the derived tables are dropped
// and re-created under it. usage: node two-connections.mjs <graph.db of a small index>
import Sqlite from 'better-sqlite3';
import { statSync } from 'node:fs';
import { clearDerived, derivedObjects } from './clear.mjs';

const path = process.argv[2];
const open = () => {
  const c = new Sqlite(path);
  c.pragma('journal_mode = WAL');
  c.pragma('foreign_keys = ON');
  c.pragma('busy_timeout = 2000');
  return c;
};
const attempt = (label, fn) => {
  try {
    console.log(`  ${label}:`, JSON.stringify(fn()));
  } catch (err) {
    console.log(`  ${label}: THROWS ${err.code ?? ''} ${err.message}`);
  }
};

const reader = open();
const writer = open();
writer.exec(
  "insert into metrics (tool_name, call_timestamp, tokens_returned, tokens_full_file_upper_bound, duration_ms, session_id, status) values ('spike', 1, 1, 1, 1, 's', 'ok'), ('spike', 2, 1, 1, 1, 's', 'ok')",
);
const cached = {
  'count symbols': reader.prepare('select count(*) c from symbols'),
  'join symbols to files': reader.prepare('select count(*) c from symbols s join files f on f.id = s.file_id'),
  'fts match': reader.prepare("select count(*) c from chunk_fts where chunk_fts match 'function'"),
  'select body_hash': reader.prepare('select count(body_hash) c from symbols'),
  'count metrics': reader.prepare('select count(*) c from metrics'),
};
const runAll = (when) => {
  console.log(when);
  for (const [label, stmt] of Object.entries(cached)) attempt(label, () => stmt.get());
};

console.log('objects that would be dropped:', derivedObjects(writer).map((o) => `${o.type} ${o.name}`).join(', '));
runAll('reader, statements prepared before the clear:');

console.log('\ncase 1: clear with the same columns');
attempt('clear', () => clearDerived(writer));
runAll('reader, same prepared statements, after:');

console.log('\ncase 2: a row written by the writer after the clear');
writer.exec("insert into files (path, language, mtime) values ('a.ts', 'typescript', 1)");
writer.exec("insert into symbols (name, kind, file_id, line, is_exported) values ('a', 'function', 1, 1, 1)");
runAll('reader after one file and one symbol were written:');

console.log('\ncase 3: clear, and symbols comes back without body_hash and with a new NOT NULL column');
attempt('clear', () =>
  clearDerived(writer, (name, sql) =>
    name === 'symbols'
      ? sql.replace(/,\s*body_hash\s+TEXT/i, '').replace(/\)\s*$/, ", shape TEXT NOT NULL DEFAULT 'new')")
      : sql,
  ),
);
console.log('  symbols columns now:', writer.prepare('pragma table_info(symbols)').all().map((c) => c.name).join(','));
runAll('reader, same prepared statements, after:');

console.log('\ncase 4: the reader is in the middle of reading when the clear runs');
clearDerived(writer);
writer.exec("insert into files (path, language, mtime) values ('a.ts', 'typescript', 1)");
const insert = writer.prepare("insert into symbols (name, kind, file_id, line, is_exported) values (?, 'function', 1, ?, 1)");
writer.transaction(() => {
  for (let i = 0; i < 5000; i++) insert.run(`s${i}`, i);
})();
const rows = reader.prepare('select name from symbols order by id').iterate();
const first = rows.next().value;
attempt('clear while a read is open', () => clearDerived(writer));
let seen = 1;
try {
  for (const _ of rows) seen++;
  console.log(`  the open read went on to return ${seen} rows (first ${first.name})`);
} catch (err) {
  console.log(`  the open read THROWS after ${seen} rows: ${err.code ?? ''} ${err.message}`);
}
attempt('a new read by the same reader', () => cached['count symbols'].get());

console.log('\ncase 5: the reader holds a write transaction when the clear runs');
reader.exec('BEGIN IMMEDIATE');
attempt('clear while another connection is writing (busy_timeout 2000)', () => clearDerived(writer));
reader.exec('ROLLBACK');

console.log('\nmetrics rows at the end:', cached['count metrics'].get().c);
console.log('integrity_check:', writer.pragma('integrity_check', { simple: true }));
console.log('page_count:', writer.pragma('page_count', { simple: true }), 'freelist_count:', writer.pragma('freelist_count', { simple: true }), 'bytes:', statSync(path).size);
