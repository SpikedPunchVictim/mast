#!/usr/bin/env node
/**
 * S1 spike — THROWAWAY. Compares the call edges in a mast `graph.db` with what the
 * TypeScript checker says about the same files. See ../../PROPOSAL.md, questions Q1-Q4, Q6.
 *
 *   node reference.mjs <project-root> <tsconfig.json> <graph.db> <out.json> [path-prefix]
 *
 * Reads the graph read-only. Writes only <out.json>. Imports nothing from mast: the
 * program is built over the TypeScript files mast indexed (under `path-prefix`, if given),
 * with the compiler options of the named tsconfig.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const Database = require('better-sqlite3');

const [rootArg, tsconfigArg, dbArg, outArg, prefix = ''] = process.argv.slice(2);
if (!outArg) {
  console.error('usage: reference.mjs <project-root> <tsconfig.json> <graph.db> <out.json> [path-prefix]');
  process.exit(2);
}
const root = resolve(rootArg);
const started = Date.now();

// ---- mast's side -----------------------------------------------------------------------
const db = new Database(resolve(dbArg), { readonly: true });
const files = db.prepare("SELECT id, path FROM files WHERE language IN ('typescript') AND path LIKE ?").all(`${prefix}%`);
const fileIds = new Set(files.map((f) => f.id));
const symbols = db.prepare('SELECT s.id, s.name, s.kind, s.line, f.path FROM symbols s JOIN files f ON f.id = s.file_id').all();
const symbolAt = new Map(); // "path:line" -> symbols declared there
for (const s of symbols) {
  const key = `${s.path}:${s.line}`;
  if (!symbolAt.has(key)) symbolAt.set(key, []);
  symbolAt.get(key).push(s);
}
const symbolById = new Map(symbols.map((s) => [s.id, s]));
const edges = db
  .prepare(
    `SELECT e.from_id, e.to_id, COALESCE(e.resolution, '') AS resolution, e.call_line, fs.file_id AS from_file
     FROM edges e JOIN symbols fs ON fs.id = e.from_id WHERE e.edge_type = 'POTENTIAL_CALL'`,
  )
  .all()
  .filter((e) => fileIds.has(e.from_file));
db.close();
// First run on this repository: a function longer than one chunk has one `symbols` row per
// sub-chunk (same file, name and kind; lines 90 apart), and its outgoing edges hang off the
// last of them. Treat such rows as one symbol, the lowest line, so the comparison is about
// calls. The rows themselves are reported as `repeated_symbol_rows`.
const groups = new Map();
for (const s of symbols) {
  if (s.kind !== 'function' && s.kind !== 'method') continue;
  const key = `${s.path}|${s.name}|${s.kind}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(s);
}
const canonId = new Map();
const repeated = [];
for (const rows of groups.values()) {
  rows.sort((a, b) => a.line - b.line);
  for (const r of rows) canonId.set(r.id, rows[0].id);
  if (rows.length > 1) repeated.push({ path: rows[0].path, name: rows[0].name, lines: rows.map((r) => r.line) });
}
const canon = (id) => canonId.get(id) ?? id;
const edgePairs = new Set(edges.map((e) => `${canon(e.from_id)}>${canon(e.to_id)}`));
const bare = (name) => name.slice(name.lastIndexOf('.') + 1);

// ---- the checker's side ----------------------------------------------------------------
const configPath = resolve(tsconfigArg);
const read = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(configPath));
const configErrors = [...(read.error ? [read.error] : []), ...parsed.errors].map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
const rootNames = files.map((f) => join(root, f.path));
const program = ts.createProgram({ rootNames, options: { ...parsed.options, noEmit: true } });
const checker = program.getTypeChecker();
const rel = (fileName) => relative(root, resolve(fileName)).split(sep).join('/');
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

const INDEXABLE = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.Constructor,
]);

/** The lines a mast symbol for this declaration could carry, most literal first. */
function declLines(decl) {
  const sf = decl.getSourceFile();
  const out = [['start', lineOf(sf, decl.getStart(sf))]];
  if (decl.name) out.push(['name', lineOf(sf, decl.name.getStart(sf))]);
  if (ts.isVariableDeclaration(decl) && decl.parent?.parent && ts.isVariableStatement(decl.parent.parent)) {
    out.push(['statement', lineOf(sf, decl.parent.parent.getStart(sf))]);
  }
  return out;
}

