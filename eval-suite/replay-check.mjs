#!/usr/bin/env node
/**
 * Replay check — does a run of real commits, indexed one at a time, leave the graph a
 * full index of the final tree would build?
 *
 * T12 of `adr/proposals/incremental-graph-correctness/PROPOSAL.md`. It is the S2 spike
 * (`spikes/s2-commit-replay/s2-replay.mjs`) reduced to a check: S2 measured how far the
 * replay drifted and guessed why; this says whether it drifted at all.
 *
 * Not part of `pnpm gate`. Run it before a release, from the repository root:
 *
 *   node eval-suite/replay-check.mjs                           # this repository, 100 commits
 *   node eval-suite/replay-check.mjs --commits 40
 *   node eval-suite/replay-check.mjs --repo <git checkout> --name n8n --commits 200
 *   node eval-suite/replay-check.mjs --out <path>.json
 *
 * Writes its result to `--out`, or to `eval-suite/out/replay-check-<name>.json` (ignored
 * by git) without it, replacing the last run's. It refuses a path inside `eval/results/`:
 * that directory holds published results, among them the two T12 runs of this script
 * from when it lived in `eval/`. Exit 0 on a pass, 1 on a fail, 2 on a usage error.
 *
 * The checkout named by `--repo` is only read: the script clones it into a temporary
 * directory, checks commits out there, and keeps both indexes in state directories
 * outside the clone. It uses the built CLI in `dist/`, so build first.
 *
 * What a pass does and does not mean. It means the incremental path and the full path
 * agree on this history. It does not mean either is right: a resolver gap both share
 * (D087, D096) leaves the two graphs equal. The second part of the output is there for
 * that: for the final tree it counts the imported names the resolver could not find, so
 * a gap shows as a number that moves between runs instead of as silence.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAST_BIN } from '../eval/e1-common.mjs';

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SUITE_DIR, '..');
const PUBLISHED_DIR = join(REPO_ROOT, 'eval', 'results');
const DEFAULT_COMMITS = 100;

/** Thrown for a command line the script cannot act on. */
export class UsageError extends Error {}

/**
 * Reads the command line. `repo` is `null` for this repository.
 * @throws UsageError on an unknown flag, a bad count, `--out` with no path, or another
 *   repository with no name.
 */
export function parseArgs(argv) {
  const args = { repo: null, commits: DEFAULT_COMMITS, name: null, out: null };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--repo') args.repo = value ?? null;
    else if (flag === '--name') args.name = value ?? null;
    else if (flag === '--out') {
      if (value === undefined) throw new UsageError('--out needs a path');
      args.out = value;
    } else if (flag === '--commits') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new UsageError(`--commits needs a positive whole number, got ${String(value)}`);
      args.commits = n;
    } else throw new UsageError(`unknown argument ${String(flag)}`);
  }
  // The name becomes the default result file's name. Guessing it from a path would let
  // two checkouts of different repositories overwrite each other's result.
  if (args.repo !== null && args.name === null) throw new UsageError('--repo needs --name for its result file');
  return { ...args, name: args.name ?? 'mast' };
}

/**
 * The file the result is written to: `out` against `cwd`, or the suite's own default.
 * @throws UsageError when that file would be inside `eval/results/`.
 */
export function outPathOf({ out, name, cwd }) {
  const path = out === null ? join(SUITE_DIR, 'out', `replay-check-${basename(name)}.json`) : resolve(cwd, out);
  const fromPublished = relative(PUBLISHED_DIR, path);
  if (fromPublished !== '..' && !fromPublished.startsWith(`..${sep}`)) {
    throw new UsageError(`${path} is inside eval/results, which holds published results; write somewhere else`);
  }
  return path;
}

/** The lines each dump holds that the other does not, sorted, each counted once. */
export function diffDumps(replayed, full) {
  const inReplayed = new Set(replayed);
  const inFull = new Set(full);
  return {
    missing: [...inFull].filter((line) => !inReplayed.has(line)).sort(),
    extra: [...inReplayed].filter((line) => !inFull.has(line)).sort(),
  };
}

