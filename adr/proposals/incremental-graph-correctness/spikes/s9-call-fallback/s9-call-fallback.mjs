// S9 — D092: how often does a call edge come from the name-only guess
// (`legacyGlobalFirstMatch` in src/graph/populate.ts), and how often is the
// guess right?
//
// Throwaway. Usage: node s9-call-fallback.mjs <mast-dist-dir> <project-root> <out-dir>
//
// The project must already carry a fresh FULL index. Reads only.
//
// For every POTENTIAL_CALL record the extractor emits with a resolution that
// can reach the guess (field_type, parameter_type, new_expression, or none),
// repeat the resolver's evidence lookup for the receiver's type name: the
// file's recorded named imports first, then a declaration in the same file.
// Where neither exists the guess is what ran. For those, read the stored edge
// (what the guess picked), count the symbols it could have picked, and work
// out from the source how the type name really comes into scope, so the pick
// can be marked right or wrong where a file decides it.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [distDir, projectRootArg, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const mod = (p) => import(pathToFileURL(join(resolve(distDir), p)).href);
const { resolveConfig } = await mod('store/config.js');
const { openDatabase, sql } = await mod('graph/db.js');
const { extractFile } = await mod('ast/extract.js');
const { walkProject } = await mod('indexer/walker.js');

// Names TypeScript's own lib files declare at the top level (Error, Map, ...).
const require = createRequire(join(resolve(distDir), 'x.js'));
const ts = require('typescript');
const libDir = dirname(require.resolve('typescript'));
const libGlobals = new Set();
for (const f of readdirSync(libDir).filter((n) => /^lib\..*\.d\.ts$/.test(n))) {
  const sf = ts.createSourceFile(f, readFileSync(join(libDir, f), 'utf8'), ts.ScriptTarget.Latest, false);
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st) || ts.isClassDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
      if (st.name) libGlobals.add(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) libGlobals.add(d.name.text);
    }
  }
}

const config = resolveConfig({ projectRoot: resolve(projectRootArg) });
const root = config.resolved_project_root;
const db = openDatabase(config.resolved_state_dir);
const rows = async (q) => (await q.execute(db)).rows;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// How the file brings `name` into scope, when it is neither a named import mast
// recorded nor a declaration mast recorded. Same probe as S6.
const scopeOf = (src, name) => {
  const n = esc(name);
  let m;
  if ((m = new RegExp(`import\\s+(?:type\\s+)?${n}\\s*(?:,[^;]*?)?\\s+from\\s+['"]([^'"]+)['"]`).exec(src))) return { how: 'default_import', spec: m[1] };
  if ((m = new RegExp(`import\\s+(?:type\\s+)?\\*\\s+as\\s+${n}\\s+from\\s+['"]([^'"]+)['"]`).exec(src))) return { how: 'namespace_import', spec: m[1] };
  if ((m = new RegExp(`import\\s+(?:type\\s+)?(?:[\\w$]+\\s*,\\s*)?\\{[^}]*\\bas\\s+${n}\\b[^}]*\\}\\s*from\\s+['"]([^'"]+)['"]`).exec(src))) return { how: 'aliased_import', spec: m[1] };
  if ((m = new RegExp(`import\\s+(?:type\\s+)?(?:[\\w$]+\\s*,\\s*)?\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from\\s+['"]([^'"]+)['"]`).exec(src))) return { how: 'named_import_not_recorded', spec: m[1] };
  if ((m = new RegExp(`import\\s+${n}\\s*=\\s*require\\(\\s*['"]([^'"]+)['"]`).exec(src))) return { how: 'import_equals_require', spec: m[1] };
  if ((m = new RegExp(`(?:const|let|var)\\s+(?:${n}|\\{[^}]*\\b${n}\\b[^}]*\\})\\s*=\\s*require\\(\\s*['"]([^'"]+)['"]`).exec(src))) return { how: 'require_call', spec: m[1] };
  if (new RegExp(`(?:class|interface|type|enum|function|const|let|var)\\s+${n}\\b`).test(src)) return { how: 'declared_in_file_not_a_symbol', spec: null };
  if (new RegExp(`<[^>()]*\\b${n}\\b[^>()]*>`).test(src) && name.length <= 2) return { how: 'type_parameter', spec: null };
  if (libGlobals.has(name)) return { how: 'ts_lib_global', spec: null };
  return { how: 'unknown', spec: null };
};

