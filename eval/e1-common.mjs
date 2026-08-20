// E1/E2 — shared harness primitives.
//
// Registration: IMPLEMENTATION_PLAN.md § "E1/E2 — the scaling ladder and call-graph
// denominators: PRE-REGISTRATION", as amended by AMENDMENTS 1-3.
//
// Every gate that can be enforced in code lives here rather than in each driver, because
// the registration's Gate 0 (binary identity) is exactly the check a driver is most likely
// to skip. `assertGate0` is not optional and takes no bypass flag.
//
// Run every script from `packages/mast`, never the repo root (HANDOFF §7).

import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Seed committed with the registration (AMENDMENT 1 F11). */
export const SEED = 811;

/** Ladder geometry, registered: f_i = 20^(-(9-i)/8), i = 1..9. Span 20x, even in ln N. */
export const RUNGS = 9;
export const SPAN = 20;

/** The absolute path to the freshly built CLI. Gate 0 forbids a PATH lookup. */
export const MAST_BIN = resolve(new URL('../dist/cli/index.js', import.meta.url).pathname);

/** Detached worktrees pinned by this registration. */
export const WORKTREE_ROOT = join(homedir(), '.cache', 'mast-eval', 'e1-wt');

/** All E1/E2 working state. Never the repo's own `.mast`. */
export const E1_ROOT = join(homedir(), '.cache', 'mast-eval', 'e1');

/**
 * Results live in the REPO, not in `paths.mjs`'s RESULTS_DIR.
 *
 * HANDOFF §5: `RESULTS_DIR` resolves to `~/.cache/mast-eval/results/`, and Q1/SCALE's Gate 0
 * evidence had to be hand-copied into `eval/results/` to be committed at all. Writing
 * straight into the repo removes that failure mode instead of documenting it again.
 */
export const RESULTS_DIR = resolve(new URL('./results', import.meta.url).pathname);

/**
 * The six pins this registration commits. `n8n` is the ladder's source, not a panel rung.
 *
 * Re-exported, not defined here: the literals moved to `./pins.mjs` on 2026-08-20 so a consumer
 * outside the eval track can read a SHA without importing this module's `better-sqlite3`. Every
 * importer of `PINS` from here is unchanged; there is still one place the SHAs are written.
 */
export { PINS } from './pins.mjs';

