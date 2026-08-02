// Q1/OUTCOME — freeze the live `.mast` into an immutable A/B state dir.
//
// Registered in IMPLEMENTATION_PLAN.md § "Q1/OUTCOME", Mechanism > Frozen index:
// all runs read ONE snapshot so index drift cannot differ between arms.
//
// 🔴 WAL TRAP (the one that cost a prior session a false conclusion): the live
// `.mast/graph.db` runs in WAL mode and a running `mast serve` holds ~8 MB in
// `graph.db-wal`. A plain file copy of `graph.db` alone silently drops every
// page still sitting in the WAL. We therefore use SQLite's backup API, which
// produces a consistent single-file snapshot INCLUDING WAL content, rather
// than cp. Never open with `?mode=ro&immutable=1` here either — that read mode
// is WAL-blind and reports the metrics table as empty.
//
//   node eval/ab-freeze.mjs

import Database from 'better-sqlite3';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LIVE = process.env.MAST_AB_LIVE ?? join(process.cwd(), '..', '..', '.mast');
const FROZEN = process.env.MAST_AB_STATE ?? join(homedir(), '.cache', 'mast-eval', 'ab-state');

if (!existsSync(join(LIVE, 'graph.db'))) {
  console.error(`FATAL: no graph.db at ${LIVE}`);
  process.exit(1);
}

if (existsSync(FROZEN)) {
  console.error(`FATAL: ${FROZEN} already exists. The snapshot is immutable by design —`);
  console.error(`       delete it explicitly if you intend to re-freeze (this invalidates any run scored against it).`);
  process.exit(1);
}

mkdirSync(FROZEN, { recursive: true });
mkdirSync(join(FROZEN, 'lance'), { recursive: true });

// --- graph.db via backup API (WAL-safe) ---
const src = new Database(join(LIVE, 'graph.db'));
const walBytes = existsSync(join(LIVE, 'graph.db-wal')) ? statSync(join(LIVE, 'graph.db-wal')).size : 0;
console.log(`live WAL: ${(walBytes / 1e6).toFixed(1)} MB (must survive the copy)`);

await src.backup(join(FROZEN, 'graph.db'));
src.close();

// --- vectors.lance ---
cpSync(join(LIVE, 'lance'), join(FROZEN, 'lance'), { recursive: true });

// --- config + index metadata ---
for (const f of ['config.json', 'index.json', 'file_manifest.json']) {
  if (existsSync(join(LIVE, f))) cpSync(join(LIVE, f), join(FROZEN, f));
}

// --- verify the snapshot, WAL content included ---
const dst = new Database(join(FROZEN, 'graph.db'), { readonly: true });
const chunks = dst.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
const files = dst.prepare('SELECT COUNT(*) AS n FROM files').get().n;
const fts = dst.prepare('SELECT COUNT(*) AS n FROM chunk_fts').get().n;
dst.close();

const idx = JSON.parse(readFileSync(join(FROZEN, 'index.json'), 'utf8'));

const manifest = {
  frozen_at: new Date().toISOString(),
  source: LIVE,
  frozen: FROZEN,
  live_wal_bytes: walBytes,
  chunks,
  files,
  chunk_fts_rows: fts,
  index_json: idx,
};
writeFileSync(join(FROZEN, 'ab-freeze-manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`frozen -> ${FROZEN}`);
console.log(`  files=${files}  chunks=${chunks}  chunk_fts=${fts}`);
console.log(`  last_indexed=${idx.last_indexed}`);
if (chunks === 0 || fts === 0) {
  console.error('FATAL: zero-chunk snapshot — the WAL was almost certainly dropped. Do not score against this.');
  rmSync(FROZEN, { recursive: true, force: true });
  process.exit(1);
}
