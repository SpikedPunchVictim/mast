// Q6: what the clear costs on a large index. usage: node cost.mjs <graph.db copy>
import Sqlite from 'better-sqlite3';
import { statSync, existsSync } from 'node:fs';
import { clearDerived } from './clear.mjs';
const path = process.argv[2];
const size = (p) => (existsSync(p) ? statSync(p).size : 0);
const sqlite = new Sqlite(path);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
const report = (when) =>
  console.log(
    `${when}: db ${size(path)} bytes, wal ${size(`${path}-wal`)} bytes, pages ${sqlite.pragma('page_count', { simple: true })}, free ${sqlite.pragma('freelist_count', { simple: true })}, files ${sqlite.prepare('select count(*) c from files').get().c}, metrics ${sqlite.prepare('select count(*) c from metrics').get().c}`,
  );
report('before');
console.log('clear ms:', clearDerived(sqlite).ms.toFixed(1));
report('after clear');
sqlite.pragma('wal_checkpoint(TRUNCATE)');
report('after checkpoint');
sqlite.close();