/** Deterministic PRNG — same generator Q1/SCALE's tier constructor used. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a seeded PRNG. Returns a new array; does not mutate. */
export function seededShuffle(items, seed) {
  const out = items.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Registered rung fractions of realized `C_total`. */
export function rungFractions() {
  const f = [];
  for (let i = 1; i <= RUNGS; i++) f.push(Math.pow(SPAN, -(RUNGS - i) / 8));
  return f;
}

/**
 * GATE 0 — binary identity (the D8 gate).
 *
 * D8: the installed `mast` is a symlink into this repo's gitignored `dist/`, and it was
 * found three days and one schema version stale while serving agent sessions. Every
 * `eval/*.mjs` imports from `../dist/` directly, so the harness carries the identical
 * exposure. Rebuild is not restart.
 *
 * @returns {{schema_version: string, dist_mtime: string, bin: string}} recorded in every manifest
 * @throws if the built binary's schema_version disagrees with the source tree's
 */
export function assertGate0() {
  const sourceVersion = readSourceSchemaVersion();

  if (!existsSync(MAST_BIN)) {
    throw new Error(`GATE 0 FAILED: ${MAST_BIN} does not exist. Run \`pnpm -F mast build\` first.`);
  }

  // Ask the built binary what it thinks it is, via the product's own surface (D8a added
  // schema_version to `mast status` precisely so this question has an in-product answer).
  const out = execFileSync(process.execPath, [MAST_BIN, 'status', '--json'], {
    cwd: resolve(new URL('..', import.meta.url).pathname),
    encoding: 'utf-8',
  });
  const binVersion = JSON.parse(out).schema_version;

  if (binVersion !== sourceVersion) {
    throw new Error(
      `GATE 0 FAILED: built binary reports schema_version ${binVersion}, source tree declares ` +
      `${sourceVersion}. The dist/ you are measuring is not the code you are reading. ` +
      `Run \`pnpm -F mast build\`.`
    );
  }

  // GATE 0b — see `distStalenessVerdict`. Checked AFTER the schema_version
  // comparison so the more specific diagnosis wins when both would fire.
  const src = newestSrcMtime();
  const staleness = distStalenessVerdict({
    newestSrcMs: src.ms,
    newestDistMs: new Date(newestDistMtime()).getTime(),
    newestSrcFile: src.file,
  });
  if (!staleness.ok) {
    throw new Error(
      `GATE 0 FAILED (staleness): dist/ is older than src/. The binary you are about to ` +
      `measure is not the code you are reading.\n` +
      `  newest source : ${staleness.newest_src_file}\n` +
      `  src is newer by: ${Math.round((staleness.src_newer_by_ms ?? 0) / 1000)} s\n` +
      `Run \`pnpm -F mast build\`.`
    );
  }

  return {
    schema_version: binVersion,
    dist_staleness: staleness,
    // A4-MAT-2. The schema version is necessary but NOT sufficient: this is an actively
    // developed branch, and a mid-schedule rebuild at an unchanged '1.3.0' would pass the
    // check above while the resumed half of the schedule measured different code than `c`
    // was calibrated on. The content hash is what actually pins the binary across a resume.
    dist_hash: distContentHash(),
    // The NEWEST emitted artifact, not the entry file's. tsc rewrites only outputs whose
    // input changed, so `dist/cli/index.js` can carry an old mtime while the build is
    // perfectly current — recording the entry file alone would look like D8 staleness and
    // invite exactly the wrong diagnosis. Kept as context; the hash is the gate.
    dist_newest_mtime: newestDistMtime(),
    dist_entry_mtime: statSync(MAST_BIN).mtime.toISOString(),
    bin: MAST_BIN,
    node_version: process.version,
  };
}

/** Every emitted `.js` under `dist/`, sorted — the hash and mtime scans share one walk. */
function distJsFiles() {
  const distRoot = resolve(new URL('../dist', import.meta.url).pathname);
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(distRoot);
  return out.sort();
}

/**
 * SHA-256 over every emitted `.js` in `dist/`, in sorted path order.
 *
 * Sorted so the digest is a property of the build rather than of directory-iteration order,
 * and path-inclusive so adding or deleting a file moves the hash even if no file's bytes
 * changed.
 */
export function distContentHash() {
  const h = createHash('sha256');
  for (const p of distJsFiles()) {
    h.update(p);
    h.update(readFileSync(p));
  }
  return h.digest('hex');
}

/** Newest mtime across every emitted `.js` under `dist/`. */
function newestDistMtime() {
  let newest = 0;
  for (const p of distJsFiles()) {
    const m = statSync(p).mtimeMs;
    if (m > newest) newest = m;
  }
  return new Date(newest).toISOString();
}

/**
 * GATE 0b — the built binary is not merely CONSISTENT, it is CURRENT.
 *
 * Added 2026-08-16 after a near-miss that nothing else would have caught. The
 * FTS delete guard was written, tested, linted and committed — and `dist/` was
 * never rebuilt. Two E1-VERIFY cells ran against a binary two days old, and the
 * only reason it surfaced is that a span the guard should have zeroed reported
 * 956 ms.
 *
 * Gate 0 could not see it, and this is worth stating precisely because Gate 0
 * looks like it should: the `schema_version` check compares the built binary to
 * the source tree, but the version had not changed (1.3.0 either way). The
 * content hash pins the binary across a RESUME — it detects `dist/` changing
 * mid-schedule, and says nothing about whether `dist/` ever corresponded to
 * `src/`. A stale build is perfectly self-consistent.
 *
 * The failure is silent and it is directional: whichever way the staleness
 * falls, the experiment measures code the author is not reading, and the
 * author's conclusion is about the code they ARE reading.
 *
 * mtime, not a hash of the compiled output: what must be detected is `src/`
 * being NEWER, which is a question about ordering. Tolerance is zero — tsc
 * rewrites only outputs whose input changed, so a legitimately current build
 * always has some dist artifact at or after the newest source file.
 */
export function distStalenessVerdict({ newestSrcMs, newestDistMs, newestSrcFile }) {
  if (!(newestSrcMs > 0) || !(newestDistMs > 0)) {
    return { ok: false, reason: 'mtimes_unreadable', newest_src_file: newestSrcFile ?? null };
  }
  if (newestSrcMs > newestDistMs) {
    return {
      ok: false,
      reason: 'dist_older_than_src',
      newest_src_file: newestSrcFile ?? null,
      src_newer_by_ms: newestSrcMs - newestDistMs,
    };
  }
  return { ok: true, reason: null, newest_src_file: newestSrcFile ?? null, src_newer_by_ms: 0 };
}

/**
 * Whether a file under `src/` is an input to the build — i.e. whether editing it can
 * actually make `dist/` stale.
 *
 * Mirrors `tsconfig.json`'s `exclude`: `**\/*.test.ts`, `**\/*.spec.ts` and
 * `**\/__tests__\/**` are never compiled, so no edit to them changes a byte of `dist/`.
 * Must be kept in step with that config; a divergence in the permissive direction
 * re-opens Gate 0b's blind spot, and in the strict direction re-opens its false positive.
 *
 * WHY THIS EXISTS: Gate 0b's first live firing was a false positive. It named a
 * `__tests__` file as the newest source and refused to run a build that was perfectly
 * current. That is a worse failure than it looks — a gate which blocks for a reason that
 * cannot affect the binary teaches its operator to bypass it, and the next block will be
 * the real one.
 *
 * @param {string} path absolute or relative path to a file under `src/`
 * @returns {boolean} true when `tsc` compiles this file
 */
export function isBuildInput(path) {
  if (!path.endsWith('.ts')) return false;
  if (path.endsWith('.test.ts') || path.endsWith('.spec.ts')) return false;
  if (path.includes('/__tests__/')) return false;
  return true;
}

/** Newest BUILD-INPUT `.ts` under `src/`, as {ms, file}. See `isBuildInput`. */
function newestSrcMtime() {
  const root = resolve(new URL('../src', import.meta.url).pathname);
  let newest = 0;
  let file = null;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!isBuildInput(p)) continue;
      const m = statSync(p).mtimeMs;
      if (m > newest) { newest = m; file = p; }
    }
  };
  walk(root);
  return { ms: newest, file };
}

