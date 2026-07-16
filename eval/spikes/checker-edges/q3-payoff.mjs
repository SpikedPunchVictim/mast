// Q3 — Payoff rate on real potential matches (Stage 1.1, IMPLEMENTATION_PLAN_VEXP.md).
//
// Seeded sample of 50 from Q1(b)'s potential-match pool (seed 20260715,
// Fisher-Yates via rng.mjs — reproducible). For each sample: locate the call
// site inside the chunk's line range, find the actual call-shaped AST
// occurrence of the queried symbol's bare name (if any), and resolve it with
// the real TypeScript checker (getSymbolAtLocation -> declarations). Compare
// the resolved declaration's (file, line) to the queried symbol's recorded
// (file, line) with a +/-3 line tolerance (decorators/JSDoc/overload-signature
// offsets) to decide: resolves to the QUERIED symbol, resolves to a DIFFERENT
// declaration, or cannot be resolved (dynamic / no symbol / out of TS scope).
//
// Non-call-site hits (the identifier text appears in the chunk but not as an
// invoked callee — comments, strings, type positions, plain references) are
// reported as their own bucket, per the plan's ceiling framing.
//
//   node eval/spikes/checker-edges/q3-payoff.mjs

import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SPIKE_DIR, PROJECT_ROOT } from './paths.mjs';
import { seededSample } from './rng.mjs';
import { findOwningProject, getProgramForProject, getSourceFile } from './ts-projects.mjs';

const SEED = 20260715;
const SAMPLE_SIZE = 50;
// Chunk `content` is context_lines-expanded beyond [start_line, end_line]
// (src/store/config.ts default context_lines: 3; src/ast/types.ts confirms
// "content may extend context_lines beyond those boundaries"). A hit from
// identifier_fts can therefore sit just outside the strict AST boundary —
// padding the search window (with margin above the config default) avoids
// misclassifying real call sites as "no textual occurrence" (caught during
// this spike's authoring: 10/50 samples false-classified before this pad was
// added, all confirmed-present a few lines outside [start_line, end_line]).
const CONTEXT_PAD = 5;

const pool = JSON.parse(readFileSync(join(SPIKE_DIR, 'q1-potential-pool.json'), 'utf-8'));
const sample = seededSample(pool, SAMPLE_SIZE, SEED);

function bareName(queriedName) {
  const parts = queriedName.split('.');
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

/**
 * All Identifier nodes with `.text === name` whose 1-indexed line is in the
 * padded [startLine - pad, endLine + pad] window, nearest-to-original-range first.
 */
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
  occurrences.sort((a, b) => a.distance - b.distance || a.line - b.line || a.node.getStart(sourceFile) - b.node.getStart(sourceFile));
  return occurrences;
}

function rawTextContainsWord(sourceFile, name, startLine, endLine, pad) {
  const fullText = sourceFile.getFullText();
  const lines = fullText.split('\n');
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (let l = Math.max(1, startLine - pad); l <= Math.min(endLine + pad, lines.length); l++) {
    if (re.test(lines[l - 1] ?? '')) return true;
  }
  return false;
}

function relPath(absPath) {
  const norm = absPath.split('\\').join('/'); // defensive; we're on Darwin
  const root = PROJECT_ROOT.split('\\').join('/') + '/';
  return norm.startsWith(root) ? norm.slice(root.length) : norm;
}

const results = [];
const counts = {
  resolves_to_queried: 0,
  resolves_to_different: 0,
  cannot_resolve: 0,
  non_call_site: 0,
};
const cannotResolveReasons = {};
const nonCallSiteSubtypes = {};

