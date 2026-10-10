#!/usr/bin/env node
/**
 * D161: a server whose client leaves while a watch batch is running.
 *
 *   node serve-exit-mid-batch.mjs <copy of a tree> <state dir> <mast repo with dist/>
 *
 * WRITES INTO <tree>: it adds one file, so give it a copy. Starts `mast serve`, waits for
 * the watcher, writes a file, closes stdin the moment the server says it is reindexing,
 * and reports the exit, what the state dir holds, and whether the new file was indexed.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [tree, stateDir, repo] = process.argv.slice(2);
const cli = join(repo, 'dist/cli/index.js');
const child = spawn(process.execPath, [cli, 'serve', '--state-dir', stateDir], { cwd: tree, stdio: ['pipe', 'ignore', 'pipe'] });
let stderr = '';
let wrote = false;
let asked = 0;
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
  if (!wrote && stderr.includes('watching for changes')) {
    wrote = true;
    writeFileSync(join(tree, 'd161_mid_batch.ts'), 'export function d161MidBatch(): number { return 1; }\n');
  }
  if (asked === 0 && stderr.includes('reindexing after')) {
    asked = performance.now();
    child.stdin.end();
  }
});
const { code, signal } = await new Promise((resolve) => child.on('exit', (c, s) => resolve({ code: c, signal: s })));
const found = execFileSync(process.execPath, [cli, 'search', 'd161MidBatch', '--state-dir', stateDir], { cwd: tree, encoding: 'utf8' });
console.log(JSON.stringify({
  exit_ms: Math.round(performance.now() - asked), code, signal,
  state_dir: readdirSync(stateDir).sort(),
  new_file_indexed: found.includes('d161_mid_batch.ts'),
}));
