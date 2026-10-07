// S5 — what does it cost to resolve one file's edges again, with a re-parse
// (M3) and from already-extracted edge records (M4)?
//
// Throwaway. Usage: node s5-cost.mjs <mast-dist-dir> <project-root> <target-file> <sample-size> <out.json>
// Runs in a transaction that is rolled back. The project must carry an index.
//
// Two samples of files: every file holding a stored edge into <target-file>
// (the files a re-write of it would orphan), and a pseudo-random sample of
// files that have at least one edge record.
//
// Per file, timed separately:
//   parse      extractFile (read + tree-sitter + chunking + edge extraction)
//   delete     DELETE the file's outgoing non-checker edges
//   resolve    insertEdges with the file's records
//   decode     JSON.parse of the records' JSON text, standing in for reading
//              them back from a table (M4). Not a real table read.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const [distDir, projectRootArg, targetFile, sampleArg, outPath] = process.argv.slice(2);
const mod = (p) => import(pathToFileURL(join(resolve(distDir), p)).href);
const { resolveConfig } = await mod('store/config.js');
const { openDatabase, sql } = await mod('graph/db.js');
const { insertEdges } = await mod('graph/populate.js');
const { extractFile } = await mod('ast/extract.js');

const config = resolveConfig({ projectRoot: resolve(projectRootArg) });
const db = openDatabase(config.resolved_state_dir);

const holders = (await sql`
  SELECT DISTINCT ff.path AS p FROM edges e
  JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
  JOIN symbols ts ON ts.id = e.to_id JOIN files tf ON tf.id = ts.file_id
  WHERE tf.path = ${targetFile} AND ff.path != ${targetFile}`.execute(db)).rows.map((r) => r.p);
const withEdges = (await sql`
  SELECT DISTINCT f.path AS p FROM files f JOIN symbols s ON s.file_id = f.id
  JOIN edges e ON e.from_id = s.id ORDER BY f.path`.execute(db)).rows.map((r) => r.p);
const n = Number(sampleArg);
const stride = Math.max(1, Math.floor(withEdges.length / n));
const random = withEdges.filter((_, i) => i % stride === 0).slice(0, n);

const run = async (trx, paths) => {
  const rows = [];
  for (const p of paths) {
    const t0 = performance.now();
    let r;
    try {
      r = extractFile(join(config.resolved_project_root, p), config.resolved_project_root, config.context_lines,
        config.chunk_split_threshold, config.markdown_heading_depth);
    } catch { continue; }
    const t1 = performance.now();
    const json = JSON.stringify(r.edges);
    const t2 = performance.now();
    const records = JSON.parse(json);
    const t3 = performance.now();
    await sql`DELETE FROM edges WHERE COALESCE(resolution, '') != 'checker' AND from_id IN
      (SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ${p})`.execute(trx);
    const t4 = performance.now();
    await insertEdges(trx, p, records);
    const t5 = performance.now();
    rows.push({ path: p, records: r.edges.length, json_bytes: json.length,
      parse: t1 - t0, decode: t3 - t2, del: t4 - t3, resolve: t5 - t4 });
  }
  return rows;
};
const stats = (rows, key) => {
  const v = rows.map((r) => r[key]).sort((a, b) => a - b);
  const q = (p) => +v[Math.min(v.length - 1, Math.floor(p * v.length))].toFixed(2);
  return { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1), sum: +v.reduce((a, b) => a + b, 0).toFixed(1) };
};
const summarise = (rows) => ({
  files: rows.length,
  records: stats(rows, 'records'), json_bytes: stats(rows, 'json_bytes'),
  parse_ms: stats(rows, 'parse'), decode_ms: stats(rows, 'decode'), delete_ms: stats(rows, 'del'), resolve_ms: stats(rows, 'resolve'),
  with_reparse_total_ms: +rows.reduce((a, r) => a + r.parse + r.del + r.resolve, 0).toFixed(1),
  from_records_total_ms: +rows.reduce((a, r) => a + r.decode + r.del + r.resolve, 0).toFixed(1),
});

const out = { project: config.resolved_project_root, target: targetFile };
class Rollback extends Error {}
try {
  await db.transaction().execute(async (trx) => {
    const before = Number((await sql`SELECT count(*) AS n FROM edges`.execute(trx)).rows[0].n);
    // Warm-up pass over the first few files, discarded: module load, statement cache.
    await run(trx, random.slice(0, 5));
    const a = await run(trx, holders);
    const b = await run(trx, random);
    const after = Number((await sql`SELECT count(*) AS n FROM edges`.execute(trx)).rows[0].n);
    Object.assign(out, { edges_before: before, edges_after_reresolving_both_samples: after,
      holders_of_target: summarise(a), stride_sample: summarise(b) });
    out.rows = { holders: a, sample: b };
    throw new Rollback();
  });
} catch (err) { if (!(err instanceof Rollback)) throw err; }
await db.destroy();
writeFileSync(outPath, JSON.stringify(out));
const { rows, ...summary } = out;
console.log(JSON.stringify(summary, null, 1));
