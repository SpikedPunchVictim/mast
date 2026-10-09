// D131 spike: relative imports mast stores with no resolved path, and where the
// TypeScript compiler's own module resolution puts each one.
//   node unresolved-relative.mjs <corpus root> <graph.db>
// Reads the index and the corpus; writes nothing. Compiler options are a fixed
// bundler-style set (no tsconfig is read), so a specifier the compiler resolves
// here only through `paths` is not counted: only relative specifiers are asked.
import ts from 'typescript';
import Database from 'better-sqlite3';
import { join, relative, extname } from 'node:path';

const [root, dbPath] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });
const rows = db
  .prepare(
    `SELECT f.path AS file, i.module AS module FROM imports i JOIN files f ON f.id = i.file_id
     WHERE i.resolved_path IS NULL AND (i.module LIKE './%' OR i.module LIKE '../%' OR i.module IN ('.', '..'))`,
  )
  .all();
const indexed = new Set(db.prepare('SELECT path FROM files').all().map((r) => r.path));
const options = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  allowJs: true,
  resolveJsonModule: true,
};
const kinds = new Map();
const samples = new Map();
for (const row of rows) {
  const from = join(root, row.file);
  const resolved = ts.resolveModuleName(row.module, from, options, ts.sys).resolvedModule;
  let kind;
  if (resolved === undefined) kind = `compiler finds nothing (${extname(row.module) || 'no extension'})`;
  else {
    const rel = relative(root, resolved.resolvedFileName);
    const ext = /\.d\.[cm]?ts$/.exec(rel)?.[0] ?? extname(rel);
    kind = `compiler: ${ext}, ${indexed.has(rel) ? 'file is indexed' : 'file is not indexed'}`;
  }
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  if (!samples.has(kind)) samples.set(kind, []);
  if (samples.get(kind).length < 4) samples.get(kind).push(`${row.file} -> ${row.module}`);
}
console.log(`relative import rows with no resolved path: ${rows.length}`);
for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(6)}  ${kind}`);
  for (const s of samples.get(kind)) console.log(`          ${s}`);
}
