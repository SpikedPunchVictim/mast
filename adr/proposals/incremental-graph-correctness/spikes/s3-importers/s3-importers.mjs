// S3 — for each indexed file, how many other files would need their edges
// re-resolved if it changed? Direct importers, and importers through barrels.
//
// Throwaway, read-only. Usage: node s3-importers.mjs <mast-dist-dir> <project-root> <out.json>
// The project must carry a full index.
//
// Per file X:
//   direct     files with an `imports` row whose resolved_path is X
//   via_file   files importing any barrel that re-exports from X, transitively
//              (star or named). Upper bound: counts an importer of the barrel
//              even when it takes nothing that X declares.
//   via_name   as via_file, but only importers whose import from the barrel
//              names something X declares
//   edge       files that hold an edge into a symbol of X in the stored graph
//              (what a re-write of X deletes today, D081). Undercounts by the
//              edges S1 found missing.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [distDir, projectRootArg, outPath] = process.argv.slice(2);
const mod = (p) => import(pathToFileURL(join(resolve(distDir), p)).href);
const { resolveConfig } = await mod('store/config.js');
const { openDatabase, sql } = await mod('graph/db.js');
const { extractFile } = await mod('ast/extract.js');
const { walkProject } = await mod('indexer/walker.js');

const config = resolveConfig({ projectRoot: resolve(projectRootArg) });
const db = openDatabase(config.resolved_state_dir);
const rows = async (q) => (await q.execute(db)).rows;

const files = (await rows(sql`SELECT path, language FROM files`));
const fileSet = new Set(files.map((f) => f.path));
const toFile = (p) => {
  if (p == null) return null;
  if (fileSet.has(p)) return p;
  for (const s of ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js']) {
    if (fileSet.has(p + s)) return p + s;
  }
  return null;
};

// importer file -> Map(imported file -> Set(names))
const importsOf = new Map();
let importRowsUnmatched = 0;
for (const r of await rows(sql`
  SELECT f.path AS p, i.resolved_path AS rp, i.symbols AS s FROM imports i
  JOIN files f ON f.id = i.file_id WHERE i.resolved_path IS NOT NULL`)) {
  const t = toFile(r.rp);
  if (t === null) { importRowsUnmatched++; continue; }
  if (t === r.p) continue;
  let names = [];
  try { names = JSON.parse(r.s); } catch { /* treat as naming nothing */ }
  const m = importsOf.get(r.p) ?? new Map();
  const set = m.get(t) ?? new Set();
  for (const n of names) set.add(n);
  m.set(t, set);
  importsOf.set(r.p, m);
}
// imported file -> Map(importer -> Set(names))
const importersOf = new Map();
for (const [p, m] of importsOf) {
  for (const [t, names] of m) {
    const mm = importersOf.get(t) ?? new Map();
    mm.set(p, names);
    importersOf.set(t, mm);
  }
}

// Declared (non-marker) names per file.
const declared = new Map();
for (const r of await rows(sql`
  SELECT f.path AS p, s.name AS n FROM symbols s JOIN files f ON f.id = s.file_id
  WHERE s.kind != 'export'`)) {
  const set = declared.get(r.p) ?? new Set();
  set.add(r.n);
  declared.set(r.p, set);
}

// Re-export relations from a parse: barrel -> files it re-exports from.
const entries = await walkProject(config);
const barrelsOf = new Map(); // source file -> Set(barrels re-exporting from it)
let reExportTargetsUnmatched = 0;
const addRel = (barrel, target) => {
  const t = toFile(target);
  if (t === null) { reExportTargetsUnmatched++; return; }
  if (t === barrel) return;
  const set = barrelsOf.get(t) ?? new Set();
  set.add(barrel);
  barrelsOf.set(t, set);
};
for (const entry of entries) {
  let r;
  try {
    r = extractFile(entry.path, config.resolved_project_root, config.context_lines,
      config.chunk_split_threshold, config.markdown_heading_depth);
  } catch { continue; }
  for (const s of r.starReExports) if (s.resolvedPath !== null) addRel(entry.relativePath, s.resolvedPath);
  for (const e of r.edges) {
    if (e.edgeType === 'RE_EXPORTS' && e.toResolvedPath != null) addRel(entry.relativePath, e.toResolvedPath);
  }
}

const edgeFiles = new Map();
for (const r of await rows(sql`
  SELECT tf.path AS t, count(DISTINCT ff.path) AS n, count(*) AS e FROM edges e
  JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
  JOIN symbols ts ON ts.id = e.to_id JOIN files tf ON tf.id = ts.file_id
  WHERE ff.id != tf.id GROUP BY tf.path`)) edgeFiles.set(r.t, { files: Number(r.n), edges: Number(r.e) });

const per = [];
for (const f of files) {
  if (f.language === 'markdown') continue;
  const x = f.path;
  const closure = new Set();
  const queue = [x];
  while (queue.length > 0) {
    const cur = queue.pop();
    for (const b of barrelsOf.get(cur) ?? []) {
      if (!closure.has(b) && b !== x) { closure.add(b); queue.push(b); }
    }
  }
  const direct = new Set(importersOf.get(x)?.keys() ?? []);
  const viaFile = new Set(direct);
  const viaName = new Set(direct);
  const names = declared.get(x) ?? new Set();
  for (const b of closure) {
    viaFile.add(b);
    viaName.add(b);
    for (const [imp, impNames] of importersOf.get(b) ?? []) {
      if (imp === x) continue;
      viaFile.add(imp);
      for (const n of impNames) if (names.has(n)) { viaName.add(imp); break; }
    }
  }
  per.push({ path: x, direct: direct.size, barrels: closure.size, via_file: viaFile.size,
    via_name: viaName.size, edge: edgeFiles.get(x)?.files ?? 0, edges_in: edgeFiles.get(x)?.edges ?? 0 });
}

const dist = (key) => {
  const v = per.map((p) => p[key]).sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const over = (n) => v.filter((x) => x > n).length;
  return { zero: v.filter((x) => x === 0).length, p50: q(0.5), p90: q(0.9), p99: q(0.99), p999: q(0.999),
    max: v[v.length - 1], mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2),
    over_10: over(10), over_100: over(100), over_1000: over(1000) };
};
const topBy = (key, n) => [...per].sort((a, b) => b[key] - a[key]).slice(0, n);
const out = {
  project: config.resolved_project_root,
  code_files: per.length,
  import_rows_resolved_to_no_indexed_file: importRowsUnmatched,
  re_export_targets_resolved_to_no_indexed_file: reExportTargetsUnmatched,
  files_that_are_re_exported_by_a_barrel: per.filter((p) => p.barrels > 0).length,
  distribution: { direct: dist('direct'), via_file: dist('via_file'), via_name: dist('via_name'), edge: dist('edge') },
  top_via_name: topBy('via_name', 15),
  top_via_file: topBy('via_file', 5),
  top_edge: topBy('edge', 10),
};
await db.destroy();
writeFileSync(outPath, JSON.stringify({ ...out, per_file: per }, null, 0));
console.log(JSON.stringify(out, null, 1));