for (const item of sample) {
  const name = bareName(item.queried_symbol_name);
  const relFilePath = item.file_path;
  const record = {
    queried_symbol_name: item.queried_symbol_name,
    queried_symbol_file_path: item.queried_symbol_file_path,
    queried_symbol_line: item.queried_symbol_line,
    call_site_file_path: relFilePath,
    call_site_line_range: [item.line, item.end_line],
    bare_name_searched: name,
  };

  const project = findOwningProject(relFilePath);
  if (project === null) {
    record.classification = 'cannot_resolve';
    record.reason = 'file_outside_ts_project_scope';
    counts.cannot_resolve++;
    cannotResolveReasons.file_outside_ts_project_scope = (cannotResolveReasons.file_outside_ts_project_scope ?? 0) + 1;
    results.push(record);
    continue;
  }
  record.owning_project = project;

  const entry = getProgramForProject(project);
  if (entry.error) {
    record.classification = 'cannot_resolve';
    record.reason = `tsconfig_parse_error: ${entry.error}`;
    counts.cannot_resolve++;
    cannotResolveReasons.tsconfig_parse_error = (cannotResolveReasons.tsconfig_parse_error ?? 0) + 1;
    results.push(record);
    continue;
  }

  const sourceFile = getSourceFile(entry.program, relFilePath);
  if (!sourceFile) {
    record.classification = 'cannot_resolve';
    record.reason = 'file_not_in_parsed_program';
    counts.cannot_resolve++;
    cannotResolveReasons.file_not_in_parsed_program = (cannotResolveReasons.file_not_in_parsed_program ?? 0) + 1;
    results.push(record);
    continue;
  }

  const occurrences = findIdentifierOccurrences(sourceFile, name, item.line, item.end_line, CONTEXT_PAD);
  const callSite = occurrences.find((o) => o.callShaped);

  if (!callSite) {
    if (occurrences.length > 0) {
      record.classification = 'non_call_site';
      record.subtype = 'type_or_reference_position';
    } else if (rawTextContainsWord(sourceFile, name, item.line, item.end_line, CONTEXT_PAD)) {
      record.classification = 'non_call_site';
      record.subtype = 'comment_or_string';
    } else {
      record.classification = 'non_call_site';
      record.subtype = 'identifier_fts_mismatch_no_textual_occurrence';
    }
    counts.non_call_site++;
    nonCallSiteSubtypes[record.subtype] = (nonCallSiteSubtypes[record.subtype] ?? 0) + 1;
    results.push(record);
    continue;
  }

  let symbol = entry.checker.getSymbolAtLocation(callSite.node);
  // getSymbolAtLocation on an imported identifier returns the LOCAL import
  // binding (declaration = the ImportSpecifier itself, in the call-site file)
  // — not the real declaration the import points at. Follow alias chains
  // (bounded — re-export chains are finite in practice) so cross-file
  // resolution is judged against the actual target, matching what a human
  // means by "does this call resolve to the queried symbol."
  for (let hops = 0; symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && hops < 8; hops++) {
    try {
      const aliased = entry.checker.getAliasedSymbol(symbol);
      if (!aliased || aliased === symbol) break;
      symbol = aliased;
    } catch {
      break;
    }
  }
  const declarations = symbol?.getDeclarations() ?? [];
  if (!symbol || declarations.length === 0) {
    record.classification = 'cannot_resolve';
    record.reason = symbol ? 'symbol_has_no_declarations' : 'checker_returned_no_symbol_dynamic';
    counts.cannot_resolve++;
    cannotResolveReasons[record.reason] = (cannotResolveReasons[record.reason] ?? 0) + 1;
    results.push(record);
    continue;
  }

  const decl = declarations[0];
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
const definiteEdgeRate = counts.resolves_to_queried / N;
const THRESHOLD = 0.20;

const output = {
  methodology: {
    seed: SEED,
    sample_size: SAMPLE_SIZE,
    sampling: 'seededSample (Fisher-Yates, mulberry32(seed)) over Q1(b)\'s potential-match pool ' +
      `(q1-potential-pool.json, ${pool.length} items), without replacement.`,
    call_site_location: `within the identifier_fts chunk's [start_line - ${CONTEXT_PAD}, end_line + ${CONTEXT_PAD}] ` +
      'padded window (chunk.content is context_lines-expanded [default 3] beyond the strict AST ' +
      'boundary, so the pad exceeds that default with margin), nearest occurrence to the original ' +
      '[start_line, end_line] range preferred, first call-shaped AST occurrence ' +
      '(CallExpression/NewExpression callee, direct or via PropertyAccessExpression) of the queried ' +
      'symbol\'s bare (post-dot) name.',
    resolution: 'ts.TypeChecker.getSymbolAtLocation on the callee identifier -> first declaration -> ' +
      '(file_path, line) compared to the queried symbol\'s recorded (file_path, line), +/-3 line ' +
      'tolerance for decorator/JSDoc/overload offsets.',
    non_call_site_definition: 'chunk contains the identifier as text but the sampled call-site range has ' +
      'no call-shaped AST occurrence of it (type position, plain reference, comment, or string).',
  },
  counts,
  n: N,
  definite_edge_rate: +definiteEdgeRate.toFixed(4),
  non_call_site_share: +(counts.non_call_site / N).toFixed(4),
  cannot_resolve_reasons: cannotResolveReasons,
  non_call_site_subtypes: nonCallSiteSubtypes,
  threshold: {
    threshold_fraction: THRESHOLD,
    exceeded_meaning_promote: definiteEdgeRate >= THRESHOLD,
    verdict: definiteEdgeRate < THRESHOLD
      ? 'BELOW THRESHOLD -> demote to reserve (residue is genuinely dynamic)'
      : 'AT/ABOVE THRESHOLD -> payoff gate does not block promotion',
  },
  sample_records: results,
};

writeFileSync(join(SPIKE_DIR, 'q3-results.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ counts, n: N, definite_edge_rate: output.definite_edge_rate, non_call_site_share: output.non_call_site_share, threshold: output.threshold }, null, 2));
