// Q2 driver — spawns q2-worker.mjs as a child process and samples its RSS via
// `ps -o rss= -p <pid>` (macOS/Darwin; no /proc) every 300ms until it exits,
// per the task brief's "measure the actual process ... do not guess."
//
//   node eval/spikes/checker-edges/q2-run.mjs

import { spawn, execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPIKE_DIR } from './paths.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mast-q2-'));
const workerOut = join(tmp, 'worker-result.json');

const child = spawn(process.execPath, [join(SPIKE_DIR, 'q2-worker.mjs')], {
  env: { ...process.env, WORKER_OUT_FILE: workerOut },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const rssSamplesKb = [];
let sampling = true;

function sampleRss(pid) {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf-8' }).trim();
    if (out !== '') rssSamplesKb.push(Number(out));
  } catch {
    // Process may have exited between the poll tick and this call — expected at the end.
  }
}

const pollInterval = setInterval(() => {
  if (sampling) sampleRss(child.pid);
}, 300);

const wallStart = performance.now();
const exitCode = await new Promise((resolvePromise) => {
  child.on('exit', (code) => resolvePromise(code));
});
sampling = false;
clearInterval(pollInterval);
const wallMs = performance.now() - wallStart;

if (exitCode !== 0) {
  console.error(`[q2-run] worker exited with code ${exitCode}`);
  process.exit(1);
}

const workerResult = JSON.parse(readFileSync(workerOut, 'utf-8'));
rmSync(tmp, { recursive: true, force: true });

const peakRssKb = rssSamplesKb.length > 0 ? Math.max(...rssSamplesKb) : null;
const peakRssMb = peakRssKb !== null ? +(peakRssKb / 1024).toFixed(1) : null;
const peakRssBytes = peakRssKb !== null ? peakRssKb * 1024 : null;

const THRESHOLD_MINUTES = 5;
const THRESHOLD_RSS_GB = 2;
const coldMinutes = workerResult.cold_total_ms / 60000;
const peakRssGb = peakRssMb !== null ? peakRssMb / 1024 : null;
const thresholdExceeded = coldMinutes > THRESHOLD_MINUTES || (peakRssGb !== null && peakRssGb > THRESHOLD_RSS_GB);

const result = {
  methodology: 'Child process spawned via node:child_process.spawn; RSS sampled every 300ms ' +
    "via `ps -o rss= -p <pid>` (Darwin has no /proc) from the parent driver, external to the " +
    'measured process. Wall-clock measured by the driver around the child\'s full lifetime ' +
    '(process spawn + exit), independent of the worker\'s internal performance.now() timings.',
  process_measurement: 'external ps polling of the actual spawned child PID (not self-reported, not estimated)',
  rss_sample_count: rssSamplesKb.length,
  peak_rss_kb: peakRssKb,
  peak_rss_mb: peakRssMb,
  peak_rss_bytes: peakRssBytes,
  wall_clock_ms_driver_measured: +wallMs.toFixed(1),
  worker_self_reported_rss_at_end_bytes: workerResult.self_reported_rss_at_end_bytes,
  threshold: {
    cold_minutes: +coldMinutes.toFixed(2),
    threshold_minutes: THRESHOLD_MINUTES,
    peak_rss_gb: peakRssGb !== null ? +peakRssGb.toFixed(3) : null,
    threshold_rss_gb: THRESHOLD_RSS_GB,
    exceeded: thresholdExceeded,
    verdict: thresholdExceeded
      ? 'THRESHOLD EXCEEDED -> always-on background design is dead; opt-in `mast index --checker` pass'
      : 'within threshold -> always-on background design remains viable on cost grounds',
  },
  worker_result: workerResult,
};

writeFileSync(join(SPIKE_DIR, 'q2-results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  wall_clock_ms: result.wall_clock_ms_driver_measured,
  cold_total_ms_worker: workerResult.cold_total_ms,
  warm_total_ms_worker: workerResult.warm_total_ms,
  peak_rss_mb: peakRssMb,
  threshold: result.threshold,
}, null, 2));
