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
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
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
    dist_mtime: statSync(MAST_BIN).mtime.toISOString(),
    bin: MAST_BIN,
  };
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
 * One cold index run into a fresh state dir. Never `--incremental` (Gate 3).
 *
 * Records BOTH clocks: `runIndex`'s own `durationMs` (the fitted clock, A1-F4c) and the
 * harness's external wall clock. Gate 3 compares them.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot  corpus to index
 * @param {string} opts.stateDir     destination; wiped first
 * @returns {object} run record
 */
export function runColdIndex({ projectRoot, stateDir }) {
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });

  const args = [MAST_BIN, 'index', projectRoot, '--state-dir', stateDir];

  const externalStart = Date.now();
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  const externalMs = Date.now() - externalStart;

  const meta = readIndexMeta(stateDir);
  const truth = readGraphCounts(stateDir);

  return {
    project_root: projectRoot,
    state_dir: stateDir,
    duration_ms: parseDurationMs(stdout),    // the FITTED clock — see parseDurationMs
    external_ms: externalMs,                 // Gate 3's cross-check only
    ...truth,
    parse_errors: meta.parse_errors ?? 0,
    write_errors: meta.write_errors ?? 0,
    stdout_tail: stdout.trim().split('\n').slice(-3),
  };
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