const lines = (n) => (n === 1 ? '1 line' : `${n} lines`);

/** Pass or fail, with every reason for a fail. */
export function verdictOf({ missing, extra, pendingRepairs, staleFiles, steps }) {
  const reasons = [];
  if (steps === 0) reasons.push('no commit was replayed');
  if (missing > 0) reasons.push(`${lines(missing)} of the full index ${missing === 1 ? 'is' : 'are'} missing after the replay`);
  if (extra > 0) reasons.push(`${lines(extra)} after the replay ${extra === 1 ? 'is' : 'are'} not in the full index`);
  if (pendingRepairs > 0) reasons.push(`${pendingRepairs} edge repairs were still pending when the graphs were compared`);
  if (staleFiles > 0) reasons.push(`${staleFiles} files were stale after the last incremental run`);
  return { pass: reasons.length === 0, reasons };
}

/**
 * Where an imported name ended up. `importRow` is the file's import row that lists the
 * name, or `null`; `edgeStored` says whether an edge from the file to that name exists.
 */
export function classifyImportedName({ importRow, edgeStored }) {
  if (edgeStored) return 'found';
  if (importRow === null) return 'no_import_row';
  return importRow.resolvedPath === null ? 'package_or_unresolved' : 'not_found';
}

const textHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/**
 * One line per stored row, by name and path, never by id. Every column a tool reads is in
 * its line, so a row that an incremental run left as it was shows as a difference (D134).
 * `chunks.file_mtime` is left out: it differs between two indexes of one tree.
 */
export function linesOf({ edges, stars, imports, symbols, reexportAliases, unresolvedStars, chunks }) {
  return [
    ...edges.map((e) => `edge|${e.t}|${e.r}|${e.fp}:${e.fn}@${e.fl}|${e.tp}:${e.tn}@${e.tl}|${e.cl ?? ''}|${e.cx ?? ''}`),
    ...stars.map((s) => `star|${s.f}|${s.t}`),
    ...imports.map((i) => `import|${i.f}|${i.m}|${i.s}|${i.x}|${i.p}|${i.a ?? ''}|${i.ea ?? ''}`),
    ...symbols.map((s) => `symbol|${s.k}|${s.p}:${s.n}@${s.l}|${s.x}|${s.d ?? ''}|${s.b ?? ''}`),
    ...reexportAliases.map((a) => `reexport_alias|${a.f}|${a.e}|${a.s}`),
    ...unresolvedStars.map((u) => `unresolved_star|${u.f}|${u.m}`),
    ...chunks.map((c) => `chunk|${c.f}:${c.sl}-${c.el}|${c.t}|${c.n ?? ''}|${c.pn ?? ''}|${c.x}|${textHash(c.c)}`),
  ];
}

async function loadMast() {
  const dist = dirname(dirname(MAST_BIN));
  const mod = (path) => import(pathToFileURL(join(dist, path)).href);
  const { resolveConfig } = await mod('store/config.js');
  const { openDatabase, sql } = await mod('graph/db.js');
  const { extractFile } = await mod('ast/extract.js');
  const { walkProject } = await mod('indexer/walker.js');
  return { resolveConfig, openDatabase, sql, extractFile, walkProject };
}

