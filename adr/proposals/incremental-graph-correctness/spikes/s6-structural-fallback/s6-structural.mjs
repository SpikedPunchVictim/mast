// S6 — decision 1 (D085): what should an `implements` / `extends` edge do when
// nothing in the file says where the target name comes from?
//
// Throwaway. Usage: node s6-structural.mjs <mast-dist-dir> <project-root> <out-dir>
//
// The project must already carry a fresh FULL index. Everything runs in one
// transaction that is rolled back.
//
// For every IMPLEMENTS / EXTENDS record the extractor emits, find the file
// evidence for the target name the way call edges already do (the file's named
// imports first, then a declaration in the same file), then build four graphs:
//   today  the edges the full index stored (first symbol with the name, anywhere)
//   A      evidence where there is any, otherwise today's edge
//   B      evidence only
//   C      evidence where there is any, otherwise the one declaration with that
//          name if the graph holds exactly one
// and ask the real `queryImplementors` for every interface name under each.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [distDir, projectRootArg, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const mod = (p) => import(pathToFileURL(join(resolve(distDir), p)).href);
const { resolveConfig } = await mod('store/config.js');
const { openDatabase, sql } = await mod('graph/db.js');
const { insertEdges, insertReExportFiles } = await mod('graph/populate.js');
const { queryImplementors } = await mod('graph/queries.js');
const { extractFile } = await mod('ast/extract.js');
const { walkProject } = await mod('indexer/walker.js');

// Names TypeScript's own lib files declare at the top level (Error, Map, HTMLElement, ...).
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
const rows = async (h, q) => (await q.execute(h)).rows;