/**
 * GATE 1 (config half, A4-C4) — the pinned config is actually what will be resolved.
 *
 * The registration fixes every run to `resolveConfig`'s defaults with NO overrides, because
 * an unpinned config is a free lever over `N` itself. `mast index` never persists its
 * resolved config the way `init` does, so nothing in the state dir records what was used —
 * this asks the Gate-0 build's own resolver and records the answer.
 *
 * @returns {object} the resolved config, for the run manifest
 */
export async function assertConfigPinned(projectRoot, stateDir) {
  // Imported lazily rather than at module top level: `e1-schedule.mjs` imports this module
  // for the seed and the shuffle, and its unit tests would otherwise require a built `dist/`
  // to run at all. Gate 0 has already established dist/ exists by the time this is called.
  const { resolveConfig } = await import('../dist/store/config.js');

  if (process.env.MAST_STATE_DIR !== undefined) {
    throw new Error(
      `GATE 1 FAILED: MAST_STATE_DIR is set (${process.env.MAST_STATE_DIR}). It outranks ` +
      `every config source below --state-dir and would silently redirect the run.`
    );
  }
  const stray = join(projectRoot, 'mast.config.json');
  if (existsSync(stray)) {
    throw new Error(
      `GATE 1 FAILED: ${stray} exists. A corpus-local config overrides the pinned defaults ` +
      `for file_extensions/exclude_patterns, which changes N itself.`
    );
  }

  const config = resolveConfig({ projectRoot, stateDirOverride: stateDir });
  const expectedExt = ['.ts', '.tsx', '.js', '.jsx', '.md'];
  if (JSON.stringify(config.file_extensions) !== JSON.stringify(expectedExt)) {
    throw new Error(
      `GATE 1 FAILED: resolved file_extensions ${JSON.stringify(config.file_extensions)} ` +
      `!= the pinned defaults ${JSON.stringify(expectedExt)}.`
    );
  }
  return config;
}

