// For every import alias stored in an index: does resolveTypeContext place the local name
// in the file the import resolves to? Usage: node alias-check.mjs <dist dir> <state dir>
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [dist, state] = process.argv.slice(2);
const { openDatabase } = await import(pathToFileURL(join(dist, 'graph/db.js')).href);
const { resolveTypeContext } = await import(pathToFileURL(join(dist, 'graph/queries.js')).href);
const db = openDatabase(state);
const rows = await db.selectFrom('imports as i').innerJoin('files as f', 'f.id', 'i.file_id')
  .select(['f.path', 'i.aliases', 'i.resolved_path', 'i.is_external']).where('i.aliases', 'is not', null).execute();
const tally = { aliases: 0, external_or_unresolved: 0, in_resolved_file: 0, elsewhere: 0, none: 0 };
const elsewhere = [];
for (const row of rows) {
  for (const local of Object.keys(JSON.parse(row.aliases))) {
    tally.aliases += 1;
    if (row.resolved_path === null) { tally.external_or_unresolved += 1; continue; }
    const [entry] = await resolveTypeContext(db, [local], row.path);
    if (entry === undefined) tally.none += 1;
    else if (entry.file_path.startsWith(row.resolved_path)) tally.in_resolved_file += 1;
    else { tally.elsewhere += 1; elsewhere.push(`${row.path}: ${local} -> ${entry.file_path}`); }
  }
}
await db.destroy();
console.log(JSON.stringify({ tally, elsewhere: elsewhere.slice(0, 8) }, null, 1));
