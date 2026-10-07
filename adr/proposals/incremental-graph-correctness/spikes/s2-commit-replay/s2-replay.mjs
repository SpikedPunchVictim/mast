// S2 + S4 — replay the last N first-parent commits of a real repository through
// `mast index --incremental`, one commit at a time, then compare the graph with
// a full index of the final tree. Along the way, classify what each commit did
// to each changed file (S4).
//
// Throwaway. Usage: node s2-replay.mjs <mast-dist-dir> <git-clone> <N> <out-dir>
// The clone is a scratch copy: this script checks commits out in it and deletes
// its `.mast` directory. It never runs against a working checkout.
//
// Three graphs at the end, all dumped by name:
//   I  the stored graph after the replay
//   F  the stored graph after a fresh full index of the final tree
//   R  the "ordered" graph for the final tree (S1's reference: walk order removed)
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [distArg, repoArg, nArg, outArg] = process.argv.slice(2);
const dist = resolve(distArg);
const repo = resolve(repoArg);
const N = Number(nArg);
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });

const mod = (p) => import(pathToFileURL(join(dist, p)).href);
const { resolveConfig } = await mod('store/config.js');
const { openDatabase, sql } = await mod('graph/db.js');
const { insertEdges, insertReExportFiles } = await mod('graph/populate.js');
const { extractFile } = await mod('ast/extract.js');
const { walkProject } = await mod('indexer/walker.js');

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const mast = (...a) => execFileSync('node', [join(dist, 'cli/index.js'), ...a, repo], { encoding: 'utf8', maxBuffer: 1 << 28 });
const config = () => resolveConfig({ projectRoot: repo });

const edgeKey = (e) => `${e.t}|${e.r}|${e.fp}|${e.fn}|${e.tn}|${e.tp}`;
const dumpEdges = async (h) => (await sql`
  SELECT e.edge_type AS t, COALESCE(e.resolution, '') AS r,
         ff.path AS fp, fs.name AS fn, tf.path AS tp, ts.name AS tn
  FROM edges e
  JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
  JOIN symbols ts ON ts.id = e.to_id   JOIN files tf ON tf.id = ts.file_id
  WHERE COALESCE(e.resolution, '') != 'checker'`.execute(h)).rows;
const dumpStars = async (h) => (await sql`
  SELECT a.path AS f, b.path AS t FROM re_export_files x
  JOIN files a ON a.id = x.from_file_id JOIN files b ON b.id = x.to_file_id`.execute(h)).rows
  .map((x) => `${x.f} => ${x.t}`);
const scalar = async (h, q) => Number((await q.execute(h)).rows[0].n);

const extract = (cfg, rel) => {
  try {
    return extractFile(join(repo, rel), cfg.resolved_project_root, cfg.context_lines,
      cfg.chunk_split_threshold, cfg.markdown_heading_depth);
  } catch { return null; }
};
// What the resolver can see of a file from outside it.
const shape = (r) => r === null ? null : {
  names: [...new Set(r.symbols.filter((s) => s.kind !== 'export').map((s) => s.name))].sort().join('\n'),
  exported: [...new Set(r.symbols.filter((s) => s.isExported && s.kind !== 'export').map((s) => s.name))].sort().join('\n'),
  // name + kind per declaration, in order: the identity M2 would have to key on.
  decls: r.symbols.filter((s) => s.kind !== 'export').map((s) => `${s.kind} ${s.name}`).join('\n'),
  reexports: [
    ...r.starReExports.map((s) => `* ${s.resolvedPath}`),
    ...r.edges.filter((e) => e.edgeType === 'RE_EXPORTS').map((e) => `${e.fromName} <- ${e.toName} ${e.toResolvedPath ?? ''}`),
  ].sort().join('\n'),
  imports: r.imports.map((i) => `${i.resolvedPath ?? i.module} {${[...i.symbols].sort().join(',')}}`).sort().join('\n'),
  outgoing: r.edges.filter((e) => e.edgeType !== 'RE_EXPORTS').map((e) => `${e.edgeType} ${e.fromName}>${e.toName}`).sort().join('\n'),
};

const commits = git('rev-list', '--first-parent', '-n', String(N + 1), 'HEAD').trim().split('\n').reverse();
const finalCommit = commits[commits.length - 1];
git('checkout', '-q', '--detach', commits[0]);
rmSync(join(repo, '.mast'), { recursive: true, force: true });
const initOut = mast('init');

const steps = [];
const lastWrite = new Map();      // file -> last step at which the replay saw it change
const declaredAtStart = new Set(); // `path|name` in the base index
{
  const db = openDatabase(config().resolved_state_dir);
  for (const r of (await sql`SELECT f.path AS p, s.name AS n FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind != 'export'`.execute(db)).rows) {
    declaredAtStart.add(`${r.p}|${r.n}`);
  }
  steps.push({ step: 0, commit: commits[0], edges: await scalar(db, sql`SELECT count(*) AS n FROM edges`),
    stars: await scalar(db, sql`SELECT count(*) AS n FROM re_export_files`) });
  await db.destroy();
}

