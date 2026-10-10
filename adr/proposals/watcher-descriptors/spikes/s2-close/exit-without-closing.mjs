#!/usr/bin/env node
/**
 * Spike for D161: does a process that holds directory watches leave quickly when it does
 * not close them?
 *
 *   node exit-without-closing.mjs <tree> exit|unref|persistent-false
 *
 * `exit`: watch every directory, then `process.exit(0)`. `unref`: watch, `unref()` each
 * handle and let the event loop run dry. `persistent-false`: watch with
 * `{ persistent: false }` and let it run dry. The caller times the process.
 */
import { readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
const [tree, mode] = process.argv.slice(2);
const dirs = [];
const walk = (dir) => {
  dirs.push(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.isDirectory()) walk(join(dir, entry.name));
  }
};
walk(tree);
const start = performance.now();
const handles = dirs.map((d) => watch(d, { persistent: mode !== 'persistent-false' }, () => {}));
if (mode === 'unref') for (const handle of handles) handle.unref();
console.log(JSON.stringify({ mode, directories: dirs.length, opened_ms: Math.round(performance.now() - start) }));
if (mode === 'exit') process.exit(0);