/** Every row of an index a tool reads, as `linesOf` writes it. */
async function dumpGraph(mast, stateDir) {
  const { openDatabase, sql } = mast;
  const db = openDatabase(stateDir);
  try {
    const edges = await sql`
      SELECT e.edge_type AS t, COALESCE(e.resolution, '') AS r,
             ff.path AS fp, fs.name AS fn, fs.line AS fl, tf.path AS tp, ts.name AS tn, ts.line AS tl,
             e.call_line AS cl, e.context AS cx
      FROM edges e
      JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
      JOIN symbols ts ON ts.id = e.to_id   JOIN files tf ON tf.id = ts.file_id
      WHERE COALESCE(e.resolution, '') != 'checker'`.execute(db);
    const stars = await sql`
      SELECT a.path AS f, b.path AS t FROM re_export_files x
      JOIN files a ON a.id = x.from_file_id JOIN files b ON b.id = x.to_file_id`.execute(db);
    const imports = await sql`
      SELECT f.path AS f, i.module AS m, i.symbols AS s, i.is_external AS x, COALESCE(i.resolved_path, '') AS p,
             i.aliases AS a, i.exported_as AS ea
      FROM imports i JOIN files f ON f.id = i.file_id`.execute(db);
    const symbols = await sql`
      SELECT s.kind AS k, f.path AS p, s.name AS n, s.line AS l, s.is_exported AS x,
             s.declaration_hash AS d, s.body_hash AS b
      FROM symbols s JOIN files f ON f.id = s.file_id`.execute(db);
    const reexportAliases = await sql`
      SELECT f.path AS f, a.exported_name AS e, a.source_name AS s
      FROM reexport_aliases a JOIN files f ON f.id = a.file_id`.execute(db);
    const unresolvedStars = await sql`
      SELECT f.path AS f, u.module AS m FROM star_reexport_unresolved u JOIN files f ON f.id = u.file_id`.execute(db);
    const chunks = await sql`
      SELECT file_path AS f, start_line AS sl, end_line AS el, chunk_type AS t, symbol_name AS n,
             parent_symbol AS pn, is_exported AS x, content AS c FROM chunks`.execute(db);
    return linesOf({
      edges: edges.rows, stars: stars.rows, imports: imports.rows, symbols: symbols.rows,
      reexportAliases: reexportAliases.rows, unresolvedStars: unresolvedStars.rows, chunks: chunks.rows,
    });
  } finally {
    await db.destroy();
  }
}

/**
 * For the final tree: of the records the extractor emits that name something a file
 * imports, how many have a stored edge. One call record per file and name, one
 * structural record per class, kind and name.
 */
