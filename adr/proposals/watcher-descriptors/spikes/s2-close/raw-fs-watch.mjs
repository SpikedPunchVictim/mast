#!/usr/bin/env node
/**
 * Spike for D161: where the time of closing a watcher goes.
 *
 *   node raw-fs-watch.mjs <tree> [how many of each]
 *
 * No chokidar and no mast: `fs.watch` on the directories of a tree, then on the same
 * number of its files, each closed in turn and timed. `node_modules` and `.git` are left
 * out. Reads the tree, writes nothing.
 */
import { readdirSync, watch } from 'node:fs';
import { join } from 'node:path';

const [tree, limitArg] = process.argv.slice(2);
if (!tree) { console.error('usage: raw-fs-watch.mjs <tree> [how many of each]'); process.exit(2); }
const dirs = [], files = [];
const walk = (dir) => {
  dirs.push(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) walk(join(dir, entry.name));
    else if (entry.isFile()) files.push(join(dir, entry.name));
  }
};
walk(tree);
const limit = Number(limitArg ?? Math.min(dirs.length, files.length));

function time(label, paths) {
  const openStart = performance.now();
  const handles = paths.map((p) => watch(p, { persistent: true }, () => {}));
  const opened = performance.now() - openStart;
  const perClose = [];
  const closeStart = performance.now();
  for (const handle of handles) { const t = performance.now(); handle.close(); perClose.push(performance.now() - t); }
  const closed = performance.now() - closeStart;
  const sorted = [...perClose].sort((a, b) => a - b);
  console.log(JSON.stringify({ what: label, handles: paths.length, open_ms: Math.round(opened), close_ms: Math.round(closed),
    close_each_ms: { first: +perClose[0].toFixed(2), median: +sorted[sorted.length >> 1].toFixed(2), last: +perClose[perClose.length - 1].toFixed(2), max: +sorted[sorted.length - 1].toFixed(2) } }));
}
console.log(JSON.stringify({ tree, directories: dirs.length, files: files.length, of_each: limit, node: process.version, platform: process.platform }));
for (const n of [Math.round(limit / 4), Math.round(limit / 2), limit]) {
  time('directories', dirs.slice(0, n));
  time('files', files.slice(0, n));
}