const joinStats = { start: 0, name: 0, statement: 0, near3_same_name: 0, none: 0, not_indexable_kind: 0, outside_indexed_files: 0 };
const joinMisses = [];
const declCache = new Map();
const indexedPaths = new Set(files.map((f) => f.path));

/** The mast symbol for a declaration, by file and exact line, or null. Counts how it joined, once per declaration. */
function symbolOfDecl(decl, wantName) {
  if (declCache.has(decl)) return declCache.get(decl);
  const path = rel(decl.getSourceFile().fileName);
  let found = null;
  let how = 'none';
  if (!indexedPaths.has(path)) how = 'outside_indexed_files';
  else if (!INDEXABLE.has(decl.kind)) how = 'not_indexable_kind';
  else {
    for (const [label, line] of declLines(decl)) {
      const hit = (symbolAt.get(`${path}:${line}`) ?? []).find((s) => bare(s.name) === wantName && s.kind !== 'export');
      if (hit) { found = hit; how = label; break; }
    }
    if (!found) {
      const [, start] = declLines(decl)[0];
      for (let d = -3; d <= 3 && how === 'none'; d++) {
        if ((symbolAt.get(`${path}:${start + d}`) ?? []).some((s) => bare(s.name) === wantName)) how = 'near3_same_name';
      }
      if (how === 'none' || how === 'near3_same_name') joinMisses.push({ how, path, line: declLines(decl)[0][1], name: wantName, kind: ts.SyntaxKind[decl.kind] });
    }
  }
  joinStats[how]++;
  declCache.set(decl, found);
  return found;
}

/** The innermost enclosing declaration that mast has a symbol for, from the syntax tree alone. */
function enclosingSymbol(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (!INDEXABLE.has(n.kind) && !ts.isVariableStatement(n)) continue;
    const sf = n.getSourceFile();
    const path = rel(sf.fileName);
    const lines = ts.isVariableStatement(n) ? [lineOf(sf, n.getStart(sf))] : declLines(n).map(([, l]) => l);
    for (const line of lines) {
      // A sub-chunk row (see `canon`) can sit on the line of an unrelated inner declaration,
      // so a row only counts when it carries this declaration's name.
      const names = ts.isVariableStatement(n) ? n.declarationList.declarations.map((d) => d.name.getText(sf)) : [n.name?.getText(sf) ?? 'constructor'];
      const hit = (symbolAt.get(`${path}:${line}`) ?? []).find((s) => s.kind !== 'export' && names.includes(bare(s.name)));
      if (hit) return symbolById.get(canon(hit.id));
    }
  }
  return null;
}

function shapeOf(call) {
  const callee = call.expression;
  if (ts.isNewExpression(call)) return 'new X()';
  if (ts.isIdentifier(callee)) return 'identifier';
  if (ts.isPropertyAccessExpression(callee)) {
    const recv = callee.expression;
    if (recv.kind === ts.SyntaxKind.ThisKeyword) return 'this.m()';
    if (recv.kind === ts.SyntaxKind.SuperKeyword) return 'super.m()';
    if (ts.isPropertyAccessExpression(recv) && recv.expression.kind === ts.SyntaxKind.ThisKeyword) return 'this.field.m()';
    if (ts.isIdentifier(recv)) return 'ident.m()';
    return 'expr.m()';
  }
  return 'other';
}