async function countUnresolvedNames(mast, clone, stateDir) {
  const { resolveConfig, openDatabase, sql, extractFile, walkProject } = mast;
  const config = resolveConfig({ projectRoot: clone });
  const db = openDatabase(stateDir);
  try {
    const importRows = new Map();
    for (const row of (await sql`
      SELECT f.path AS f, i.symbols AS s, i.resolved_path AS p FROM imports i JOIN files f ON f.id = i.file_id`.execute(db)).rows) {
      for (const name of JSON.parse(row.s)) importRows.set(`${row.f}\n${name}`, { resolvedPath: row.p });
    }
    const stored = new Set((await sql`
      SELECT e.edge_type AS t, ff.path AS fp, ts.name AS tn FROM edges e
      JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
      JOIN symbols ts ON ts.id = e.to_id`.execute(db)).rows.map((e) => `${e.t}\n${e.fp}\n${e.tn}`));

    const empty = () => ({ records: 0, found: 0, not_found: 0, package_or_unresolved: 0, no_import_row: 0 });
    const counts = { import_calls: empty(), structural: empty() };
    const notFound = [];
    let extractFailures = 0;
    for (const entry of await walkProject(config)) {
      let result;
      try {
        result = extractFile(join(clone, entry.relativePath), config.resolved_project_root, config.context_lines,
          config.chunk_split_threshold, config.markdown_heading_depth);
      } catch {
        extractFailures++;
        continue;
      }
      const seen = new Set();
      for (const edge of result.edges) {
        const isImportCall = edge.edgeType === 'POTENTIAL_CALL' && edge.resolution === 'import';
        const isStructural = edge.edgeType === 'IMPLEMENTS' || edge.edgeType === 'EXTENDS';
        if (!isImportCall && !isStructural) continue;
        const key = isImportCall ? `call\n${edge.toName}` : `${edge.edgeType}\n${edge.fromName}\n${edge.toName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const where = classifyImportedName({
          importRow: importRows.get(`${entry.relativePath}\n${edge.toName}`) ?? null,
          edgeStored: stored.has(`${edge.edgeType}\n${entry.relativePath}\n${edge.toName}`),
        });
        const bucket = isImportCall ? counts.import_calls : counts.structural;
        bucket.records++;
        bucket[where]++;
        if (where === 'not_found') notFound.push(`${edge.edgeType}|${entry.relativePath}|${edge.toName}`);
      }
    }
    return { ...counts, extract_failures: extractFailures, not_found: notFound.sort() };
  } finally {
    await db.destroy();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = outPathOf({ out: args.out, name: args.name, cwd: process.cwd() });
  const source = resolve(args.repo ?? REPO_ROOT);
  const mast = await loadMast();
  const scratch = mkdtempSync(join(tmpdir(), 'mast-replay-'));
  const clone = join(scratch, 'clone');
  const replayState = join(scratch, 'state-replay');
  const fullState = join(scratch, 'state-full');
  const git = (...a) => execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const cli = (...a) => execFileSync('node', [MAST_BIN, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

  try {
    execFileSync('git', ['clone', '-q', '--no-hardlinks', source, clone]);
    const sourceHead = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    git('checkout', '-q', '--detach', sourceHead);
    const commits = git('rev-list', '--first-parent', '-n', String(args.commits + 1), 'HEAD').trim().split('\n').reverse();

    git('checkout', '-q', '--detach', commits[0]);
    cli('index', '--state-dir', replayState, clone);
    const filesWritten = [];
    const filesSkipped = [];
    for (let i = 1; i < commits.length; i++) {
      git('checkout', '-q', '--detach', commits[i]);
      const out = cli('index', '--incremental', '--state-dir', replayState, clone);
      const match = /files: (\d+) indexed, (\d+) skipped/.exec(out);
      filesWritten.push(match === null ? null : Number(match[1]));
      filesSkipped.push(match === null ? null : Number(match[2]));
      if (i % 20 === 0) process.stderr.write(`replayed ${i} of ${commits.length - 1}\n`);
    }
    const status = JSON.parse(cli('status', '--json', '--state-dir', replayState, clone));

    cli('index', '--state-dir', fullState, clone);
    const replayed = await dumpGraph(mast, replayState);
    const full = await dumpGraph(mast, fullState);
    const diff = diffDumps(replayed, full);
    const verdict = verdictOf({
      missing: diff.missing.length,
      extra: diff.extra.length,
      pendingRepairs: status.pending_edge_repairs ?? 0,
      staleFiles: status.stale_files ?? 0,
      steps: commits.length - 1,
    });

    const written = filesWritten.filter((n) => n !== null).sort((a, b) => a - b);
    const result = {
      instrument: 'eval-suite/replay-check.mjs',
      name: args.name,
      ran_at: new Date().toISOString(),
      mast_commit: execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      mast_tree_dirty: execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim() !== '',
      replayed: { base: commits[0], final: commits[commits.length - 1], commits: commits.length - 1, commits_asked_for: args.commits },
      runs_that_wrote_a_file: written.filter((n) => n > 0).length,
      files_written_per_run: { max: written[written.length - 1] ?? null, total: written.reduce((a, b) => a + b, 0), unparsed_runs: filesWritten.length - written.length },
      files_skipped_per_run: { min: Math.min(...filesSkipped.filter((n) => n !== null)), max: Math.max(...filesSkipped.filter((n) => n !== null)) },
      status_after_replay: { stale_files: status.stale_files, pending_edge_repairs: status.pending_edge_repairs, index_fresh: status.index_fresh },
      lines: { after_replay: new Set(replayed).size, full_index: new Set(full).size },
      missing_after_replay: diff.missing,
      extra_after_replay: diff.extra,
      verdict,
      imported_names_on_the_final_tree: await countUnresolvedNames(mast, clone, fullState),
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, missing_after_replay: diff.missing.length, extra_after_replay: diff.extra.length,
      imported_names_on_the_final_tree: { ...result.imported_names_on_the_final_tree, not_found: result.imported_names_on_the_final_tree.not_found.length } }, null, 2));
    console.log(`${verdict.pass ? 'PASS' : 'FAIL'}  ${outPath}`);
    for (const reason of verdict.reasons) console.log(`  ${reason}`);
    return verdict.pass ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(err.message);
    process.exitCode = 2;
  }
}
