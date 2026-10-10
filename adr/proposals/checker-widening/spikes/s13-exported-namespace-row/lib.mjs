import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from '/Users/spikedpunchvictim/projects/mast/node_modules/better-sqlite3/lib/index.js';
const D = process.env.MAST_DIST ?? '/Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/mast-ns/dist';
const { runIndex } = await import(`${D}/indexer/index.js`);
const { resolveConfig } = await import(`${D}/store/config.js`);
export const ROOT = '/Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/review-ns';
let clock = Math.floor(Date.now() / 1000);
export function mk(name) { mkdirSync(join(ROOT, 'p'), { recursive: true }); return mkdtempSync(join(ROOT, 'p', name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '-')); }
export function write(dir, files) {
  clock += 3;
  for (const [p, c] of Object.entries(files)) {
    const a = join(dir, p);
    if (c === null) { rmSync(a, { force: true }); continue; }
    mkdirSync(dirname(a), { recursive: true });
    let prev = clock; try { prev = Math.max(prev, Math.floor(statSync(a).mtimeMs / 1000) + 2); } catch {}
    writeFileSync(a, c); utimesSync(a, prev, prev); clock = prev;
  }
}
const cfg = (dir, state) => resolveConfig({ projectRoot: dir, stateDirOverride: state });
export async function full(dir, state) { await runIndex(cfg(dir, state), { incremental: false }); }
export async function incr(dir, state) { return runIndex(cfg(dir, state), { incremental: true }); }
export function dump(state) {
  const db = new Database(join(state, 'graph.db'), { readonly: true });
  const edges = db.prepare(`SELECT e.edge_type||' ['||COALESCE(e.resolution,'')||'] '||ff.path||':'||fs.name||' -> '||tf.path||':'||ts.name||'@'||ts.line AS l FROM edges e JOIN symbols fs ON fs.id=e.from_id JOIN files ff ON ff.id=fs.file_id JOIN symbols ts ON ts.id=e.to_id JOIN files tf ON tf.id=ts.file_id`).all().map(r => r.l);
  const imports = db.prepare(`SELECT f.path||' <- '||i.module||' '||i.symbols||' al='||COALESCE(i.aliases,'')||' ea='||COALESCE(i.exported_as,'')||' ext='||i.is_external||' -> '||COALESCE(i.resolved_path,'NULL') AS l FROM imports i JOIN files f ON f.id=i.file_id`).all().map(r => r.l);
  const stars = db.prepare(`SELECT a.path||' => '||b.path AS l FROM re_export_files x JOIN files a ON a.id=x.from_file_id JOIN files b ON b.id=x.to_file_id`).all().map(r => r.l);
  db.close();
  const rel = (s) => s;
  return { edges: [...new Set(edges)].sort().map(rel), imports: imports.sort(), stars: stars.sort() };
}
export function callEdges(d) { return d.edges.filter(e => !e.startsWith('RE_EXPORTS') ); }
export function diff(a, b) {
  const out = [];
  for (const k of ['edges', 'imports', 'stars']) {
    const A = new Set(a[k]), B = new Set(b[k]);
    for (const x of A) if (!B.has(x)) out.push(`  [${k}] incremental-only: ${x}`);
    for (const x of B) if (!A.has(x)) out.push(`  [${k}] full-only:        ${x}`);
  }
  return out;
}
export function tsc(dir, extra = {}) {
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, noEmit: true, allowJs: true, experimentalDecorators: true, skipLibCheck: true, ...extra }, include: ['src'] }));
  try { execFileSync('/Users/spikedpunchvictim/projects/mast/node_modules/.bin/tsc', ['-p', dir], { encoding: 'utf8', stdio: 'pipe' }); return 'tsc: OK'; }
  catch (e) { return 'tsc: ' + (e.stdout || e.message).trim().split('\n').slice(0, 4).join(' | ').replaceAll(dir + '/', ''); }
}
/** scenario: {name, files, steps?: [{...files}], tsc?: bool} */
export async function run(sc) {
  const dir = mk(sc.name); const st = join(dir, '.st'); const strip = (s) => s.replaceAll(dir + '/', '');
  write(dir, sc.files);
  console.log(`\n=== ${sc.name}`);
  if (sc.tsc !== false) console.log('  ' + tsc(dir, sc.tscOptions));
  rmSync(join(dir, 'tsconfig.json'), { force: true });
  await full(dir, st);
  const d0 = dump(st);
  for (const e of callEdges(d0)) console.log('  full: ' + strip(e));
  if (sc.showImports) for (const e of d0.imports) console.log('  imp:  ' + strip(e));
  let n = 0;
  for (const step of sc.steps ?? []) {
    n++; write(dir, step); await incr(dir, st);
    const fresh = join(dir, `.fresh${n}`); await full(dir, fresh);
    const a = dump(st), b = dump(fresh); const df = diff(a, b);
    console.log(`  step ${n} ${JSON.stringify(Object.keys(step))}: ${df.length === 0 ? 'incremental == full' : 'MISMATCH'}`);
    for (const l of df) console.log(strip(l));
    if (sc.showAfter) for (const e of callEdges(b)) console.log('    fullAfter: ' + strip(e));
    rmSync(fresh, { recursive: true, force: true });
  }
  return dir;
}
