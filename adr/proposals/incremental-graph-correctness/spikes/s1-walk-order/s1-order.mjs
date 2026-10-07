// S1 — how many edges does a full index miss, or point at a different target,
// because pass 2 resolves each file's edges in walk order (D083)?
//
// Throwaway. Usage: node s1-order.mjs <mast-dist-dir> <project-root> <out.json>
//
// The project must already carry a fresh FULL index. Everything below runs in
// one transaction that is rolled back, so the index is left as it was found.
//
// Reference graph ("ordered"): with every file row, symbol row, import row and
// star re-export row already present,
//   A. delete every non-checker edge,
//   B. insert RE_EXPORTS edges for all files, repeated until the count stops
//      growing (a barrel re-exporting from a barrel needs the inner edge first),
//   C. insert every other edge for all files.
// The baseline is the edge set the full index left behind. Edges are compared
// by name, not by id.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [distDir, projectRootArg, outPath] = process.argv.slice(2);
const mod = (p) => import(pathToFileURL(join(resolve(distDir), p)).href);
const { resolveConfig } = await mod('store/config.js');
const { openDatabase, sql } = await mod('graph/db.js');
const { insertEdges, insertReExportFiles } = await mod('graph/populate.js');
const { extractFile } = await mod('ast/extract.js');
const { walkProject } = await mod('indexer/walker.js');

const config = resolveConfig({ projectRoot: resolve(projectRootArg) });
const db = openDatabase(config.resolved_state_dir);

