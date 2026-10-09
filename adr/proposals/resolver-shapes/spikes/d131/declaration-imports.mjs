// D131 spike: in a checkout, the relative specifiers the TypeScript compiler
// resolves to a declaration file, and what mast's extension probe (as of D144)
// does with each. Needs no index; reads the checkout and writes nothing.
//   node declaration-imports.mjs <checkout>...
// Files: .ts .tsx .mts .cts .js .jsx .mjs .cjs outside node_modules, dist, build,
// out, lib, .git. Specifiers: what ts.preProcessFile lists (imports, re-exports,
// dynamic imports and requires with a literal). Compiler options are fixed
// (Bundler resolution, allowJs), no tsconfig is read.
// With MAST_DIST=<repo>/dist the built resolver is asked too, and each line
// gains what it answers now. `test file` is an importer mast's default
// configuration does not index (`*.test.ts`, `*.spec.ts`).
import ts from 'typescript';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const built = process.env.MAST_DIST ? await import(join(process.env.MAST_DIST, 'indexer/import-resolver.js')) : null;
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'lib', '.git']);
const SOURCE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true };

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (SOURCE.test(entry.name)) yield join(dir, entry.name);
  }
}
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const EXTS = ['.ts', '.tsx', '.js', '.jsx'];
const JS_TO_TS = [['.js', ['.ts', '.tsx']], ['.jsx', ['.tsx']], ['.mjs', ['.mts']], ['.cjs', ['.cts']]];
// The probe in src/indexer/import-resolver.ts at commit 569f0f9, relative case.
function mastProbe(base, spec) {
  if (!spec.endsWith('/')) {
    for (const [js, tss] of JS_TO_TS) {
      if (base.endsWith(js)) {
        for (const t of tss) if (isFile(base.slice(0, -js.length) + t)) return base.slice(0, -js.length) + t;
        break;
      }
    }
    if (isFile(base)) return base;
    for (const e of EXTS) if (isFile(base + e)) return base + e;
  }
  for (const e of EXTS) if (isFile(join(base, `index${e}`))) return join(base, `index${e}`);
  return null;
}

for (const root of process.argv.slice(2)) {
  let files = 0, relativeSpecifiers = 0, toDeclaration = 0;
  const outcome = new Map();
  const samples = new Map();
  for (const file of walk(root)) {
    files++;
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName: spec } of info.importedFiles) {
      if (!spec.startsWith('.')) continue;
      relativeSpecifiers++;
      const resolved = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule;
      if (resolved === undefined || !/\.d\.[cm]?ts$/.test(resolved.resolvedFileName)) continue;
      toDeclaration++;
      const mast = mastProbe(resolve(dirname(file), spec), spec);
      const written = /\.d\.[cm]?ts$/.test(spec) ? 'written with .d.ts' : /\.[cm]?jsx?$/.test(spec) ? 'written with a js extension' : 'written without extension';
      let now = '';
      if (built !== null) {
        const got = built.getImportResolver(root).resolve(spec, relative(root, file)).resolvedPath;
        const where = got === null ? 'nothing' : resolve(root, got) === resolve(resolved.resolvedFileName) ? 'the declaration file' : `another file, ${got.slice(got.lastIndexOf('.'))}`;
        now = `; now: ${where}; ${/\.(?:test|spec)\.ts$/.test(file) ? 'test file' : 'indexed file'}`;
      }
      const kind =
        (mast === null ? `before: nothing (${written})`
        : resolve(mast) === resolve(resolved.resolvedFileName) ? `before: the declaration file (${written})`
        : `before: another file, ${mast.slice(mast.lastIndexOf('.'))} (${written})`) + now;
      outcome.set(kind, (outcome.get(kind) ?? 0) + 1);
      if (!samples.has(kind)) samples.set(kind, []);
      if (samples.get(kind).length < 3) samples.get(kind).push(`${relative(root, file)} -> ${spec} = ${relative(root, resolved.resolvedFileName)}`);
    }
  }
  console.log(`${root.split('/').pop()}: ${files} files, ${relativeSpecifiers} relative specifiers, ${toDeclaration} the compiler resolves to a declaration file`);
  for (const [kind, n] of [...outcome].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(7)}  ${kind}`);
    for (const s of samples.get(kind)) console.log(`           ${s}`);
  }
}
