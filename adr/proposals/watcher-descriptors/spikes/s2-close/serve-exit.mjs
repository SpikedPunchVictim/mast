#!/usr/bin/env node
/**
 * D161, the real thing: how long `mast serve` takes to leave once its client is gone.
 *
 *   node serve-exit.mjs <tree> <state dir> <mast repo with dist/> stdin|SIGTERM|SIGINT [rounds]
 *
 * Starts `mast serve` in <tree> (already indexed into <state dir>), waits for the watcher's
 * "watching for changes" line, then closes the server's stdin or sends the signal, and
 * times the exit. Writes nothing into <tree>.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [tree, stateDir, repo, how, rounds = '3'] = process.argv.slice(2);
for (let round = 1; round <= Number(rounds); round++) {
  const child = spawn(process.execPath, [join(repo, 'dist/cli/index.js'), 'serve', '--state-dir', stateDir], {
    cwd: tree,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const started = performance.now();
  let stderr = '';
  const ready = new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('watching for changes')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`serve left before it was watching (code ${code}): ${stderr}`)));
  });
  await ready;
  const readyMs = Math.round(performance.now() - started);
  child.removeAllListeners('exit');
  const left = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const asked = performance.now();
  if (how === 'stdin') child.stdin.end();
  else child.kill(how);
  const { code, signal } = await left;
  console.log(JSON.stringify({ how, round, ready_ms: readyMs, exit_ms: Math.round(performance.now() - asked), code, signal }));
}
