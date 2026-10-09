#!/usr/bin/env node
/**
 * How many files a watch of a project holds open (D158).
 *
 *   node count.mjs <project root> <label>
 *
 * Starts the watch `mast serve` starts (`startWatchMode` of the built `dist/`, real
 * chokidar, a state directory outside the project so nothing is indexed), waits for it to
 * settle, and counts this process's open descriptors with `lsof`, by type, against the
 * count before the watch started. It indexes nothing and writes nothing in the project.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const { startWatchMode } = await import(join(REPO, 'dist', 'indexer', 'watcher.js'));
const { resolveConfig } = await import(join(REPO, 'dist', 'store', 'config.js'));

const [root, label] = process.argv.slice(2);
if (!root || !label) {
  console.error('usage: count.mjs <project root> <label>');
  process.exit(2);
}

function openByType() {
  const out = execFileSync('lsof', ['-n', '-p', String(process.pid)], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const counts = {};
  for (const line of out.split('\n').slice(1)) {
    const type = line.trim().split(/\s+/)[4];
    if (type) counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

const state = mkdtempSync(join(tmpdir(), 'mast-watch-count-'));
process.env.MAST_STATE_DIR = state;
const before = openByType();
const warnings = [];
const ready = Promise.withResolvers();
const handle = startWatchMode({
  config: resolveConfig({ projectRoot: resolve(root) }),
  runBatch: async () => {},
  onWarn: (message) => { warnings.push(message); },
  onReady: () => { ready.resolve(); },
});
await ready.promise;
const after = openByType();
await handle.close();
rmSync(state, { recursive: true, force: true });

const held = Object.fromEntries(
  [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map((t) => [t, (after[t] ?? 0) - (before[t] ?? 0)]),
);
console.log(JSON.stringify({ label, root: resolve(root), held_by_type: held, warnings: warnings.length }, null, 1));
