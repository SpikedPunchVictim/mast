#!/usr/bin/env node
/**
 * Spike s5 for D153: which tsconfig project each file is given to by the checker pass, under
 * the rule it has (the first project that names the file) and under "the nearest tsconfig
 * above the file that names it".
 *
 *   node owners.mjs <corpus root>
 *
 * Needs a built `dist/`. Builds no program.
 */
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..', '..');
const { discoverTsConfigProjects } = await import(join(REPO, 'dist', 'graph', 'checker-resolver.js'));

const root = resolve(process.argv[2]);
const { projects } = discoverTsConfigProjects(root);
const dirOf = (p) => (p.configDir === '.' ? '' : p.configDir);
const first = new Map();
const nearest = new Map();
for (const p of projects) {
  for (const abs of p.fileNames) {
    const rel = relative(root, abs);
    if (rel.startsWith('..') || rel.includes('node_modules/')) continue;
    if (!first.has(rel)) first.set(rel, p);
    const held = nearest.get(rel);
    const inside = dirOf(p) === '' || rel.startsWith(`${dirOf(p)}/`);
    const heldInside = held !== undefined && (dirOf(held) === '' || rel.startsWith(`${dirOf(held)}/`));
    if (held === undefined || (inside && (!heldInside || dirOf(p).length > dirOf(held).length))) nearest.set(rel, p);
  }
}
const count = (owners) => {
  const n = new Map();
  for (const p of owners.values()) n.set(p.configDir, (n.get(p.configDir) ?? 0) + 1);
  return n;
};
const byFirst = count(first);
const byNearest = count(nearest);
const rows = projects.map((p, i) => ({
  order: i + 1,
  project: p.configDir,
  names: p.fileNames.length,
  owns_first: byFirst.get(p.configDir) ?? 0,
  owns_nearest: byNearest.get(p.configDir) ?? 0,
}));
const big = [...rows].sort((a, b) => b.names - a.names).slice(0, 6);
const rootRow = rows.find((r) => r.project === '.');
const onlyRoot = [...nearest].filter(([, p]) => p.configDir === '.').map(([rel]) => rel);
const top = new Map();
for (const rel of onlyRoot) {
  const key = rel.split('/').slice(0, 3).join('/');
  top.set(key, (top.get(key) ?? 0) + 1);
}
console.log(JSON.stringify({
  projects: projects.length,
  files_in_a_project: first.size,
  root: rootRow,
  largest_by_names: big,
  projects_owning_nothing_first: rows.filter((r) => r.owns_first === 0).length,
  projects_owning_nothing_nearest: rows.filter((r) => r.owns_nearest === 0).length,
  root_only_files_by_directory: [...top].sort((a, b) => b[1] - a[1]).slice(0, 15),
}, null, 1));