// One record per call or `new` expression in an indexed file.
const calls = [];
for (const sf of program.getSourceFiles()) {
  const path = rel(sf.fileName);
  if (!indexedPaths.has(path)) continue;
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const nameNode = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : null;
      if (nameNode) {
        let symbol = checker.getSymbolAtLocation(nameNode);
        for (let hop = 0; hop < 8 && symbol && symbol.flags & ts.SymbolFlags.Alias; hop++) symbol = checker.getAliasedSymbol(symbol);
        const decls = symbol?.declarations ?? [];
        // Q5: when the checker has no symbol, say whether the receiver (or the callee itself) is
        // typed `any`, and whether that `any` is the error type an unresolved import leaves.
        let untyped = null;
        if (decls.length === 0) {
          const t = checker.getTypeAtLocation(ts.isPropertyAccessExpression(callee) ? callee.expression : callee);
          if (t.flags & ts.TypeFlags.Any) untyped = t.intrinsicName === 'error' ? 'error' : 'any';
        }
        calls.push({ node, path, line: lineOf(sf, nameNode.getStart(sf)), startLine: lineOf(sf, node.getStart(sf)), name: nameNode.text, shape: shapeOf(node), decls, resolved: decls.length > 0, untyped });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
// Q5: imports the program could not resolve (TS2307), in indexed files only.
const unresolvedImports = {};
for (const sf of program.getSourceFiles()) {
  if (!indexedPaths.has(rel(sf.fileName))) continue;
  for (const d of program.getSemanticDiagnostics(sf)) {
    if (d.code !== 2307) continue;
    const spec = /'([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, ' '))?.[1] ?? '?';
    unresolvedImports[spec] = (unresolvedImports[spec] ?? 0) + 1;
  }
}
const unresolvedCalls = calls.filter((c) => !c.resolved);
const q5 = {
  import_statements_not_resolved_by_specifier: unresolvedImports,
  calls_with_no_symbol: unresolvedCalls.length,
  of_those_receiver_is_error_type: unresolvedCalls.filter((c) => c.untyped === 'error').length,
  of_those_receiver_is_any: unresolvedCalls.filter((c) => c.untyped === 'any').length,
  of_those_receiver_is_typed: unresolvedCalls.filter((c) => c.untyped === null).length,
};
const callsAt = new Map();
for (const c of calls) {
  for (const line of new Set([c.line, c.startLine])) {
    const key = `${c.path}:${line}`;
    if (!callsAt.has(key)) callsAt.set(key, []);
    callsAt.get(key).push(c);
  }
}

// ---- Q3: every mast edge, judged ---------------------------------------------------------
const verdicts = {};
const wrong = [];
const noCall = [];
const callerDisagrees = [];
for (const e of edges) {
  const from = symbolById.get(e.from_id);
  const to = symbolById.get(e.to_id);
  const want = bare(to.name);
  const here = (callsAt.get(`${from.path}:${e.call_line}`) ?? []).filter((c) => c.name === want || (c.shape === 'new X()' && to.kind === 'class'));
  let verdict;
  let agreeing = null;
  if (here.length === 0) verdict = 'no_call_of_that_name_on_the_line';
  else {
    agreeing = here.find((c) => c.decls.some((d) => symbolOfDecl(d, bare(to.name))?.id === canon(to.id))) ?? null;
    if (agreeing) verdict = 'agrees';
    else if (here.every((c) => !c.resolved)) verdict = 'checker_has_no_symbol';
    else verdict = 'checker_says_another_declaration';
  }
  verdicts[e.resolution] ??= {};
  verdicts[e.resolution][verdict] = (verdicts[e.resolution][verdict] ?? 0) + 1;
  const row = { resolution: e.resolution, from: `${from.path}:${from.name}@${from.line}`, call_line: e.call_line, to: `${to.path}:${to.name}@${to.line}` };
  if (verdict === 'checker_says_another_declaration') {
    wrong.push({ ...row, checker: here.flatMap((c) => c.decls.map((d) => `${rel(d.getSourceFile().fileName)}:${declLines(d)[0][1]} ${ts.SyntaxKind[d.kind]}`)) });
  } else if (verdict !== 'agrees') noCall.push({ ...row, verdict });
  if (agreeing) {
    const caller = enclosingSymbol(agreeing.node);
    if (caller?.id !== canon(from.id)) callerDisagrees.push({ ...row, syntax_tree_caller: caller ? `${caller.path}:${caller.name}@${caller.line}` : null });
  }
}

/** For a call mast has no edge for: what the receiver is, and how deeply the call is nested. Syntax and checker only. */
function detailOf(c) {
  const callee = c.node.expression;
  let nested = 0;
  for (let n = c.node.parent; n; n = n.parent) {
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) nested++;
    else if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isClassDeclaration(n)) break;
  }
  const depth = nested > 0 ? ', inside a nested function expression' : '';
  if (!ts.isPropertyAccessExpression(callee)) return (c.shape === 'new X()' ? 'construction' : 'plain call') + depth;
  const recv = callee.expression;
  if (recv.kind === ts.SyntaxKind.ThisKeyword || recv.kind === ts.SyntaxKind.SuperKeyword) return 'method of this or super' + depth;
  const leaf = ts.isPropertyAccessExpression(recv) ? recv.name : recv;
  if (!ts.isIdentifier(leaf)) return `receiver is ${ts.SyntaxKind[recv.kind]}` + depth;
  let sym = checker.getSymbolAtLocation(leaf);
  let viaAlias = false;
  for (let hop = 0; hop < 8 && sym && sym.flags & ts.SymbolFlags.Alias; hop++) { sym = checker.getAliasedSymbol(sym); viaAlias = true; }
  const d = sym?.declarations?.[0];
  if (!d) return 'receiver has no declaration' + depth;
  if (ts.isClassDeclaration(d)) return 'static call on a class' + depth;
  const typed = d.type ? `annotated ${ts.SyntaxKind[d.type.kind]}` : d.initializer && ts.isNewExpression(d.initializer) ? 'initialised with new' : 'type inferred';
  return `${ts.SyntaxKind[d.kind]}, ${typed}` + depth;
}

