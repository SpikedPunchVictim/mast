// Process execution for the harness. One rule, no exceptions: every command is CAPTURED —
// stdout, stderr, exit code, duration — never streamed to the terminal and discarded, because
// the whole design is that a failure must be diagnosable from the captured artifacts alone
// (align ADR 025 §2).
import { spawnSync } from 'node:child_process';

const TEN_MB = 10 * 1024 * 1024;

/**
 * The per-command cap when a step does not set its own. Exported so a scenario raising it can
 * say what it is raising *from*, and so the number lives in one place rather than in a `??`.
 *
 * Five minutes is a budget, not a measurement, and it is worth knowing how thin it is: the n8n
 * corpus (19k indexed files) took 78.7s on an idle machine and 739s under load an hour earlier.
 * A cap that a workload clears by 4x on a quiet box and misses by 2.5x on a busy one will
 * eventually expire on both, which is why the message below reports rather than diagnoses.
 */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// An allowlist, not "everything minus a denylist". Two mast-specific entries beyond align's:
// NODE_OPTIONS is STRIPPED (a heap flag or a loader inherited from the invoking shell changes
// what an index run does — eval/e1-common.mjs:484 learned this the expensive way), and
// ENABLE_MAST_PHASE_TIMING is set explicitly rather than inherited so a scenario's output shape
// never depends on the shell that launched it.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR', 'TMP', 'TEMP'];
const ENV_PASSTHROUGH = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'npm_config_registry'];

export function sanitizeEnv(source = process.env) {
  const out = {};
  for (const key of [...ENV_ALLOWLIST, ...ENV_PASSTHROUGH]) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  out.NO_COLOR = '1';
  delete out.FORCE_COLOR;
  delete out.CI;
  delete out.NODE_OPTIONS;
  return out;
}

const HARNESS_ENV = sanitizeEnv(process.env);

/**
 * Runs a command and returns the full captured result. NEVER throws on a non-zero exit — a
 * non-zero exit is frequently the expected outcome (a refusal, `mast status` on an absent
 * index), so it must be a data point a declarative `expect` evaluates.
 *
 * DOES throw on a launch failure (ENOENT, timeout, signal): the process never ran to a verdict,
 * so there is nothing an `expect` could have meant. That is ERROR, not FAIL, and the distinction
 * is the point.
 *
 * A timeout throws a DIFFERENT message from every other launch failure, naming elapsed and cap.
 * The harness cannot tell a hung command from a cap set below what the workload costs, and does
 * not try — it reports the two numbers a reader needs to tell them apart. `options.timeoutMs`
 * raises the cap for a step that is legitimately expensive.
 */
export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...HARNESS_ENV, ...(options.env ?? {}) },
    encoding: 'utf8',
    maxBuffer: TEN_MB,
    timeout: timeoutMs,
  });
  const durationMs = Date.now() - start;
  if (result.error) {
    const target = `\`${command} ${args.join(' ')}\` in ${options.cwd ?? process.cwd()}`;
    // `spawnSync` reports an expired timeout as code ETIMEDOUT and kills the child with
    // `killSignal` (SIGTERM by default). The CODE alone is the branch condition — the signal is
    // only reported, and is not part of the test, because a child that ignores SIGTERM leaves
    // `result.signal` unset while the timeout is still what happened.
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(
        `timed out after ${(durationMs / 1000).toFixed(1)}s (cap ${timeoutMs / 1000}s): ${target}\n` +
          `  The process was killed by ${result.signal ?? 'the harness'} — it did not fail, it did not finish, ` +
          `and it produced no verdict for an \`expect\` to read.\n` +
          `  Two different causes look identical here and the harness cannot tell them apart: a genuinely ` +
          `hung command, or a cap below what this workload costs on this machine. Compare the elapsed time ` +
          `against a run on an idle box before treating it as a regression, and raise the step's \`timeoutMs\` ` +
          `if the cap is what is wrong.`,
      );
    }
    throw new Error(`failed to run ${target}: ${result.error.message}`);
  }
  return {
    command: `${command} ${args.join(' ')}`,
    cwd: options.cwd,
    exitCode: result.status ?? (result.signal ? 128 : 0),
    signal: result.signal ?? undefined,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs,
  };
}

/**
 * Invokes the INSTALLED mast binary by absolute path into the install root's `node_modules` —
 * never `$PATH`, never `node_modules/.bin`, so a stray global install cannot answer instead
 * (that substitution is D8's shape, and it is what this harness exists to make visible).
 *
 * `spawnSync` rather than `execFileSync` because `mast index` sets `process.exitCode = 1` on
 * partial failure; `execFileSync` would throw on exactly the case worth capturing.
 */
export function runMast(installRoot, workingDir, argsString, options = {}) {
  const entry = `${installRoot}/node_modules/@spikedpunch/mast/dist/cli/index.js`;
  return run(process.execPath, [entry, ...splitArgs(argsString)], { cwd: workingDir, ...options });
}

export function mastEntryPath(installRoot) {
  return `${installRoot}/node_modules/@spikedpunch/mast/dist/cli/index.js`;
}

/**
 * Runs a mast command that emits JSON and returns the parsed object. A command that exits
 * non-zero, or prints something unparseable, THROWS — an assertion built on a silently-empty
 * parse is the false green this harness exists to prevent.
 */
export function runMastJson(installRoot, workingDir, argsString) {
  const res = runMast(installRoot, workingDir, argsString);
  if (res.exitCode !== 0) {
    throw new Error(`\`mast ${argsString}\` exited ${res.exitCode}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(`\`mast ${argsString}\` did not emit parseable JSON: ${err.message}\n--- stdout ---\n${res.stdout.slice(0, 2000)}`, { cause: err });
  }
}

/** Minimal argv splitter for scenario `run:` strings. Quoted segments only — no globbing, no
 * pipes, no expansion. Scenario steps are trusted hand-authored data, not shell input. */
export function splitArgs(argsString) {
  const out = [];
  let cur = '';
  let quote;
  for (const ch of argsString) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ' ') { if (cur.length > 0) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