const kinds = {};
const bump = (k) => { kinds[k] = (kinds[k] ?? 0) + 1; };
for (let i = 1; i < commits.length; i++) {
  const cfgBefore = config();
  const dbBefore = openDatabase(cfgBefore.resolved_state_dir);
  const indexed = new Set((await sql`SELECT path FROM files WHERE language != 'markdown'`.execute(dbBefore)).rows.map((r) => r.path));
  await dbBefore.destroy();

  const changed = git('diff', '--name-status', '--no-renames', commits[i - 1], commits[i]).trim().split('\n')
    .filter((l) => l !== '').map((l) => { const [s, p] = l.split('\t'); return { status: s, path: p }; });
  const before = new Map();
  for (const c of changed) if (c.status !== 'A' && indexed.has(c.path)) before.set(c.path, shape(extract(cfgBefore, c.path)));

  git('checkout', '-q', '--detach', commits[i]);
  const cfg = config();
  const walked = new Set((await walkProject(cfg)).map((e) => e.relativePath));
  const fileKinds = [];
  for (const c of changed) {
    const wasIndexed = before.has(c.path);
    const isCode = walked.has(c.path) && !c.path.endsWith('.md');
    if (!wasIndexed && !isCode) continue; // not a file the graph covers
    lastWrite.set(c.path, i);
    let kind;
    if (!wasIndexed) kind = 'added';
    else if (!existsSync(join(repo, c.path)) || !isCode) kind = 'deleted';
    else {
      const a = before.get(c.path);
      const b = shape(extract(cfg, c.path));
      if (a === null || b === null) kind = 'parse_error';
      else {
        const diff = [];
        if (a.names !== b.names) diff.push('names');
        else if (a.decls !== b.decls) diff.push('decl_order_or_kind');
        if (a.reexports !== b.reexports) diff.push('reexports');
        if (a.imports !== b.imports) diff.push('imports');
        if (a.outgoing !== b.outgoing) diff.push('outgoing_edges');
        kind = diff.length === 0 ? 'body_only' : diff.join('+');
        if (a.exported !== b.exported) bump('modified: exported names changed');
        if (a.names !== b.names) bump('modified: declared names changed');
        if (a.reexports !== b.reexports) bump('modified: re-exports changed');
        if (a.names === b.names && a.reexports === b.reexports) bump('modified: names and re-exports unchanged');
      }
    }
    bump(`file: ${kind === 'added' || kind === 'deleted' || kind === 'parse_error' ? kind : 'modified'}`);
    fileKinds.push({ path: c.path, kind });
  }

  const t = Date.now();
  const out = mast('index', '--incremental');
  const wall = Date.now() - t;
  const m = /files: (\d+) indexed, (\d+) skipped.*duration: (\d+)ms/.exec(out);
  const db = openDatabase(cfg.resolved_state_dir);
  steps.push({ step: i, commit: commits[i], changed_total: changed.length, graph_files: fileKinds,
    indexed: m ? Number(m[1]) : null, duration_ms: m ? Number(m[3]) : null, wall_ms: wall,
    edges: await scalar(db, sql`SELECT count(*) AS n FROM edges`),
    stars: await scalar(db, sql`SELECT count(*) AS n FROM re_export_files`) });
  await db.destroy();
  if (i % 20 === 0) process.stderr.write(`step ${i}/${commits.length - 1} edges ${steps[i].edges}\n`);
}

const statusOut = mast('status');
const dbI = openDatabase(config().resolved_state_dir);
const I = await dumpEdges(dbI);
const starsI = await dumpStars(dbI);
await dbI.destroy();

rmSync(join(repo, '.mast'), { recursive: true, force: true });
mast('init');
const cfg = config();
const dbF = openDatabase(cfg.resolved_state_dir);
const F = await dumpEdges(dbF);
const starsF = await dumpStars(dbF);

// R: S1's ordered reference, built in a transaction that is rolled back.
const parsed = [];
for (const entry of await walkProject(cfg)) {
  const r = extract(cfg, entry.relativePath);
  if (r !== null && (r.edges.length > 0 || r.starReExports.length > 0)) parsed.push({ path: entry.relativePath, edges: r.edges, stars: r.starReExports });
}
let R = [];
class Rollback extends Error {}
try {
  await dbF.transaction().execute(async (trx) => {
    await sql`DELETE FROM edges WHERE COALESCE(resolution, '') != 'checker'`.execute(trx);
    await sql`DELETE FROM re_export_files`.execute(trx);
    for (const f of parsed) await insertReExportFiles(trx, f.path, f.stars);
    let prev = -1;
    for (let pass = 0; pass < 10; pass++) {
      for (const f of parsed) {
        const re = f.edges.filter((e) => e.edgeType === 'RE_EXPORTS');
        if (re.length > 0) await insertEdges(trx, f.path, re);
      }
      const n = await scalar(trx, sql`SELECT count(*) AS n FROM edges`);
      if (n === prev) break;
      prev = n;
    }
    for (const f of parsed) {
      const rest = f.edges.filter((e) => e.edgeType !== 'RE_EXPORTS');
      if (rest.length > 0) await insertEdges(trx, f.path, rest);
    }
    R = await dumpEdges(trx);
    throw new Rollback();
  });
} catch (err) { if (!(err instanceof Rollback)) throw err; }
await dbF.destroy();

