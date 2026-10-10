import { mk, write, full, incr, dump, diff } from './lib.mjs';
import { join } from 'node:path';
import Database from '/Users/spikedpunchvictim/projects/mast/node_modules/better-sqlite3/lib/index.js';
async function go(name, indexSrc, extra = {}) {
  const dir = mk(name); const st = join(dir, '.st');
  const files = { 'src/index.ts': indexSrc, 'src/unrelated.ts': `export function u1(): void {}\n`, 'src/local.ts': `export function loc(): void {}\n`, ...extra };
  for (let i = 0; i < 30; i++) files[`src/c${i}.ts`] = `import { data } from './index';\nimport { loc } from './local';\nexport function f${i}(): void { loc(); void data; }\n`;
  write(dir, files); await full(dir, st);
  const ids = () => { const db = new Database(join(st, 'graph.db'), { readonly: true }); const r = db.prepare(`select f.path p, min(e.rowid) m from edges e join symbols s on s.id=e.from_id join files f on f.id=s.file_id where e.edge_type='POTENTIAL_CALL' group by f.path`).all(); db.close(); return new Map(r.map((x) => [x.p, x.m])); };
  const before = ids();
  write(dir, { 'src/unrelated.ts': `export function u2(): void {}\n` });
  const res = await incr(dir, st);
  const after = ids();
  let rewritten = 0; for (const [p, m] of before) if (after.get(p) !== m) rewritten++;
  console.log(`${name}: files whose call-edge rows were rewritten after editing unrelated.ts: ${rewritten} of ${before.size}`, JSON.stringify(res ?? null).slice(0, 300));
}
await go('fan-unresolved-json', `export * as data from './data.json';\n`, { 'src/data.json': `{}` });
await go('fan-unresolved-missing', `export * as data from './generated';\n`);
await go('fan-resolved', `export * as data from './local';\n`);
await go('fan-control-plain-import-unresolved', `import * as data from './data.json';\nexport const x = data;\nexport const data2 = 1;\nexport { data2 as data };\n`);