/** `CURRENT_SCHEMA_VERSION` read from source, not from any built artifact. */
export function readSourceSchemaVersion() {
  const src = readFileSync(resolve(new URL('../src/store/config.ts', import.meta.url).pathname), 'utf-8');
  const m = /export const CURRENT_SCHEMA_VERSION = '([^']+)'/.exec(src);
  if (!m) throw new Error('Could not read CURRENT_SCHEMA_VERSION from src/store/config.ts');
  return m[1];
}

/**
 * GATE 1 (corpus half) — the worktree is at its pin and clean.
 *
 * @param {string} name key into PINS
 * @returns {string} the worktree path
 */
export function assertCorpusPinned(name) {
  const pin = PINS[name];
  if (!pin) throw new Error(`Unknown corpus '${name}'`);
  const wt = join(WORKTREE_ROOT, name);
  if (!existsSync(wt)) {
    throw new Error(`GATE 1 FAILED: worktree ${wt} does not exist. See eval/ASSETS.md for setup.`);
  }
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  if (head !== pin.sha) {
    throw new Error(`GATE 1 FAILED: ${name} is at ${head}, registration pins ${pin.sha}.`);
  }
  const dirty = execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf-8' }).trim();
  if (dirty !== '') {
    throw new Error(`GATE 1 FAILED: ${name} worktree is dirty:\n${dirty}`);
  }
  return wt;
}

/**
 * Materialise a rung as a real directory tree of HARDLINKS at the original relative paths.
 *
 * Why this rather than a CLI flag or a config override:
 * - `mast index` has no file-list flag (`cli/index-cmd.ts:12-20` — `--state-dir`,
 *   `--incremental`, `--show-progress`, `--checker`, nothing else), and adding one to serve
 *   a measurement is out of scope, the same call the registration made for `--parse-only`.
 * - Restricting via `exclude_patterns` would break the config pin (A1-F9): the registration
 *   fixes config to `resolveConfig`'s defaults with NO overrides, precisely so config cannot
 *   act as a free lever over `N`.
 *
 * Hardlinks copy no data (verified: same inode, nlink 2) and `walkProject` applies only
 * `file_extensions` + `exclude_patterns` via fast-glob — it reads no `.gitignore`
 * (`indexer/walker.ts:46-55`) — so a tree containing exactly the rung's files at their
 * original relative paths yields exactly the rung's file set under the pinned config.
 *
 * @returns {string} the materialised tier root
 */
export function materialiseTier(sourceRoot, relPaths, tierRoot) {
  if (existsSync(tierRoot)) rmSync(tierRoot, { recursive: true, force: true });
  for (const rel of relPaths) {
    const dst = join(tierRoot, rel);
    mkdirSync(dirname(dst), { recursive: true });
    linkSync(join(sourceRoot, rel), dst);
  }
  return tierRoot;
}

/**
 * The argv `runColdIndex` spawns, extracted so it can be pinned by a test.
 *
 * E1's 42 scored runs and E1-PHASE's 15 were produced by the no-extra-args form,
 * and this module is shared with both. Extracting the construction is what lets
 * `eval/__tests__/e1-common-argv.test.mjs` assert that adding E1-AB's arm flags
 * left their command line untouched, rather than asserting it in a comment.
 *
 * Arm flags are appended AFTER the pinned prefix so nothing a caller passes can
 * displace `--state-dir` and silently redirect a run into another rung's dir.
 */
