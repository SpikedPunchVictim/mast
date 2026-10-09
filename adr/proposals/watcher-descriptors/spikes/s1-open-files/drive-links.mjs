#!/usr/bin/env node
/**
 * The built watcher on the project `symlink-fixture.sh` makes, plus two links to files:
 * which changes start a batch, and what asking the disk about every path costs a start.
 *
 *   node drive-links.mjs <dir given to symlink-fixture.sh> <a larger project root, for the timing>
 */
import { mkdtempSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const R = new URL('../../../../../', import.meta.url).pathname;
const { startWatchMode } = await import(join(R, 'dist/indexer/watcher.js'));
const { resolveConfig } = await import(join(R, 'dist/store/config.js'));
const [dirArg, large] = process.argv.slice(2);
const dir = resolve(dirArg);
const proj = join(dir, 'proj');
if (!existsSync(join(proj, 'src', 'linkfile.ts'))) symlinkSync(join(dir, 'outside', 'f1.ts'), join(proj, 'src', 'linkfile.ts'));
process.env.MAST_STATE_DIR = mkdtempSync(join(tmpdir(), 'mast-drive-links-state-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const batches = [];
let ready = Promise.withResolvers();
const handle = startWatchMode({ config: resolveConfig({ projectRoot: proj }), debounceMs: 200, runBatch: async (p) => { batches.push(p); }, onWarn: (m) => console.log('warn', m), onReady: () => ready.resolve() });
await ready.promise;
const step = async (label, fn) => { const n = batches.length; fn(); await wait(1500); console.log(`${label} -> ${batches.length > n ? 'batch' : 'no batch'}`); };
await step('change the real file', () => writeFileSync(join(proj, 'src', 'real.ts'), `export const x = ${Date.now()};\n`));
await step('change a file in the linked directory, through the link', () => writeFileSync(join(proj, 'linked', 'f2.ts'), `export const a2 = ${Date.now()};\n`));
await step('change the target of the linked file', () => writeFileSync(join(dir, 'outside', 'f1.ts'), `export const a1 = ${Date.now()};\n`));
await step('create a file in the linked directory', () => writeFileSync(join(proj, 'linked', `new${Date.now()}.ts`), 'export const n = 1;\n'));
await step('create a real file beside the links', () => writeFileSync(join(proj, 'src', `new${Date.now()}.ts`), 'export const n = 1;\n'));
await handle.close();

if (large) {
  // Start to `ready`, less the settle wait, with the disk asked about every path and with
  // the question answered "no" without asking. Alternated, three times each.
  for (let round = 1; round <= 3; round++) {
    for (const [label, isSymbolicLink] of [['asking the disk', undefined], ['not asking', () => false]]) {
      ready = Promise.withResolvers();
      const began = performance.now();
      const h = startWatchMode({ config: resolveConfig({ projectRoot: resolve(large) }), settleMs: 0, runBatch: async () => {}, onWarn: () => {}, onReady: () => ready.resolve(), ...(isSymbolicLink ? { isSymbolicLink } : {}) });
      await ready.promise;
      console.log(`start to ready, round ${round}, ${label}: ${Math.round(performance.now() - began)} ms`);
      await h.close();
    }
  }
}