// ---- Q4: checker-resolved calls to an indexed declaration with no mast edge -----------------
const missingByShape = {};
const presentByShape = {};
const missing = [];
const seenPairs = new Set();
let noEnclosing = 0;
let selfCalls = 0;
for (const c of calls) {
  const targets = [...new Set(c.decls.map((d) => symbolOfDecl(d, c.name)).filter(Boolean))];
  if (targets.length === 0) continue;
  const caller = enclosingSymbol(c.node);
  if (!caller) { noEnclosing++; continue; }
  for (const target of targets) {
    if (target.id === caller.id) { selfCalls++; continue; }
    const pair = `${caller.id}>${target.id}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const same = target.path === caller.path ? ' (same file)' : ' (other file)';
    const bucket = edgePairs.has(pair) ? presentByShape : missingByShape;
    bucket[c.shape + same] = (bucket[c.shape + same] ?? 0) + 1;
    if (!edgePairs.has(pair)) missing.push({ shape: c.shape + same, detail: detailOf(c), from: `${caller.path}:${caller.name}@${caller.line}`, call_line: c.line, to: `${target.path}:${target.name}@${target.line}` });
  }
}

// Stored pairs the reference did not produce, and why the counts differ: several edges can
// collapse to one pair once repeated rows are merged, and a caller the script cannot name
// from the syntax tree (an accessor, say) gives a pair under another caller.
const mastOnly = [...edgePairs].filter((p) => !seenPairs.has(p)).map((p) => {
  const [f, t] = p.split('>').map((id) => symbolById.get(Number(id)));
  return `${f.path}:${f.name}@${f.line} > ${t.path}:${t.name}@${t.line}`;
});

const result = {
  spike: 'graph-reference/s1-call-edges',
  ran_at: new Date().toISOString(),
  typescript: ts.version,
  project_root: root,
  tsconfig: rel(configPath),
  path_prefix: prefix,
  config_errors: configErrors,
  indexed_typescript_files: files.length,
  program_source_files: program.getSourceFiles().length,
  calls_seen: calls.length,
  calls_the_checker_gave_no_symbol_for: calls.filter((c) => !c.resolved).length,
  repeated_symbol_rows: repeated,
  q1_declaration_join: joinStats,
  q1_join_misses: joinMisses,
  q2_caller_disagreements: callerDisagrees,
  q3_mast_edges: edges.length,
  q3_verdicts_by_resolution: verdicts,
  q3_checker_says_another_declaration: wrong,
  q3_not_judged: noCall,
  q4_reference_pairs: seenPairs.size,
  q4_pairs_mast_has_by_shape: presentByShape,
  q4_pairs_mast_lacks_by_shape: missingByShape,
  q4_distinct_mast_pairs: edgePairs.size,
  q4_mast_pairs_the_reference_did_not_produce: mastOnly,
  q4_calls_outside_any_indexed_symbol: noEnclosing,
  q4_self_calls_skipped: selfCalls,
  q4_missing: missing,
  q5_unjudgeable: q5,
  q6_cost: { wall_ms: Date.now() - started, peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024) },
};
writeFileSync(resolve(outArg), JSON.stringify(result, null, 2) + '\n');
const { repeated_symbol_rows: rsr, q1_join_misses: _a, q2_caller_disagreements: q2, q3_checker_says_another_declaration: _b, q3_not_judged: _c, q4_missing: _d, ...summary } = result;
console.log(JSON.stringify({ ...summary, repeated_symbol_rows: rsr.length, q2_caller_disagreements: q2.length }, null, 2));