export function buildIndexArgs({ projectRoot, stateDir, extraArgs = [] }) {
  return [MAST_BIN, 'index', projectRoot, '--state-dir', stateDir, ...extraArgs];
}

/**
 * The pragmas SQLite reported for the run's own connection (`pragmas:` line).
 *
 * Returns `null` rather than throwing, for exactly `parsePhaseMs`'s reason: the
 * binaries that produced E1's and E1-PHASE's records could not emit this line,
 * and the harness must stay able to re-read its own history. On an E1-AB scored
 * run a null is a **Gate A VOID** — but that is the gate's judgement to make,
 * not the parser's.
 */
export function parsePragmas(stdout) {
  const m = /pragmas:\s*(\{.*\})/.exec(stdout);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Thrown when a cold index run leaves no readable index behind.
 *
 * Exists because the failure path used to throw whatever `readIndexMeta` /
 * `readGraphCounts` threw and let the child's stderr fall on the floor. On
 * 2026-08-13 a T9 cell died to a `structure.lock` race and the driver reported only
 * "No index.json in <dir>" — while the CLI's own "Could not acquire structure lock"
 * message, which named the cause outright, was sitting in the discarded stderr. The
 * diagnosis had to be reconstructed from lock metrics and WAL sizes over a session
 * that reading one line would have closed.
 *
 * The tails are kept as fields as well as prose so a driver can journal them: a state
 * dir is wiped by the next run, so stderr not captured here is gone for good.
 */
export class ColdIndexFailure extends Error {
  /**
   * @param {object} o
   * @param {string} o.stateDir the run's state dir, already wiped of any prior contents
   * @param {number|null} o.status child exit status; null when killed by a signal
   * @param {string|null} [o.signal] child termination signal, if any
   * @param {string} [o.stdout] child stdout
   * @param {string} [o.stderr] child stderr — the reason this class exists
   * @param {Error} [o.cause] the reader error that detected the missing artifact
   */
  constructor({ stateDir, status, signal = null, stdout = '', stderr = '', cause = undefined }) {
    const tail = (s, n) => {
      const t = (s ?? '').trim();
      return t === '' ? [] : t.split('\n').slice(-n);
    };
    const stderrTail = tail(stderr, 20);
    const stdoutTail = tail(stdout, 3);

    const exit = status === null || status === undefined ? 'null' : String(status);
    const lines = [
      `Cold index run produced no readable index in ${stateDir}`,
      `  exit status: ${exit}${signal === null || signal === undefined ? '' : ` (signal ${signal})`}`,
      `  detected by: ${cause instanceof Error ? cause.message : String(cause)}`,
      stderrTail.length === 0
        ? '  child stderr: empty — the child died without explaining itself'
        : `  child stderr (last ${stderrTail.length} lines):\n${stderrTail.map((l) => `    ${l}`).join('\n')}`,
    ];

    super(lines.join('\n'), cause === undefined ? undefined : { cause });
    this.name = 'ColdIndexFailure';
    this.state_dir = stateDir;
    this.exit_status = status ?? null;
    this.signal = signal ?? null;
    this.stderr_tail = stderrTail;
    this.stdout_tail = stdoutTail;
  }
}

/**
 * One cold index run into a fresh state dir. Never `--incremental` (Gate 3).
 *
 * Records BOTH clocks: `runIndex`'s own `durationMs` (the fitted clock, A1-F4c) and the
 * harness's external wall clock. Gate 3 compares them.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot  corpus to index
 * @param {string} opts.stateDir     destination; wiped first
 * @param {string[]} [opts.extraArgs] per-arm CLI flags (E1-AB). Empty for every
 *   E1 and E1-PHASE call site, which is what keeps this change additive.
 * @returns {object} run record
 */
export async function runColdIndex({ projectRoot, stateDir, extraArgs = [] }) {
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });

  const config = await assertConfigPinned(projectRoot, stateDir);
  const args = buildIndexArgs({ projectRoot, stateDir, extraArgs });

  // A4-C4: NODE_OPTIONS is stripped rather than inherited. A heap-size flag or an
  // `--inspect` left in a shell profile would silently change what this measures, and the
  // measurement would look entirely normal.
  const { NODE_OPTIONS: inheritedNodeOptions, ...inherited } = process.env;
  // Phase timing is opt-in on the CLI; the harness always wants it. Set explicitly rather
  // than inherited so a scaling run's decomposition never depends on the operator's shell.
  const env = { ...inherited, ENABLE_MAST_PHASE_TIMING: 'true' };

  const externalStart = Date.now();
  // spawnSync, not execFileSync: `cli/index-cmd.ts:58` sets `process.exitCode = 1` when
  // write_errors > 0, so execFileSync THROWS on exactly the trigger-2 case — discarding the
  // run record and the stdout needed to diagnose it. The status is inspected explicitly.
  const proc = spawnSync(process.execPath, args, {
    encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, env,
  });
  const externalMs = Date.now() - externalStart;

  if (proc.error) throw proc.error;
  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';

  // Wrapped, not bare: each of these throws on a run whose write never landed, and the
  // reason it never landed is in `stderr`, which the bare throw discarded. See
  // `ColdIndexFailure`.
  let meta, truth, wal;
  try {
    meta = readIndexMeta(stateDir);
    truth = readGraphCounts(stateDir);
    wal = readWalBoundary(stateDir);
  } catch (cause) {
    throw new ColdIndexFailure({
      stateDir, status: proc.status, signal: proc.signal, stdout, stderr, cause,
    });
  }

  return {
    project_root: projectRoot,
    state_dir: stateDir,
    duration_ms: parseDurationMs(stdout),    // the FITTED clock — see parseDurationMs
    phase_ms: parsePhaseMs(stdout),          // the decomposition E1 lacked — see parsePhaseMs
    write_spans: parseWriteSpans(stdout),    // E1-FTS's write-phase decomposition
    pragmas: parsePragmas(stdout),           // Gate A's arm identity — see parsePragmas
    extra_args: extraArgs,                   // what was ASKED for; `pragmas` is what took effect
    external_ms: externalMs,                 // Gate 3's cross-check only
    ...truth,
    parse_errors: meta.parse_errors ?? 0,
    write_errors: meta.write_errors ?? 0,
    exit_status: proc.status,
    stdout_tail: stdout.trim().split('\n').slice(-3),
    // A4-C4: parse-error FILE NAMES go to stderr (`indexer/index.ts:286`) while the record
    // keeps only a count. Trigger 4 requires the rate be discussed before the verdict is
    // recorded, and reps 1-2's state dirs are deleted, so without this the diagnosis has
    // nothing to work from.
    stderr_tail: stderr.trim() === '' ? [] : stderr.trim().split('\n').slice(-20),
    stderr_lines: stderr.trim() === '' ? 0 : stderr.trim().split('\n').length,
    wal_boundary: wal,
    env: { node_version: process.version, node_options_stripped: inheritedNodeOptions ?? null },
    resolved_config: {
      file_extensions: config.file_extensions,
      exclude_patterns: config.exclude_patterns,
      resolved_state_dir: config.resolved_state_dir,
      resolved_project_root: config.resolved_project_root,
    },
  };
}

