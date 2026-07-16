// Q5 (addendum, requested mid-spike by the coordinator) — n>=2 generalization
// check for Q3. The monorepo (Q1/Q3) is the home-field case: mast indexing
// its OWN repo, whose code the resolver's authors know best. This repeats a
// scaled-down Q1(b)-then-Q3 pipeline against a genuinely foreign corpus.
//
// NOTE (coordinator correction mid-spike): align-kimik27-03 was rejected —
// its fold build was live/mid-write at sampling time (confirmed via `ps`: an
// active `foldv2/cli/bin/run.js build` process targeting that directory),
// making it a moving target. align-kimik27-02 is used instead: its build.log
// shows a completed run (`exit: 2` at 2026-07-14T15:48:56Z — gate failures,
// but the build itself finished and stopped writing), and no process
// references it. Staleness was verified directly (required by the addendum
// before trusting the index): all 23 `files` rows' recorded mtimes match
// their on-disk mtimes exactly (0/23 mismatches) — the index is fresh, no
// reconciliation/re-index-to-throwaway-copy was needed.
//
// Path-resolution note: config.json's `project_root` is `/workspace` (a
// container bind-mount path from the fold-runner Docker invocation, per
// MAST_SPEC's forked-runner pattern), and file_path rows are relative to
// THAT root. Comparing recorded mtimes against candidate disk paths (see
// REPORT.md) established the host-side equivalent is
// `align-kimik27-02/packages/core` — this run indexed ONLY that one
// workspace package, not the whole app (23 files all under `packages/core/src`).
//
// Same methodology as q1-baseline.mjs (b) + q3-payoff.mjs, parameterized for
// this state dir / project root / single-project scope, sample capped at 25.
//
//   node eval/spikes/checker-edges/q5-foreign-corpus.mjs

import ts from 'typescript';
import { writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { SPIKE_DIR } from './paths.mjs';
import { seededSample } from './rng.mjs';
import { openReadOnlyDb, openLanceReadOnly, computePotentialMatches, queryVerifiedCallers } from './lib.mjs';

const SEED = 20260715; // same seed as Q3, per the addendum's instruction.
const SAMPLE_SIZE = 25;
const CONTEXT_PAD = 5; // same rationale as q3-payoff.mjs.

const APP_ROOT = '/Users/spikedpunchvictim/projects/kluster-workbench/apps/align-kimik27-02';
// This run's config.json project_root was the container path `/workspace`,
// bind-mounted (at index time) to packages/core specifically — confirmed by
// matching recorded file mtimes against packages/core/src/** on disk (0/23
// mismatches; see REPORT.md). file_path rows are relative to packages/core.
const FOREIGN_PROJECT_ROOT = join(APP_ROOT, 'packages/core');
const FOREIGN_STATE_DIR = join(APP_ROOT, '.fold/.mast');
const FOREIGN_PROJECTS = ['.']; // single project: packages/core's own tsconfig.json

const db = openReadOnlyDb(FOREIGN_STATE_DIR);
const lance = await openLanceReadOnly(FOREIGN_STATE_DIR);

const fileCount = Number((await db.selectFrom('files').select((eb) => eb.fn.countAll().as('c')).executeTakeFirst()).c);
const symbolCount = Number((await db.selectFrom('symbols').select((eb) => eb.fn.countAll().as('c')).executeTakeFirst()).c);
const edgeCount = Number((await db.selectFrom('edges').select((eb) => eb.fn.countAll().as('c')).executeTakeFirst()).c);

// --- Q1(b)-equivalent pool, scaled to this corpus's actual size (no fixed 50 cutoff needed — take ALL exported symbols with >=1 incoming edge). ---
const callCounts = await db
  .selectFrom('edges as e')
  .innerJoin('symbols as s', 's.id', 'e.to_id')
  .innerJoin('files as f', 'f.id', 's.file_id')
  .select(['s.id', 's.name', 'f.path as file_path', 's.line'])
  .select((eb) => eb.fn.countAll().as('incoming_count'))
  .where('e.edge_type', '=', 'POTENTIAL_CALL')
  .where('s.is_exported', '=', 1)
  .where('s.kind', '!=', 'export')
  .groupBy(['s.id', 's.name', 'f.path', 's.line'])
  .execute();

callCounts.sort((a, b) => {
  const ca = Number(a.incoming_count), cb = Number(b.incoming_count);
  if (cb !== ca) return cb - ca;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.file_path !== b.file_path) return a.file_path < b.file_path ? -1 : 1;
  return a.id - b.id;
});