const entries = await walkProject(config);
const parsed = [];
for (const entry of entries) {
  try {
    const r = extractFile(entry.path, root, config.context_lines, config.chunk_split_threshold, config.markdown_heading_depth);
    if (r.edges.length > 0 || r.starReExports.length > 0) parsed.push({ path: entry.relativePath, edges: r.edges, stars: r.starReExports });
  } catch { /* counted by S1 */ }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// How the file brings `name` into scope, when it is neither a named import mast
// recorded nor a declaration mast recorded. Returns { how, spec }.
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

const out = { project: root, files_walked: entries.length, lib_globals: libGlobals.size };
class Rollback extends Error {}
try {
  await db.transaction().execute(async (trx) => {
    const symRows = await rows(trx, sql`SELECT s.id, s.name, s.kind, s.line, f.path FROM symbols s JOIN files f ON f.id = s.file_id`);
    const symById = new Map(symRows.map((s) => [s.id, s]));
    const byName = new Map();
    const byFileName = new Map();
    for (const s of symRows) {
      if (s.kind !== 'export') {
        if (!byName.has(s.name)) byName.set(s.name, []);
        byName.get(s.name).push(s);
      }
      // insertEdges builds its from-map the same way: last row for the name wins.
      byFileName.set(`${s.path}\n${s.name}`, s);
    }
    const sameFile = (path, name) => symRows.find((s) => s.path === path && s.name === name && s.kind !== 'export') ?? null;
    const sameFileIdx = new Map();
    for (const s of symRows) if (s.kind !== 'export' && !sameFileIdx.has(`${s.path}\n${s.name}`)) sameFileIdx.set(`${s.path}\n${s.name}`, s);
    void sameFile;

    const importRows = await rows(trx, sql`SELECT f.path, i.module, i.symbols, i.resolved_path FROM imports i JOIN files f ON f.id = i.file_id ORDER BY i.rowid`);
    const importsByFile = new Map();   // path -> Map(name -> resolved_path | null), first write wins
    const moduleByFile = new Map();    // path -> Map(module -> resolved_path | null)
    const moduleOfName = new Map();    // "path\nname" -> module specifier
    for (const r of importRows) {
      if (!importsByFile.has(r.path)) { importsByFile.set(r.path, new Map()); moduleByFile.set(r.path, new Map()); }
      const idx = importsByFile.get(r.path);
      let names = [];
      try { names = JSON.parse(r.symbols); } catch { /* names nothing */ }
      for (const n of names) if (!idx.has(n)) { idx.set(n, r.resolved_path); moduleOfName.set(`${r.path}\n${n}`, r.module); }
      if (!moduleByFile.get(r.path).has(r.module)) moduleByFile.get(r.path).set(r.module, r.resolved_path);
    }

    const structural = async () => rows(trx, sql`
      SELECT e.edge_type AS t, ff.path AS fp, fs.name AS fn, e.from_id, e.to_id
      FROM edges e JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
      WHERE e.edge_type IN ('IMPLEMENTS', 'EXTENDS')`);
    const todayEdges = await structural();
    const todayByKey = new Map();
    for (const e of todayEdges) todayByKey.set(`${e.t}\n${e.fp}\n${e.fn}\n${symById.get(e.to_id).name}`, e.to_id);
    const todayParentOf = await rows(trx, sql`
      SELECT ff.path AS fp, tf.path AS tp FROM edges e
      JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
      JOIN symbols ts ON ts.id = e.to_id JOIN files tf ON tf.id = ts.file_id
      WHERE e.edge_type = 'PARENT_OF'`);

    // Named re-exports to a fixed point first, so a barrel chain does not depend
    // on walk order (S1) when the evidence path follows it.
    await sql`DELETE FROM edges WHERE edge_type = 'RE_EXPORTS'`.execute(trx);
    await sql`DELETE FROM re_export_files`.execute(trx);
    for (const f of parsed) await insertReExportFiles(trx, f.path, f.stars);
    let last = -1;
    for (let pass = 0; pass < 10; pass++) {
      for (const f of parsed) {
        const re = f.edges.filter((e) => e.edgeType === 'RE_EXPORTS');
        if (re.length > 0) await insertEdges(trx, f.path, re);
      }
      const n = Number((await rows(trx, sql`SELECT count(*) AS n FROM edges WHERE edge_type = 'RE_EXPORTS'`))[0].n);
      if (n === last) break;
      last = n;
    }
    out.re_exports_edges_at_fixed_point = last;

    // The real resolver for "this name, in that file, through its barrels" is
    // private; a probe RE_EXPORTS record takes the same path through insertEdges.
    const probeCache = new Map();
    let probeBlocked = 0;
    const resolveIn = async (file, fromName, path, toName) => {
      const key = `${path}\n${toName}`;
      if (probeCache.has(key)) return probeCache.get(key);
      await insertEdges(trx, file, [{ fromName, toName, edgeType: 'RE_EXPORTS', toResolvedPath: path, resolution: 's6probe' }]);
      const got = await rows(trx, sql`SELECT to_id FROM edges WHERE resolution = 's6probe'`);
      await sql`DELETE FROM edges WHERE resolution = 's6probe'`.execute(trx);
      let id = got[0]?.to_id ?? null;
      if (id === null) {
        // ON CONFLICT DO NOTHING hides the probe if the same from-symbol already re-exports the target.
        const from = byFileName.get(`${file}\n${fromName}`);
        const pre = from ? await rows(trx, sql`SELECT to_id FROM edges WHERE from_id = ${from.id} AND edge_type = 'RE_EXPORTS'`) : [];
        const hit = pre.find((r) => symById.get(r.to_id)?.name === toName);
        if (hit) { id = hit.to_id; probeBlocked++; }
      }
      probeCache.set(key, id);
      return id;
    };

    // The same lookup with the gap found by this spike closed: a name that a
    // file reached through `export *` re-exports by name (star, then named).
    const starFiles = async (path) => (await rows(trx, sql`
      WITH RECURSIVE chain(file_id) AS (
        SELECT x.to_file_id FROM re_export_files x JOIN files f ON f.id = x.from_file_id WHERE f.path = ${path}
        UNION SELECT x.to_file_id FROM re_export_files x JOIN chain c ON c.file_id = x.from_file_id)
      SELECT f.path FROM chain c JOIN files f ON f.id = c.file_id ORDER BY f.path`)).map((r) => r.path);
    const starCache = new Map();
    const resolveStarThenNamed = async (file, fromName, path, toName) => {
      const exact = (await rows(trx, sql`SELECT path FROM files WHERE path >= ${path} ORDER BY path LIMIT 1`))[0]?.path;
      if (exact === undefined || !exact.startsWith(path)) return null;
      if (!starCache.has(exact)) starCache.set(exact, await starFiles(exact));
      for (const p of starCache.get(exact)) {
        const id = await resolveIn(file, fromName, p, toName);
        if (id !== null) return id;
      }
      return null;
    };

    const records = [];
    const srcCache = new Map();
    const srcOf = (p) => { if (!srcCache.has(p)) srcCache.set(p, readFileSync(join(root, p), 'utf8')); return srcCache.get(p); };
    for (const f of parsed) {
      const seen = new Set();
      for (const e of f.edges) {
        if (e.edgeType !== 'IMPLEMENTS' && e.edgeType !== 'EXTENDS') continue;
        const k = `${e.edgeType}\n${e.fromName}\n${e.toName}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const from = byFileName.get(`${f.path}\n${e.fromName}`) ?? null;
        const rec = { type: e.edgeType, file: f.path, from: e.fromName, to: e.toName, from_id: from?.id ?? null };
        const candidates = byName.get(e.toName) ?? [];
        rec.candidates = candidates.length;
        rec.candidate_files = new Set(candidates.map((c) => c.path)).size;
        rec.today = todayByKey.get(`${e.edgeType}\n${f.path}\n${e.fromName}\n${e.toName}`) ?? null;
        const imp = importsByFile.get(f.path);
        if (imp?.has(e.toName)) {
          const path = imp.get(e.toName);
          rec.module = moduleOfName.get(`${f.path}\n${e.toName}`);
          if (path === null) { rec.evidence = 'import_external'; rec.ev_target = null; }
          else {
            rec.ev_target = await resolveIn(f.path, e.fromName, path, e.toName);
            rec.evidence = rec.ev_target === null ? 'import_name_not_found' : 'import';
            rec.import_path = path;
            rec.ev_fixed = rec.ev_target ?? await resolveStarThenNamed(f.path, e.fromName, path, e.toName);
          }
        } else if (sameFileIdx.has(`${f.path}\n${e.toName}`)) {
          rec.evidence = 'same_file';
          rec.ev_target = sameFileIdx.get(`${f.path}\n${e.toName}`).id;
        } else {
          rec.evidence = 'none';
          rec.ev_target = null;
          const sc = scopeOf(srcOf(f.path), e.toName);
          rec.how = sc.how;
          rec.spec = sc.spec;
          // Where the name really comes from, when the source says.
          if (sc.spec !== null) {
            const path = moduleByFile.get(f.path)?.get(sc.spec);
            rec.spec_path = path === undefined ? 'no_import_row' : path;
          }
        }
        records.push(rec);
      }
    }
    // How many call records with `import` evidence hit the same gap.
    const calls = { records: 0, imported_from_a_package_or_unresolved: 0, found: 0, not_found: 0, found_when_gap_closed: 0 };
    const callGapTargets = new Map();
    for (const f of parsed) {
      const seen = new Set();
      const imp = importsByFile.get(f.path);
      for (const e of f.edges) {
        if (e.edgeType !== 'POTENTIAL_CALL' || e.resolution !== 'import' || seen.has(e.toName)) continue;
        seen.add(e.toName);
        calls.records++;
        const path = imp?.get(e.toName) ?? null;
        if (path === null) { calls.imported_from_a_package_or_unresolved++; continue; }
        if ((await resolveIn(f.path, e.fromName, path, e.toName)) !== null) { calls.found++; continue; }
        calls.not_found++;
        if ((await resolveStarThenNamed(f.path, e.fromName, path, e.toName)) !== null) {
          calls.found_when_gap_closed++;
          callGapTargets.set(`${path} :: ${e.toName}`, (callGapTargets.get(`${path} :: ${e.toName}`) ?? 0) + 1);
        }
      }
    }
    out.import_call_records_one_per_file_and_name = calls;
    out.import_call_gap_top_targets = Object.fromEntries([...callGapTargets].sort((a, b) => b[1] - a[1]).slice(0, 15));
    out.probe_blocked_by_existing_edge = probeBlocked;

    const hasEvidence = (r) => r.evidence !== 'none';
    const target = {
      today: (r) => r.today,
      A: (r) => (hasEvidence(r) ? r.ev_target : r.today),
      B: (r) => r.ev_target,
      B_gap_closed: (r) => r.ev_fixed ?? r.ev_target,
      C: (r) => (hasEvidence(r) ? r.ev_target : (r.candidates === 1 ? (byName.get(r.to)[0].id) : null)),
    };

    // Score a guessed target for a record with no evidence.
    const judge = async (r, id) => {
      if (id === null) return 'no_edge';
      const t = symById.get(id);
      if (r.how === 'ts_lib_global') return 'wrong_target_is_a_global';
      if (r.how === 'declared_in_file_not_a_symbol') return t.path === r.file ? 'right' : 'wrong_declared_in_this_file';
      if (r.how === 'type_parameter') return 'wrong_type_parameter';
      if (r.spec != null) {
        if (r.spec_path === null || r.spec_path === 'no_import_row') {
          return r.spec.startsWith('.') ? 'unknown_relative_import_unresolved' : 'wrong_imported_from_a_package';
        }
        if (t.path === r.spec_path) return 'right';
        const via = await resolveIn(r.file, r.from, r.spec_path, t.name);
        if (via === id) return 'right';
        return 'wrong_imported_from_another_file';
      }
      return 'unknown';
    };
    for (const r of records) {
      if (r.evidence !== 'none') continue;
      r.judge_today = await judge(r, r.today);
      r.judge_C = await judge(r, target.C(r));
    }

    const tally = (list, f) => {
      const m = new Map();
      for (const x of list) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
      return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
    };
    const kindOf = (id) => (id === null ? 'no_edge' : symById.get(id).kind);
    const cmp = (r) => {
      if (r.today === null && r.ev_target === null) return 'neither';
      if (r.today === null) return 'evidence_only';
      if (r.ev_target === null) return 'today_only';
      if (r.today === r.ev_target) return 'same';
      return symById.get(r.today).path === symById.get(r.ev_target).path ? 'same_file_other_symbol' : 'other_file';
    };
    const withEv = records.filter(hasEvidence);
    const none = records.filter((r) => !hasEvidence(r));
    out.records = {
      n: records.length,
      by_type: tally(records, (r) => r.type),
      by_evidence: tally(records, (r) => `${r.type}/${r.evidence}`),
      from_symbol_missing: records.filter((r) => r.from_id === null).length,
    };
    out.today = {
      implements_extends_edges: todayEdges.length,
      records_with_an_edge: records.filter((r) => r.today !== null).length,
      parent_of_edges: todayParentOf.length,
      parent_of_cross_file: todayParentOf.filter((e) => e.fp !== e.tp).length,
    };
    const nf = records.filter((r) => r.evidence === 'import_name_not_found');
    const fixedCmp = (r) => (r.ev_fixed == null ? 'still_not_found' : r.today === null ? 'found_today_has_none'
      : r.today === r.ev_fixed ? 'found_same_as_today' : 'found_differs_from_today');
    out.import_name_not_found = {
      n: nf.length,
      with_star_then_named_followed: tally(nf, (r) => `${r.type}/${fixedCmp(r)}`),
      totals: tally(nf, fixedCmp),
      still_not_found_by_import_path: tally(nf.filter((r) => r.ev_fixed == null), (r) => `${r.import_path} :: ${r.to}`),
    };
    const ext = records.filter((r) => r.evidence === 'import_external');
    out.import_external = {
      n: ext.length,
      today_has_an_edge: ext.filter((r) => r.today !== null).length,
      today_edge_by_module: tally(ext.filter((r) => r.today !== null), (r) => `${r.module} :: ${r.to} -> ${symById.get(r.today).path}`),
    };
    out.with_evidence = {
      n: withEv.length,
      today_vs_evidence: tally(withEv, (r) => `${r.type}/${r.evidence}/${cmp(r)}`),
      today_vs_evidence_totals: tally(withEv, cmp),
    };
    out.no_evidence = {
      n: none.length,
      by_how: tally(none, (r) => `${r.type}/${r.how}`),
      candidates: tally(none, (r) => (r.candidates === 0 ? '0' : r.candidates === 1 ? '1' : '2+')),
      today_edge: tally(none, (r) => `${r.type}/${r.judge_today}`),
      today_edge_totals: tally(none, (r) => r.judge_today),
      today_edge_by_how: tally(none.filter((r) => r.today !== null), (r) => `${r.how}/${r.judge_today}`),
      C_edge: tally(none, (r) => `${r.type}/${r.judge_C}`),
      C_edge_totals: tally(none, (r) => r.judge_C),
      today_target_kind: tally(none.filter((r) => r.today !== null), (r) => `${r.type}->${kindOf(r.today)}`),
    };
    out.edges_per_option = {};
    for (const [name, f] of Object.entries(target)) {
      const got = records.map((r) => ({ r, id: f(r) })).filter((x) => x.id !== null);
      out.edges_per_option[name] = {
        n: got.length,
        by_type: tally(got, (x) => x.r.type),
        implements_to_interface: got.filter((x) => x.r.type === 'IMPLEMENTS' && symById.get(x.id).kind === 'interface').length,
        implements_target_kind: tally(got.filter((x) => x.r.type === 'IMPLEMENTS'), (x) => symById.get(x.id).kind),
      };
    }

    // ---- The tool: mast_implementors (queryImplementors) under each option.
    const ifaceNames = [...new Set(symRows.filter((s) => s.kind === 'interface').map((s) => s.name))].sort();
    out.interface_names = ifaceNames.length;
    const classFiles = new Map();
    for (const s of symRows) if (s.kind === 'class') classFiles.set(s.name, (classFiles.get(s.name) ?? 0) + 1);
    const runTool = async () => {
      const pairs = new Map(); // "iface\nclass\nfile\nline" -> methods
      for (const name of ifaceNames) {
        for (const r of await queryImplementors(trx, name)) {
          pairs.set(`${name}\n${r.class_name}\n${r.file_path}\n${r.line}`, [...r.methods].sort().join(','));
        }
      }
      return pairs;
    };
    const tool = {};
    tool.today_stored = await runTool();
    for (const [name, f] of Object.entries(target)) {
      await sql`DELETE FROM edges WHERE edge_type IN ('IMPLEMENTS', 'EXTENDS')`.execute(trx);
      for (const r of records) {
        const id = f(r);
        if (id === null || r.from_id === null) continue;
        await sql`INSERT OR IGNORE INTO edges (from_id, to_id, edge_type) VALUES (${r.from_id}, ${id}, ${r.type})`.execute(trx);
      }
      tool[name] = await runTool();
    }
    // Truth for one (interface name, class) answer, from the record behind it.
    const recByPair = new Map();
    for (const r of records) if (r.type === 'IMPLEMENTS') recByPair.set(`${r.to}\n${r.from}\n${r.file}`, r);
    const pairVerdict = (pair, opt) => {
      const [iface, cls, file] = pair.split('\n');
      const r = recByPair.get(`${iface}\n${cls}\n${file}`);
      if (r === undefined) return 'no_record_for_this_answer';
      if (hasEvidence(r)) return 'evidence';
      if (opt === 'B_gap_closed' && r.evidence === 'import_name_not_found') return 'evidence_star_then_named';
      return opt === 'C' ? r.judge_C : r.judge_today;
    };
    out.tool = {};
    for (const [name, pairs] of Object.entries(tool)) {
      const keys = [...pairs.keys()];
      out.tool[name] = {
        interfaces_with_an_answer: new Set(keys.map((k) => k.split('\n')[0])).size,
        implementors: keys.length,
        by_verdict: tally(keys, (k) => pairVerdict(k, name)),
        not_in_today_stored: keys.filter((k) => !tool.today_stored.has(k)).length,
        missing_vs_today_stored: [...tool.today_stored.keys()].filter((k) => !pairs.has(k)).length,
        implementor_class_name_declared_in_2plus_files: keys.filter((k) => (classFiles.get(k.split('\n')[1]) ?? 0) > 1).length,
      };
    }
    // PARENT_OF by file evidence (the class's own file), measured on option B's graph.
    await sql`DELETE FROM edges WHERE edge_type = 'PARENT_OF'`.execute(trx);
    let parentOf = 0;
    for (const f of parsed) {
      for (const e of f.edges) {
        if (e.edgeType !== 'PARENT_OF') continue;
        const from = sameFileIdx.get(`${f.path}\n${e.fromName}`);
        const to = sameFileIdx.get(`${f.path}\n${e.toName}`);
        if (!from || !to) continue;
        await sql`INSERT OR IGNORE INTO edges (from_id, to_id, edge_type) VALUES (${from.id}, ${to.id}, 'PARENT_OF')`.execute(trx);
        parentOf++;
      }
    }
    await sql`DELETE FROM edges WHERE edge_type IN ('IMPLEMENTS', 'EXTENDS')`.execute(trx);
    for (const r of records) {
      const id = target.B(r);
      if (id !== null && r.from_id !== null) await sql`INSERT OR IGNORE INTO edges (from_id, to_id, edge_type) VALUES (${r.from_id}, ${id}, ${r.type})`.execute(trx);
    }
    const bSameFileParent = await runTool();
    out.parent_of_same_file = {
      records_resolved: parentOf,
      edges: Number((await rows(trx, sql`SELECT count(*) AS n FROM edges WHERE edge_type = 'PARENT_OF'`))[0].n),
      option_B_answers_whose_method_list_changed: [...bSameFileParent].filter(([k, v]) => tool.B.get(k) !== v).length,
    };

    const line = (r) => [r.type, r.file, r.from, r.to, r.evidence, r.how ?? '', r.spec ?? '', r.spec_path ?? '',
      `cands=${r.candidates}/${r.candidate_files}f`,
      `today=${r.today === null ? '-' : `${symById.get(r.today).kind}:${symById.get(r.today).path}`}`,
      `ev=${r.ev_target === null ? '-' : `${symById.get(r.ev_target).kind}:${symById.get(r.ev_target).path}`}`,
      `ev_gap_closed=${r.ev_fixed == null ? '-' : `${symById.get(r.ev_fixed).kind}:${symById.get(r.ev_fixed).path}`}`, r.module ?? '',
      r.judge_today ?? '', r.judge_C ?? ''].join(' | ');
    writeFileSync(join(outDir, 'no-evidence.txt'), none.map(line).sort().join('\n') + '\n');
    writeFileSync(join(outDir, 'evidence-disagrees-with-today.txt'),
      withEv.filter((r) => cmp(r) !== 'same' && cmp(r) !== 'neither').map((r) => `${cmp(r)} | ${line(r)}`).sort().join('\n') + '\n');
    const diff = (a, b) => [...a.keys()].filter((k) => !b.has(k)).map((k) => k.replace(/\n/g, ' | '));
    writeFileSync(join(outDir, 'tool-answers-diff.txt'), [
      '## in today (stored), not in B', ...diff(tool.today_stored, tool.B).map((k) => `${k} | ${pairVerdict(k.replace(/ \| /g, '\n'), 'today')}`),
      '## in B, not in today (stored)', ...diff(tool.B, tool.today_stored),
      '## in today (stored), not in B_gap_closed', ...diff(tool.today_stored, tool.B_gap_closed).map((k) => `${k} | ${pairVerdict(k.replace(/ \| /g, '\n'), 'today')}`),
      '## in B_gap_closed, not in today (stored)', ...diff(tool.B_gap_closed, tool.today_stored),
      '## in C, not in B', ...diff(tool.C, tool.B).map((k) => `${k} | ${pairVerdict(k.replace(/ \| /g, '\n'), 'C')}`),
      '## in A, not in C', ...diff(tool.A, tool.C).map((k) => `${k} | ${pairVerdict(k.replace(/ \| /g, '\n'), 'today')}`),
    ].join('\n') + '\n');
    throw new Rollback();
  });
} catch (err) {
  if (!(err instanceof Rollback)) throw err;
}
out.edges_after_rollback = Number((await rows(db, sql`SELECT count(*) AS n FROM edges`))[0].n);
await db.destroy();
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