/**
 * R4's run-boundary WAL reading — recorded, and labelled for what it actually is.
 *
 * A4-C3, stated in the artifact rather than left for a reader to infer: the one-shot CLI
 * drains its WAL when the process exits (P0's `graph.db-wal` is 0 bytes), so `log` here is
 * expected to be 0 at every rung. A per-rung curve of zeros reads as "checkpointing is free
 * at scale" — which is precisely the number the deferred `wal_autocheckpoint` decision is
 * registered to consume, so it must not be quotable as evidence about `mast serve`.
 *
 * Gate 4's rules are carried literally: backlog comes from `PRAGMA wal_checkpoint`, NEVER
 * from `-wal` file size (a high-water mark, silent on deferral), and the db is opened
 * read-write — never `?mode=ro&immutable=1`, which is WAL-blind.
 */
export function readWalBoundary(stateDir) {
  const db = new Database(join(stateDir, 'graph.db'));
  try {
    const row = db.pragma('wal_checkpoint(PASSIVE)')[0] ?? {};
    const walPath = join(stateDir, 'graph.db-wal');
    return {
      busy: row.busy ?? null,
      log: row.log ?? null,
      checkpointed: row.checkpointed ?? null,
      // Recorded for completeness and explicitly NOT read as backlog (Gate 4).
      wal_file_bytes_high_water: existsSync(walPath) ? statSync(walPath).size : 0,
      structurally_zero_in_this_topology: true,
      reading:
        'One-shot CLI drains the WAL at process exit, so log is expected to be 0 at every ' +
        'rung. NOT evidence that checkpointing is cheap at scale; the serve topology is R5.',
    };
  } finally {
    db.close();
  }
}