const pool = [];
for (const sym of callCounts) {
  const verifiedRows = await queryVerifiedCallers(db, sym.id, false);
  const potential = await computePotentialMatches(db, lance, sym.name, verifiedRows);
  for (const p of potential) {
    pool.push({
      queried_symbol_id: sym.id,
      queried_symbol_name: sym.name,
      queried_symbol_file_path: sym.file_path,
      queried_symbol_line: sym.line,
      ...p,
    });
  }
}
await db.destroy();

const sample = seededSample(pool, SAMPLE_SIZE, SEED);

// --- Checker resolution over the foreign repo's own tsconfig projects ---
const parseConfigHost = {
  fileExists: ts.sys.fileExists, readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory, useCaseSensitiveFileNames: true,
};
const programCache = new Map();
function findOwningProject(relPath) {
  let best = null;
  for (const relDir of FOREIGN_PROJECTS) {
    if (relDir === '.') { best = best ?? '.'; continue; } // single-project scope: always owns
    const prefix = relDir + '/';
    if ((relPath + '/').startsWith(prefix) || relPath === relDir) {
      if (best === null || relDir.length > best.length) best = relDir;
    }
  }
  return best;
}
function getProgramForProject(relDir) {
  if (programCache.has(relDir)) return programCache.get(relDir);
  const configPath = join(FOREIGN_PROJECT_ROOT, relDir, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    const entry = { error: ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n') };
    programCache.set(relDir, entry);
    return entry;
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, parseConfigHost, join(FOREIGN_PROJECT_ROOT, relDir));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const entry = { program, checker: program.getTypeChecker() };
  programCache.set(relDir, entry);
  return entry;
}
function getSourceFile(program, relPath) {
  const abs = resolve(FOREIGN_PROJECT_ROOT, relPath).split(sep).join('/');
  return program.getSourceFile(abs);
}
function bareName(name) {
  const parts = name.split('.');
  return parts[parts.length - 1];
}
function isCallShaped(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isCallExpression(p) && p.expression === node) return true;
  if (ts.isNewExpression(p) && p.expression === node) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === node) {
    const gp = p.parent;
    if (gp && ts.isCallExpression(gp) && gp.expression === p) return true;
    if (gp && ts.isNewExpression(gp) && gp.expression === p) return true;
  }
  return false;
}
function findIdentifierOccurrences(sourceFile, name, startLine, endLine, pad) {
  const occurrences = [];
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === name) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const line1 = line + 1;
      if (line1 >= startLine - pad && line1 <= endLine + pad) {
        const distance = line1 < startLine ? startLine - line1 : line1 > endLine ? line1 - endLine : 0;
        occurrences.push({ node, line: line1, distance, callShaped: isCallShaped(node) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  occurrences.sort((a, b) => a.distance - b.distance || a.line - b.line);
  return occurrences;
}
function rawTextContainsWord(sourceFile, name, startLine, endLine, pad) {
  const lines = sourceFile.getFullText().split('\n');
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (let l = Math.max(1, startLine - pad); l <= Math.min(endLine + pad, lines.length); l++) {
    if (re.test(lines[l - 1] ?? '')) return true;
  }
  return false;
}
function relPath(absPath) {
  const norm = absPath.split('\\').join('/');
  const root = FOREIGN_PROJECT_ROOT.split('\\').join('/') + '/';
  return norm.startsWith(root) ? norm.slice(root.length) : norm;
}

const results = [];
const counts = { resolves_to_queried: 0, resolves_to_different: 0, cannot_resolve: 0, non_call_site: 0 };

for (const item of sample) {
  const name = bareName(item.queried_symbol_name);
  const record = {
    queried_symbol_name: item.queried_symbol_name,
    queried_symbol_file_path: item.queried_symbol_file_path,
    queried_symbol_line: item.queried_symbol_line,
    call_site_file_path: item.file_path,
    call_site_line_range: [item.line, item.end_line],
  };
  const project = findOwningProject(item.file_path);
  if (project === null) {
    record.classification = 'cannot_resolve';
    record.reason = 'file_outside_ts_project_scope';
    counts.cannot_resolve++;
    results.push(record);
    continue;
  }
  const entry = getProgramForProject(project);
  if (entry.error) {
    record.classification = 'cannot_resolve';
    record.reason = `tsconfig_parse_error: ${entry.error}`;
    counts.cannot_resolve++;
    results.push(record);
    continue;
  }
  const sourceFile = getSourceFile(entry.program, item.file_path);
  if (!sourceFile) {
    record.classification = 'cannot_resolve';
    record.reason = 'file_not_in_parsed_program';
    counts.cannot_resolve++;
    results.push(record);
    continue;
  }
  const occurrences = findIdentifierOccurrences(sourceFile, name, item.line, item.end_line, CONTEXT_PAD);
  const callSite = occurrences.find((o) => o.callShaped);
  if (!callSite) {
    record.classification = 'non_call_site';
    record.subtype = occurrences.length > 0
      ? 'type_or_reference_position'
      : rawTextContainsWord(sourceFile, name, item.line, item.end_line, CONTEXT_PAD)
        ? 'comment_or_string' : 'identifier_fts_mismatch_no_textual_occurrence';
    counts.non_call_site++;
    results.push(record);
    continue;
  }
  let symbol = entry.checker.getSymbolAtLocation(callSite.node);
  for (let hops = 0; symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && hops < 8; hops++) {
    const aliased = entry.checker.getAliasedSymbol(symbol);
    if (!aliased || aliased === symbol) break;
    symbol = aliased;
  }
  const decl = symbol?.getDeclarations()?.[0];
  if (!symbol || !decl) {
    record.classification = 'cannot_resolve';
    record.reason = symbol ? 'symbol_has_no_declarations' : 'checker_returned_no_symbol_dynamic';
    counts.cannot_resolve++;
    results.push(record);
    continue;
  }
  const declSourceFile = decl.getSourceFile();
  const declLine = declSourceFile.getLineAndCharacterOfPosition(decl.getStart(declSourceFile)).line + 1;
  const declFilePath = relPath(resolve(declSourceFile.fileName));
  record.resolved_file_path = declFilePath;
  record.resolved_line = declLine;
  const sameFile = declFilePath === item.queried_symbol_file_path;
  const lineClose = Math.abs(declLine - item.queried_symbol_line) <= 3;
  if (sameFile && lineClose) {
    record.classification = 'resolves_to_queried';
    counts.resolves_to_queried++;
  } else {
    record.classification = 'resolves_to_different';
    counts.resolves_to_different++;
  }
  results.push(record);
}

const N = sample.length;
const definiteEdgeRate = N > 0 ? counts.resolves_to_queried / N : null;

const output = {
  provenance: {
    app_root: FOREIGN_PROJECT_ROOT.replace(/\/packages\/core$/, ''),
    state_dir: FOREIGN_STATE_DIR,
    scoped_project_root: FOREIGN_PROJECT_ROOT,
    build_log_status: "exit: 2 at 2026-07-14T15:48:56Z (build finished; exit 2 = gate failures, not a crash)",
    staleness_check: '23/23 files table rows: recorded mtime == on-disk mtime exactly (0 mismatches) — index is fresh, no re-index needed',
    index_json: { last_indexed: '2026-07-14T15:45:59.574Z', file_count: 25, chunk_count: 209 },
    this_read_found: { files_rows: fileCount, symbols_rows: symbolCount, edges_rows: edgeCount },
  },
  pool_size: pool.length,
  sample_size_requested: SAMPLE_SIZE,
  sample_size_actual: N,
  seed: SEED,
  counts,
  definite_edge_rate: definiteEdgeRate !== null ? +definiteEdgeRate.toFixed(4) : null,
  non_call_site_share: N > 0 ? +(counts.non_call_site / N).toFixed(4) : null,
  sample_records: results,
};

writeFileSync(join(SPIKE_DIR, 'q5-foreign-corpus-results.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ pool_size: pool.length, N, counts, definite_edge_rate: output.definite_edge_rate, non_call_site_share: output.non_call_site_share }, null, 2));
