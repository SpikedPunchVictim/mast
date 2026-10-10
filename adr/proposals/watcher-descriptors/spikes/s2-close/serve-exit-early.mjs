#!/usr/bin/env node
/**
 * D161, found by review: a client that leaves while the startup index run is still walking.
 *
 *   node serve-exit-early.mjs <tree> <empty state dir> <mast repo with dist/> <ms before stdin closes>
 *
 * Starts `mast serve` in <tree> on a state dir with no index, closes stdin after the given
 * time, and reports the exit and whether the run it had started was finished
 * (`index.json` is written last). Writes nothing into <tree>.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [tree, stateDir, repo, closeAfter] = process.argv.slice(2);
const child = spawn(process.execPath, [join(repo, 'dist/cli/index.js'), 'serve', '--state-dir', stateDir], { cwd: tree, stdio: ['pipe', 'ignore', 'ignore'] });
await new Promise((resolve) => setTimeout(resolve, Number(closeAfter)));
const asked = performance.now();
child.stdin.end();
const code = await new Promise((resolve) => child.on('exit', resolve));
console.log(JSON.stringify({
  closed_after_ms: Number(closeAfter), exit_ms: Math.round(performance.now() - asked), code,
  run_finished: existsSync(join(stateDir, 'index.json')), state_dir: readdirSync(stateDir).sort(),
}));