/**
 * The FITTED clock: `runIndex`'s own `durationMs` (`indexer/index.ts:173` -> `:414`).
 *
 * It is parsed from stdout because that is the ONLY place it surfaces: `IndexMeta`
 * (`index.json`) carries schema_version / last_indexed / file_count / chunk_count /
 * parse_errors / write_errors and **no duration** (`indexer/index.ts:386-392`); the value
 * exists solely on `runIndex`'s return, which the CLI prints at `cli/index-cmd.ts:48`.
 *
 * This does NOT contradict the registration's "ground truth is SELECT COUNT(*), never
 * stdout" rule, and the distinction matters. That rule exists because `chunksAdded` is
 * incremented PRE-write (`index.ts:282`), so a stdout count can include chunks a failed
 * write never persisted — the defect that cost Q1/SCALE 14,529 chunks. `durationMs` is
 * `Date.now() - startMs` evaluated at return; it has no pre-write-counting analogue, and
 * there is no database row to check it against. Counts come from `graph.db`; the clock
 * comes from here. Reading the clock in-process instead would mean not measuring the
 * shipped binary at all, which Gate 0 forbids.
 *
 * Throws rather than returning null: a silently-null fitted clock would drop runs from the
 * fit without anyone noticing.
 */
export function parseDurationMs(stdout) {
  const m = /duration:\s*(\d+)ms/.exec(stdout);
  if (!m) {
    throw new Error(
      `Could not parse the fitted clock from index stdout. Expected 'duration: <n>ms' ` +
      `(cli/index-cmd.ts:48). Got:\n${stdout}`
    );
  }
  return Number(m[1]);
}

/**
 * The phase decomposition of the fitted clock (`cli/index-cmd.ts`, `phases:` line).
 *
 * Returns `null` rather than throwing, deliberately and unlike `parseDurationMs`: a binary
 * built before phase timing existed cannot emit this line, and E1's own 42 runs were
 * measured by exactly such a binary. A hard throw here would make the harness unable to
 * re-read its own history. The fitted clock has no such fallback — a missing `duration`
 * would silently drop a run from the fit — which is why the two differ.
 *
 * Gate 0's dist content hash is what distinguishes "old binary" from "broken binary": a run
 * whose hash matches a phase-timed build and whose `phase_ms` is null is a defect.
 */