// Workspace packages by name, so an import of one can be told from an npm package.
const fileRows = await rows(sql`SELECT id, path FROM files`);
const workspace = new Map();
for (const dir of new Set(fileRows.flatMap((f) => { const parts = f.path.split('/'); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')); }))) {
  const pkg = join(root, dir, 'package.json');
  if (!existsSync(pkg)) continue;
  try { const name = JSON.parse(readFileSync(pkg, 'utf8')).name; if (typeof name === 'string') workspace.set(name, dir); } catch { /* not a package */ }
}
const workspaceDirOf = (spec) => {
  for (const [name, dir] of workspace) if (spec === name || spec.startsWith(`${name}/`)) return dir;
  return null;
};

const symRows = await rows(sql`SELECT s.id, s.name, s.kind, s.line, f.path FROM symbols s JOIN files f ON f.id = s.file_id`);
const symById = new Map(symRows.map((s) => [s.id, s]));
const byName = new Map();
const sameFileIdx = new Set();
for (const s of symRows) {
  if (s.kind === 'export') continue;
  if (!byName.has(s.name)) byName.set(s.name, []);
  byName.get(s.name).push(s);
  sameFileIdx.add(`${s.path}\n${s.name}`);
}

const importRows = await rows(sql`SELECT f.path, i.module, i.symbols, i.resolved_path FROM imports i JOIN files f ON f.id = i.file_id ORDER BY i.rowid`);
const importsByFile = new Map(); // path -> Set(name)
const moduleByFile = new Map();  // path -> Map(module -> resolved_path | null)
for (const r of importRows) {
  if (!importsByFile.has(r.path)) { importsByFile.set(r.path, new Set()); moduleByFile.set(r.path, new Map()); }
  let names = [];
  try { names = JSON.parse(r.symbols); } catch { /* names nothing */ }
  for (const n of names) importsByFile.get(r.path).add(n);
  if (!moduleByFile.get(r.path).has(r.module)) moduleByFile.get(r.path).set(r.module, r.resolved_path);
}

// Files a name imported from `path` can be declared in: the file, and
// everything it re-exports, by star or by name, to any depth.
const fileIdToPath = new Map(fileRows.map((f) => [f.id, f.path]));
const reExportsFrom = new Map();
const link = (from, to) => { if (!reExportsFrom.has(from)) reExportsFrom.set(from, new Set()); reExportsFrom.get(from).add(to); };
for (const r of await rows(sql`SELECT from_file_id, to_file_id FROM re_export_files`)) link(fileIdToPath.get(r.from_file_id), fileIdToPath.get(r.to_file_id));
for (const r of await rows(sql`SELECT from_id, to_id FROM edges WHERE edge_type = 'RE_EXPORTS'`)) link(symById.get(r.from_id).path, symById.get(r.to_id).path);
const allPaths = fileRows.map((f) => f.path).sort();
const exactFile = (path) => allPaths.find((p) => p === path) ?? allPaths.find((p) => p.startsWith(`${path}.`)) ?? allPaths.find((p) => p.startsWith(`${path}/index.`)) ?? null;
const reachableFrom = (path) => {
  const seen = new Set([path]);
  const queue = [path];
  while (queue.length > 0) for (const next of reExportsFrom.get(queue.pop()) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
};

const callEdges = await rows(sql`
  SELECT ff.path AS fp, fs.name AS fn, e.to_id, e.resolution
  FROM edges e JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
  WHERE e.edge_type = 'POTENTIAL_CALL'`);
const storedByKey = new Map();
const storedByResolution = {};
for (const e of callEdges) {
  storedByKey.set(`${e.fp}\n${e.fn}\n${symById.get(e.to_id).name}\n${e.resolution}`, e.to_id);
  storedByResolution[e.resolution ?? 'none'] = (storedByResolution[e.resolution ?? 'none'] ?? 0) + 1;
}

const GUESSING = new Set(['field_type', 'parameter_type', 'new_expression', undefined, null]);
const entries = await walkProject(config);
const records = [];
const emittedByResolution = {};
let reachRecords = 0;
let extractFailures = 0;
const srcCache = new Map();
const srcOf = (p) => { if (!srcCache.has(p)) srcCache.set(p, readFileSync(join(root, p), 'utf8')); return srcCache.get(p); };
for (const entry of entries) {
  let extracted;
  try {
    extracted = extractFile(entry.path, root, config.context_lines, config.chunk_split_threshold, config.markdown_heading_depth);
  } catch { extractFailures++; continue; }
  const file = entry.relativePath;
  const seen = new Set();
  for (const e of extracted.edges) {
    if (e.edgeType !== 'POTENTIAL_CALL') continue;
    emittedByResolution[e.resolution ?? 'none'] = (emittedByResolution[e.resolution ?? 'none'] ?? 0) + 1;
    if (!GUESSING.has(e.resolution)) continue;
    const key = `${e.fromName}\n${e.toName}\n${e.resolution}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reachRecords++;
    const dot = e.toName.indexOf('.');
    const typeName = e.resolution == null || dot === -1 ? e.toName : e.toName.slice(0, dot);
    if (e.resolution != null && (importsByFile.get(file)?.has(typeName) || sameFileIdx.has(`${file}\n${typeName}`))) continue;

    const candidates = byName.get(e.toName) ?? [];
    const picked = storedByKey.get(`${file}\n${e.fromName}\n${e.toName}\n${e.resolution ?? null}`) ?? null;
    const rec = {
      file, from: e.fromName, to: e.toName, resolution: e.resolution ?? null, type_name: typeName,
      candidates: candidates.length, candidate_files: new Set(candidates.map((c) => c.path)).size,
      picked: picked === null ? null : `${symById.get(picked).path}:${symById.get(picked).line}`,
    };
    const sc = scopeOf(srcOf(file), typeName);
    rec.how = sc.how;
    rec.spec = sc.spec;
    if (picked === null) rec.verdict = 'no_edge';
    else if (sc.spec !== null) {
      const recorded = moduleByFile.get(file)?.get(sc.spec);
      const relative = sc.spec.startsWith('.') ? exactFile(join(dirname(file), sc.spec).replace(/\.(js|mjs|cjs|jsx)$/, '')) : null;
      const source = recorded ?? relative;
      const pickedPath = symById.get(picked).path;
      if (source != null) {
        const exact = exactFile(source) ?? source;
        rec.source = exact;
        rec.verdict = reachableFrom(exact).has(pickedPath) ? 'right' : 'wrong';
      } else {
        const dir = workspaceDirOf(sc.spec);
        if (dir === null) rec.verdict = 'wrong'; // the type comes from a package outside the project
        else { rec.source = `${dir}/`; rec.verdict = pickedPath.startsWith(`${dir}/`) ? 'right_package' : 'wrong'; }
      }
    } else if (sc.how === 'ts_lib_global' || sc.how === 'type_parameter') rec.verdict = 'wrong';
    else rec.verdict = 'undecided';
    records.push(rec);
  }
}

const tally = (list, keyOf) => { const out = {}; for (const r of list) { const k = keyOf(r); out[k] = (out[k] ?? 0) + 1; } return out; };
const withEdge = records.filter((r) => r.picked !== null);
const summary = {
  project: root,
  files_walked: entries.length,
  extract_failures: extractFailures,
  workspace_packages: workspace.size,
  stored_call_edges: callEdges.length,
  stored_call_edges_by_resolution: storedByResolution,
  emitted_call_records_by_resolution: emittedByResolution,
  distinct_records_that_can_reach_the_guess: reachRecords,
  records_where_the_guess_ran: records.length,
  guess_ran_by_resolution: tally(records, (r) => r.resolution ?? 'none'),
  guess_produced_an_edge: withEdge.length,
  guess_edges_by_verdict: tally(withEdge, (r) => r.verdict),
  guess_edges_by_how: tally(withEdge, (r) => `${r.how} / ${r.verdict}`),
  guess_edges_by_candidate_count: tally(withEdge, (r) => (r.candidates === 1 ? '1' : r.candidates <= 3 ? '2-3' : '4+')),
  guess_edges_verdict_by_candidate_count: tally(withEdge, (r) => `${r.candidates === 1 ? 'one candidate' : 'several'} / ${r.verdict}`),
  guess_found_nothing_by_how: tally(records.filter((r) => r.picked === null), (r) => r.how),
};
writeFileSync(join(outDir, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
await db.destroy();