const setOf = (rows) => new Set(rows.map(edgeKey));
const sI = setOf(I), sF = setOf(F), sR = setOf(R);
const uniq = (rows) => [...new Map(rows.map((e) => [edgeKey(e), e])).values()];
const tally = (rows, f) => {
  const m = new Map();
  for (const x of rows) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
};
const typeRes = (e) => `${e.t}/${e.r}`;
const touched = (p) => lastWrite.has(p);
// Why is an edge that belongs in the final graph absent after the replay?
const whyLost = (e) => {
  if (!sF.has(edgeKey(e))) return 'a full index lacks it too (walk order, D083)';
  const c = lastWrite.get(e.fp) ?? 0;
  const t = lastWrite.get(e.tp) ?? 0;
  if (t > c) return declaredAtStart.has(`${e.tp}|${e.tn}`)
    ? 'target file re-written after the caller; target declared at the start (D081)'
    : 'target file re-written after the caller; target not declared at the start (D081 or D084)';
  if (touched(e.fp) && t <= c) return 'caller re-written at or after the target (barrel or other path)';
  return 'neither caller nor target file changed in the replay (barrel or other path)';
};
const lostVsR = uniq(R).filter((e) => !sI.has(edgeKey(e)));
const lostVsF = uniq(F).filter((e) => !sI.has(edgeKey(e)));
const notInR = uniq(I).filter((e) => !sR.has(edgeKey(e)));
const gainedOverF = uniq(I).filter((e) => !sF.has(edgeKey(e)) && sR.has(edgeKey(e)));

const timings = steps.slice(1).map((s) => s.duration_ms).filter((x) => x !== null).sort((a, b) => a - b);
const q = (v, p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
const summary = {
  repo, commits: commits.length - 1, base: commits[0], final: finalCommit,
  init_output: initOut.trim().split('\n').slice(-1)[0],
  status_after_replay: statusOut.split('\n').filter((l) => /stale|fresh/.test(l)).map((l) => l.trim()),
  edges: { after_replay_I: sI.size, full_index_F: sF.size, ordered_R: sR.size },
  star_rows: { after_replay: starsI.length, full_index: starsF.length,
    missing_after_replay: starsF.filter((x) => !starsI.includes(x)).length,
    extra_after_replay: starsI.filter((x) => !starsF.includes(x)).length },
  missing_after_replay_vs_full_index: { n: lostVsF.length, by_type: tally(lostVsF, typeRes), by_cause: tally(lostVsF, whyLost) },
  missing_after_replay_vs_ordered: { n: lostVsR.length, by_type: tally(lostVsR, typeRes), by_cause: tally(lostVsR, whyLost) },
  in_replay_graph_but_not_in_ordered: { n: notInR.length, by_type: tally(notInR, typeRes) },
  in_replay_graph_and_ordered_but_not_full_index: { n: gainedOverF.length },
  files_changed_in_replay: lastWrite.size,
  s4_file_changes: kinds,
  s4_modified_detail: tally(steps.slice(1).flatMap((s) => s.graph_files).filter((f) => !['added', 'deleted', 'parse_error'].includes(f.kind)), (f) => f.kind),
  incremental_duration_ms: { n: timings.length, p50: q(timings, 0.5), p90: q(timings, 0.9), max: timings[timings.length - 1] },
  indexed_per_step: (() => { const v = steps.slice(1).map((s) => s.indexed ?? 0).sort((a, b) => a - b); return { p50: q(v, 0.5), p90: q(v, 0.9), max: v[v.length - 1], total: v.reduce((a, b) => a + b, 0) }; })(),
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
writeFileSync(join(outDir, 'steps.json'), JSON.stringify(steps));
writeFileSync(join(outDir, 'missing-vs-full-index.txt'), lostVsF.map((e) => `${whyLost(e)}\t${edgeKey(e)}`).sort().join('\n') + '\n');
writeFileSync(join(outDir, 'missing-vs-ordered.txt'), lostVsR.map((e) => `${whyLost(e)}\t${edgeKey(e)}`).sort().join('\n') + '\n');
writeFileSync(join(outDir, 'not-in-ordered.txt'), notInR.map(edgeKey).sort().join('\n') + '\n');
console.log(JSON.stringify(summary, null, 1));