export function parsePhaseMs(stdout) {
  const m = /phases:\s*(\{.*\})/.exec(stdout);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * The write phase's own decomposition (`cli/index-cmd.ts`, `write_spans:` line).
 *
 * E1-FTS's instrument. A SEPARATE line from `phases:` and parsed separately, because
 * `phases:` is E1-PHASE's scored instrument and a finished record must not sit behind a
 * moving definition — the same rule that gave E1-AB its own schedule module.
 *
 * Returns `null` rather than throwing, for `parsePhaseMs`'s reason and one more: a run
 * whose spans are missing must reach the TILING GATE, which can name the run and quote its
 * stdout, rather than dying in a parser that knows nothing about which cell it was in.
 */
export function parseWriteSpans(stdout) {
  const m = /write_spans:\s*(\{.*\})/.exec(stdout);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** `index.json` as written by `runIndex`. */
export function readIndexMeta(stateDir) {
  const p = join(stateDir, 'index.json');
  if (!existsSync(p)) throw new Error(`No index.json in ${stateDir} — the index run produced no metadata.`);
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  return {
    duration_ms:  raw.duration_ms  ?? raw.durationMs  ?? null,
    parse_errors: raw.parse_errors ?? raw.parseErrors ?? 0,
    write_errors: raw.write_errors ?? raw.writeErrors ?? 0,
    file_count:   raw.file_count   ?? raw.fileCount   ?? null,
    chunk_count:  raw.chunk_count  ?? raw.chunkCount  ?? null,
  };
}

/**
 * GROUND TRUTH — counts read from `graph.db`, never from stdout.
 *
 * Q1/SCALE's headline count was the CLI stdout counter and was wrong by 14,529 chunks.
 * `chunksAdded` is incremented pre-write (`indexer/index.ts:282`), so stdout can report
 * chunks that a failed write never persisted.
 */
export function readGraphCounts(stateDir) {
  const db = new Database(join(stateDir, 'graph.db'), { readonly: true });
  try {
    const one = (sql) => db.prepare(sql).get().c;
    return {
      file_count:   one('SELECT COUNT(*) c FROM files'),
      chunk_count:  one('SELECT COUNT(*) c FROM chunks'),
      symbol_count: one('SELECT COUNT(*) c FROM symbols'),
      edge_count:   one('SELECT COUNT(*) c FROM edges'),
      potential_call_count: one("SELECT COUNT(*) c FROM edges WHERE edge_type='POTENTIAL_CALL'"),
      // FTS row counts, added 2026-08-16 after the E1-FTS results review found
      // that arm G's "byte-identical" claim rested on `db_bytes` alone — a byte
      // COUNT, which two different databases can share. For an arm that differs
      // only by skipping DELETEs, the sole way content can diverge is extra or
      // missing rows, so these two counts close that gap exactly. Read AFTER the
      // timed run, so they cost the measurement nothing.
      chunk_fts_count:      one('SELECT COUNT(*) c FROM chunk_fts'),
      identifier_fts_count: one('SELECT COUNT(*) c FROM identifier_fts'),
      db_bytes:     statSync(join(stateDir, 'graph.db')).size,
    };
  } finally {
    db.close();
  }
}

/**
 * Every path this run actually indexed — Gate 1's tier clause (A4-MAT-4).
 *
 * The registration required "tier file lists match the frozen tier manifest exactly", and
 * nothing enforced it: the tier trees are built once and reused across 27 runs, and because
 * `materialiseTier` HARDLINKS, they alias the source worktree's inodes. Any in-place write
 * to that worktree during the run window changes tier content mid-schedule, invisibly.
 *
 * Note this is the `files` table (`id, path, language, mtime`), not `chunks` — it includes
 * files that produced zero chunks, which is what makes it a check on the WALK rather than on
 * the extractor.
 */
export function readIndexedPaths(stateDir) {
  const db = new Database(join(stateDir, 'graph.db'), { readonly: true });
  try {
    return db.prepare('SELECT path FROM files ORDER BY path').all().map((r) => r.path);
  } finally {
    db.close();
  }
}

/** Per-file chunk counts from a completed index — the tier cut's input. */
export function readPerFileChunkCounts(stateDir) {
  const db = new Database(join(stateDir, 'graph.db'), { readonly: true });
  try {
    return db.prepare('SELECT file_path, COUNT(*) AS chunk_count FROM chunks GROUP BY file_path').all();
  } finally {
    db.close();
  }
}

/** Write a result artifact into the repo, with the directory created on demand. */
export function writeResult(filename, obj) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const p = join(RESULTS_DIR, filename);
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}
