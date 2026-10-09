// Spike for D119. For every `exports` subpath of every package.json under a
// directory, replays `sourceOf`'s search (src/indexer/import-resolver.ts) and
// prints which leading directories of the target it dropped to find a file
// under `src/`. Reads only; prints TSV.
//
//   node subpath-drops.mjs <repo dir>
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2];
const EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const probe = (base) => {
  if (isFile(base)) return base;
  for (const e of EXT) if (isFile(base + e)) return base + e;
  for (const e of EXT) if (isFile(join(base, 'index' + e))) return join(base, 'index' + e);
  return null;
};
const targetsOf = (t) => (typeof t === 'string' ? [t] : t && typeof t === 'object' ? Object.values(t).flatMap(targetsOf) : []);
const BUILT = /(?:\.d\.(?:ts|mts|cts)|\.(?:js|jsx|mjs|cjs))$/;

function* manifests(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* manifests(path);
    else if (entry.name === 'package.json') yield path;
  }
}

console.log(['package', 'subpath', 'target', 'dropped', 'kept', 'found', 'root entry source', 'dropped more than one: is it a root entry dir'].join('\t'));
for (const file of manifests(root)) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(file, 'utf-8')); } catch { continue; }
  const exp = manifest.exports;
  if (!exp || typeof exp !== 'object' || !Object.keys(exp).some((k) => k.startsWith('.'))) continue;
  const dir = join(file, '..');
  const rootSource = probe(join(dir, 'src', 'index'));
  // The directories the package's own root entries are written into.
  const rootEntries = [...targetsOf(exp['.']), manifest.module, manifest.main, manifest.types].filter((e) => typeof e === 'string');
  const rootDirs = new Set(rootEntries.map((e) => e.replace(/^\.\//, '').split('/').slice(0, -1).join('/')));
  for (const [key, value] of Object.entries(exp)) {
    if (key === '.' || key.includes('*')) continue;
    for (const target of new Set(targetsOf(value))) {
      const segments = target.replace(/^\.\//, '').replace(BUILT, '').split('/');
      // `sourceOf` takes the target as written when it is itself a TypeScript source.
      const literal = probe(join(dir, target));
      if (literal !== null && /\.(?:ts|tsx|mts|cts)$/.test(literal) && !/\.d\.(?:ts|mts|cts)$/.test(literal)) continue;
      if (segments[0] === 'src') continue;
      let found = null, drop = 1;
      for (; drop < segments.length; drop++) {
        found = probe(join(dir, 'src', ...segments.slice(drop)));
        if (found !== null) break;
      }
      console.log([
        manifest.name, key, target,
        found === null ? '-' : segments.slice(0, drop).join('/'),
        found === null ? '-' : segments.slice(drop).join('/'),
        found === null ? 'NONE' : relative(dir, found),
        found !== null && found === rootSource ? 'SAME AS ROOT' : '',
        found === null || drop === 1 ? '' : rootDirs.has(segments.slice(0, drop).join('/')) ? 'root dir' : 'NOT A ROOT DIR',
      ].join('\t'));
    }
  }
}
