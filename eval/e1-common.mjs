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

/** The six pins this registration commits. `n8n` is the ladder's source, not a panel rung. */
export const PINS = {
  P1:   { repo: 'opentelemetry-js', sha: '7f3e7eaa9f6bbc9622136479ed846f98c760a408', role: 'panel' },
  P2:   { repo: 'langchainjs',      sha: '62fc484b2a0d1ec5b8bebff4a8a0efe6300ada72', role: 'panel' },
  P3:   { repo: 'strapi',           sha: '0a8a9b40d0642b221c1841ae72295f830352e8ce', role: 'panel' },
  P4:   { repo: 'backstage',        sha: '25463a867ce73ad4bd14179889f84cd815affbb7', role: 'panel' },
  nest: { repo: 'nest',             sha: 'f7fffd63937ce6133624d23eb1d46fdd3c271526', role: 'panel+e2' },
  n8n:  { repo: 'n8n',              sha: '9d9e9bf97e8ae5382a930cd662637a9cf7046ef9', role: 'ladder-source' },
};

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

  return {
    schema_version: binVersion,
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

  const meta = readIndexMeta(stateDir);
  const truth = readGraphCounts(stateDir);
  const wal = readWalBoundary(stateDir);

  return {
    project_root: projectRoot,
    state_dir: stateDir,
    duration_ms: parseDurationMs(stdout),    // the FITTED clock — see parseDurationMs
    phase_ms: parsePhaseMs(stdout),          // the decomposition E1 lacked — see parsePhaseMs
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