const dumpEdges = async (h) => {
  const r = await sql`
    SELECT e.edge_type AS t, COALESCE(e.resolution, '') AS r,
           ff.path AS fp, fs.name AS fn, fs.line AS fl,
           tf.path AS tp, ts.name AS tn, ts.line AS tl
    FROM edges e
    JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
    JOIN symbols ts ON ts.id = e.to_id   JOIN files tf ON tf.id = ts.file_id
    WHERE COALESCE(e.resolution, '') != 'checker'`.execute(h);
  return r.rows;
};
const dumpStars = async (h) => {
  const r = await sql`
    SELECT a.path AS f, b.path AS t FROM re_export_files x
    JOIN files a ON a.id = x.from_file_id JOIN files b ON b.id = x.to_file_id`.execute(h);
  return new Set(r.rows.map((x) => `${x.f} => ${x.t}`));
};
const count = async (h, table) =>
  Number((await sql`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(h)).rows[0].n);
// Source side: where the call is. Target side: what it resolved to.
const srcKey = (e) => `${e.t}|${e.r}|${e.fp}|${e.fn}@${e.fl}|${e.tn}`;
const fullKey = (e) => `${srcKey(e)}|${e.tp}@${e.tl}`;

const t0 = Date.now();
const entries = await walkProject(config);
const parsed = [];
let parseErrors = 0;
for (const entry of entries) {
  try {
    const r = extractFile(entry.path, config.resolved_project_root, config.context_lines,
      config.chunk_split_threshold, config.markdown_heading_depth);
    if (r.edges.length > 0 || r.starReExports.length > 0) {
      parsed.push({ path: entry.relativePath, edges: r.edges, stars: r.starReExports });
    }
  } catch {
    parseErrors++;
  }
}
const parseMs = Date.now() - t0;

const out = { project: config.resolved_project_root, files_walked: entries.length, parseErrors, parseMs };
class Rollback extends Error {}
try {
  await db.transaction().execute(async (trx) => {
    const baseline = await dumpEdges(trx);
    const baseStars = await dumpStars(trx);
    const checkerEdges = Number((await sql`SELECT count(*) AS n FROM edges WHERE resolution = 'checker'`.execute(trx)).rows[0].n);

    await sql`DELETE FROM edges WHERE COALESCE(resolution, '') != 'checker'`.execute(trx);
    await sql`DELETE FROM re_export_files`.execute(trx);
    for (const f of parsed) await insertReExportFiles(trx, f.path, f.stars);
    const refStars = await dumpStars(trx);

    const reExportPasses = [];
    for (let pass = 0; pass < 10; pass++) {
      for (const f of parsed) {
        const re = f.edges.filter((e) => e.edgeType === 'RE_EXPORTS');
        if (re.length > 0) await insertEdges(trx, f.path, re);
      }
      const n = await count(trx, 'edges');
      reExportPasses.push(n);
      if (reExportPasses.length > 1 && n === reExportPasses[reExportPasses.length - 2]) break;
    }
    const t1 = Date.now();
    for (const f of parsed) {
      const rest = f.edges.filter((e) => e.edgeType !== 'RE_EXPORTS');
      if (rest.length > 0) await insertEdges(trx, f.path, rest);
    }
    const resolveMs = Date.now() - t1;
    const reference = await dumpEdges(trx);

    const baseFull = new Set(baseline.map(fullKey));
    const refFull = new Set(reference.map(fullKey));
    const baseSrc = new Set(baseline.map(srcKey));
    const refSrc = new Set(reference.map(srcKey));
    // missing: the ordered graph has an edge from this call and the full index has none.
    // retargeted: both have an edge from this call, to different declarations.
    // extra: the full index has an edge from this call and the ordered graph has none.
    const missing = reference.filter((e) => !baseSrc.has(srcKey(e)));
    const retargetedRef = reference.filter((e) => baseSrc.has(srcKey(e)) && !baseFull.has(fullKey(e)));
    const retargetedBase = baseline.filter((e) => refSrc.has(srcKey(e)) && !refFull.has(fullKey(e)));
    const extra = baseline.filter((e) => !refSrc.has(srcKey(e)));

    const tally = (rows, f) => {
      const m = new Map();
      for (const x of rows) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
      return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
    };
    const top = (o, n) => Object.fromEntries(Object.entries(o).slice(0, n));
    const typeRes = (e) => `${e.t}/${e.r}`;
    Object.assign(out, {
      checker_edges_left_alone: checkerEdges,
      star_rows: { baseline: baseStars.size, reference: refStars.size,
        only_baseline: [...baseStars].filter((x) => !refStars.has(x)).length,
        only_reference: [...refStars].filter((x) => !baseStars.has(x)).length },
      re_exports_edge_count_after_each_pass: reExportPasses,
      resolveMs,
      edges: { baseline: baseline.length, reference: reference.length },
      by_type_baseline: tally(baseline, typeRes),
      by_type_reference: tally(reference, typeRes),
      missing: { n: missing.length, by_type: tally(missing, typeRes),
        distinct_targets: new Set(missing.map((e) => `${e.tp}|${e.tn}@${e.tl}`)).size,
        distinct_caller_files: new Set(missing.map((e) => e.fp)).size,
        top_target_files: top(tally(missing, (e) => e.tp), 15),
        caller_sorts_before_target: missing.filter((e) => e.fp < e.tp).length },
      retargeted: { n_reference_side: retargetedRef.length, n_baseline_side: retargetedBase.length,
        by_type: tally(retargetedRef, typeRes) },
      extra: { n: extra.length, by_type: tally(extra, typeRes) },
      samples: { missing: missing.slice(0, 40), retargeted_reference: retargetedRef.slice(0, 40),
        retargeted_baseline: retargetedBase.slice(0, 40), extra: extra.slice(0, 40) },
    });
    // Variants: how much of the gap does each cheaper ordering close?
    //   stars_first:    star rows for all files, then each file's edges once, in walk order.
    //   re_exports_once: star rows, then RE_EXPORTS edges once in walk order, then the rest.
    const variant = async (reExportPassCount) => {
      await sql`DELETE FROM edges WHERE COALESCE(resolution, '') != 'checker'`.execute(trx);
      for (let p = 0; p < reExportPassCount; p++) {
        for (const f of parsed) {
          const re = f.edges.filter((e) => e.edgeType === 'RE_EXPORTS');
          if (re.length > 0) await insertEdges(trx, f.path, re);
        }
      }
      for (const f of parsed) {
        const es = reExportPassCount === 0 ? f.edges : f.edges.filter((e) => e.edgeType !== 'RE_EXPORTS');
        if (es.length > 0) await insertEdges(trx, f.path, es);
      }
      const got = await dumpEdges(trx);
      const gotFull = new Set(got.map(fullKey));
      const short = reference.filter((e) => !gotFull.has(fullKey(e)));
      return { edges: got.length, short_of_reference: short.length, short_by_type: tally(short, typeRes),
        not_in_reference: got.filter((e) => !refFull.has(fullKey(e))).length };
    };
    out.variants = { stars_first: await variant(0), re_exports_once: await variant(1) };
    throw new Rollback();
  });
} catch (err) {
  if (!(err instanceof Rollback)) throw err;
}
out.edges_after_rollback = await count(db, 'edges');
await db.destroy();
writeFileSync(outPath, JSON.stringify(out, null, 1));
const { samples, ...summary } = out;
console.log(JSON.stringify(summary, null, 1));
