// usage: node query-time.mjs <dist> <project> <relative-file>...
// Touches each file (mtime only), refreshes it the way a read tool does, and
// prints the time taken and how many files are left waiting. Then drains with
// an uncapped incremental run so the next file starts from nothing waiting.
import { utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
const [dist, project, ...files] = process.argv.slice(2);
const { jitRefreshFile } = await import(`${dist}/mcp/tools/_helpers.js`);
const { openDatabase } = await import(`${dist}/graph/db.js`);
const { resolveConfig } = await import(`${dist}/store/config.js`);
const { countPendingEdgeRepairs } = await import(`${dist}/graph/importer-repair.js`);
const { runIndex } = await import(`${dist}/indexer/index.js`);
const config = resolveConfig({ projectRoot: project });
for (const file of files) {
  const abs = join(project, file);
  const next = Math.floor(Math.max(Date.now(), statSync(abs).mtimeMs) / 1000) + 2;
  utimesSync(abs, next, next);
  const db = openDatabase(config.resolved_state_dir);
  const start = performance.now();
  const result = await jitRefreshFile(db, config, file);
  const ms = Math.round(performance.now() - start);
  const pending = await countPendingEdgeRepairs(db);
  await db.destroy();
  const drain = await runIndex(config, { incremental: true });
  console.log(JSON.stringify({ file, ...result, ms, pending, drainReResolved: drain.filesReResolved, drainMs: drain.durationMs, drainPending: drain.edgeRepairsPending }));
}
