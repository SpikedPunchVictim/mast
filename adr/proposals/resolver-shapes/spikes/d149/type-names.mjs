// D149 spike: for every signature in a checkout's indexed files, the type names
// the old rule took (each capital-first run of letters and digits in the text of
// the parameter types and the return type) against the names read off the tree
// (`typeNames` of the built extractor). Built-in names are dropped from both, as
// the tool drops them. Reads the checkout and the index; writes nothing.
//   MAST_DIST=<repo>/dist node type-names.mjs <checkout> <graph.db>
import Database from 'better-sqlite3';
import { join } from 'node:path';

const { extractFileSignatures } = await import(join(process.env.MAST_DIST, 'ast/extract.js'));
const [root, dbPath] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });
const files = db.prepare(`SELECT path FROM files WHERE path GLOB '*.ts' OR path GLOB '*.tsx' OR path GLOB '*.mts' OR path GLOB '*.cts'`).all();
const declared = new Set(db.prepare(`SELECT DISTINCT name FROM symbols WHERE kind IN ('interface','type','class')`).all().map((r) => r.name));
// As in src/mcp/tools/signature.ts.
const BUILTIN = new Set(['string', 'number', 'boolean', 'void', 'null', 'undefined', 'never', 'any', 'unknown', 'object', 'symbol', 'bigint', 'Function', 'Object', 'Promise', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'InstanceType', 'Parameters', 'ConstructorParameters', 'Error']);
const old = (sig) => {
  const names = new Set();
  for (const m of [...sig.params.map((p) => p.type), sig.returnType ?? ''].join(' ').matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) if (!BUILTIN.has(m[1])) names.add(m[1]);
  return names;
};
// Where a name the old rule took is written, by text alone: inside a comment,
// inside a string, or only beside a dot (a part of `a.b.c`). `elsewhere` is
// what is left, and is listed in full.
const has = (text, n) => new RegExp(`\\b${n}\\b`).test(text);
const whereWritten = (n, sig) => {
  const text = [...sig.params.map((p) => p.type), sig.returnType ?? ''].join(' ');
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  if (!has(noComments, n)) return 'in a comment';
  const noStrings = noComments.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, ' ');
  if (!has(noStrings, n)) return 'in a string';
  if (!new RegExp(`(?<![.\\w$])${n}(?![\\w$]|\\s*\\.)`).test(noStrings)) return 'a part of a dotted name, or a longer name with _ or $';
  return 'elsewhere';
};
let signatures = 0, same = 0, oldNames = 0, newNames = 0;
const gained = [], lost = [];
for (const { path } of files) {
  for (const sig of extractFileSignatures(join(root, path))) {
    signatures++;
    const before = old(sig);
    const after = new Set(sig.typeNames.filter((n) => !BUILTIN.has(n)));
    oldNames += before.size; newNames += after.size;
    let differs = false;
    for (const n of after) if (!before.has(n)) { gained.push([n, path, sig.name]); differs = true; }
    for (const n of before) if (!after.has(n)) { lost.push([n, path, sig.name, whereWritten(n, sig)]); differs = true; }
    if (!differs) same++;
  }
}
const report = (label, rows) => {
  const inIndex = rows.filter(([n]) => declared.has(n));
  console.log(`${label}: ${rows.length} (name, signature) pairs; ${inIndex.length} name an interface, type or class the index declares somewhere`);
  for (const [n, p, s] of inIndex.slice(0, 12)) console.log(`    declared  ${n}  in ${p}:${s}`);
  for (const [n, p, s] of rows.filter(([n]) => !declared.has(n)).slice(0, 8)) console.log(`    not declared  ${n}  in ${p}:${s}`);
};
console.log(`${files.length} files, ${signatures} signatures; ${same} with the same names under both rules`);
console.log(`names under the old rule: ${oldNames}; names off the tree: ${newNames}`);
report('only off the tree (gained)', gained);
report('only under the old rule (lost)', lost);
const places = new Map();
for (const row of lost) { const k = `${row[3]}${declared.has(row[0]) ? ', declared' : ', not declared'}`; places.set(k, (places.get(k) ?? 0) + 1); }
for (const [k, n] of [...places].sort()) console.log(`${String(n).padStart(6)}  lost, written ${k}`);
for (const [n, p, s, w] of lost.filter((r) => r[3] === 'elsewhere')) console.log(`    elsewhere  ${n}  in ${p}:${s}`);
console.log('lost, a part of a dotted name, declared: the distinct names and how many signatures each');
const dotted = new Map();
for (const r of lost.filter((r) => r[3].startsWith('a part') && declared.has(r[0]))) dotted.set(r[0], [...(dotted.get(r[0]) ?? []), `${r[1]}:${r[2]}`]);
for (const [n, where] of dotted) console.log(`    ${n}  ${where.length}  e.g. ${where[0]}`);
