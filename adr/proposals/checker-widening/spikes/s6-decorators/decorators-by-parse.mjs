#!/usr/bin/env node
/**
 * Spike s6 for the widened `--checker` proposal: the decorators of a corpus, by a parse,
 * set against the call pairs the scorecard says the graph has or lacks.
 *
 *   node decorators-by-parse.mjs <dir of scorecards> <corpus root> <out.json>
 *
 * s4's `decorators.py` asked whether the calling file contains `@name` anywhere. This asks,
 * for every decorator in every file that is the caller of some pair, which pair that
 * decorator is: the decorator's name, and the declaration the compiler's reference would
 * name as its caller. Three questions:
 *
 *   1. How many lacking pairs are a decorator written as a call (`@name(...)`)?
 *   2. Whose call is it: the class's, or the member's the decorator is on?
 *   3. Does a decorator with no parentheses (`@name`) have a pair at all?
 *
 * It builds no program and resolves nothing. A decorator is matched to a pair by the
 * calling file, the caller's name and the callee's name, so two decorators of one name
 * from two packages on one class would be read as one pair.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..', '..');
const ts = createRequire(join(REPO, 'package.json'))('typescript');

const [cards, root, out] = process.argv.slice(2);
if (!cards || !root || !out) {
  console.error('usage: decorators-by-parse.mjs <dir of scorecards> <corpus root> <out.json>');
  process.exit(2);
}

const CALLS = 'edge: POTENTIAL_CALL';
const agree = new Set();
const lacks = new Set();
for (const name of readdirSync(cards).filter((n) => n.endsWith('.json')).sort()) {
  const item = JSON.parse(readFileSync(join(cards, name), 'utf8')).items?.[CALLS] ?? {};
  for (const pair of item.agree ?? []) agree.add(pair);
  for (const pair of item.lacks ?? []) lacks.add(pair);
}
for (const pair of agree) lacks.delete(pair);

/** `path:Name@line` -> [path, Name]. The line is only there for two rows of one name. */
function parseKey(key) {
  const at = key.indexOf(':');
  return [key.slice(0, at), key.slice(at + 1).split('@')[0]];
}
/** calling file -> `caller name > callee's last name` -> { pairs, bucket } */
const byFile = new Map();
function index(pair, bucket) {
  const [left, right] = pair.split(' > ');
  const [file, caller] = parseKey(left);
  const calleeName = parseKey(right)[1].split('.').pop();
  const key = `${caller} > ${calleeName}`;
  const ofFile = byFile.get(file) ?? new Map();
  byFile.set(file, ofFile);
  const entry = ofFile.get(key) ?? { lacks: [], agree: [] };
  ofFile.set(key, entry);
  entry[bucket].push(pair);
}
for (const pair of lacks) index(pair, 'lacks');
for (const pair of agree) index(pair, 'agree');

const count = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const sites = new Map();
const names = { called: new Map(), bare: new Map() };
const explained = { 'the decorator itself': new Set(), 'a call inside its arguments': new Set() };
const explainedBy = new Map();
const samples = new Map();
const sample = (key, text) => {
  const list = samples.get(key) ?? [];
  samples.set(key, list);
  if (list.length < 5) list.push(text);
};

function memberName(node) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const name = node.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : null;
}
function topLevelClassName(node) {
  return ts.isClassDeclaration(node) && node.name && ts.isSourceFile(node.parent) ? node.name.text : null;
}
/** What the decorator is on, and the callers the reference could name, innermost first. */
function placeOf(decorator) {
  const on = decorator.parent;
  if (ts.isClassDeclaration(on)) {
    const cls = topLevelClassName(on);
    return { position: 'class', callers: cls === null ? [] : [['class', cls]] };
  }
  const member = ts.isParameter(on) ? on.parent : on;
  const cls = member.parent && ts.isClassDeclaration(member.parent) ? topLevelClassName(member.parent) : null;
  const position = ts.isParameter(on)
    ? 'parameter'
    : ts.isMethodDeclaration(on) ? 'method'
    : ts.isPropertyDeclaration(on) ? 'property'
    : ts.isGetAccessor(on) || ts.isSetAccessor(on) ? 'accessor' : `other (${ts.SyntaxKind[on.kind]})`;
  const name = memberName(member);
  if (cls === null) return { position, callers: [] };
  return { position, callers: [...(name === null ? [] : [['member', `${cls}.${name}`]]), ['class', cls]] };
}
function calleeName(call) {
  const callee = call.expression;
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}
/** The first caller with a pair of this name, lacking pairs before agreeing ones. */
function match(file, callers, name) {
  const ofFile = byFile.get(file);
  if (!ofFile || name === null) return null;
  for (const bucket of ['lacks', 'agree']) {
    for (const [role, caller] of callers) {
      const entry = ofFile.get(`${caller} > ${name}`);
      if (entry && entry[bucket].length > 0) return { bucket, role, pairs: entry[bucket] };
    }
  }
  return null;
}

let filesParsed = 0;
for (const file of [...byFile.keys()].sort()) {
  let text;
  try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
  if (!text.includes('@')) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  filesParsed += 1;
  const record = (what, decorator, name, form) => {
    const { position, callers } = placeOf(decorator);
    const found = match(file, callers, name);
    const verdict = found === null ? 'no pair' : found.bucket === 'lacks' ? `lacking, from the ${found.role}` : `stored, from the ${found.role}`;
    const key = `${what} | ${form} | on a ${position} | ${verdict}`;
    count(sites, key);
    sample(key, `${file}:${sf.getLineAndCharacterOfPosition(decorator.getStart(sf)).line + 1} ${name}`);
    if (found?.bucket === 'lacks') {
      for (const pair of found.pairs) {
        explained[what].add(pair);
        if (!explainedBy.has(pair)) explainedBy.set(pair, `${what} | on a ${position} | from the ${found.role}`);
      }
    }
  };
  const inside = (node, decorator) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) record('a call inside its arguments', decorator, calleeName(node), ts.isNewExpression(node) ? 'new' : 'call');
    ts.forEachChild(node, (child) => inside(child, decorator));
  };
  const visit = (node) => {
    if (ts.isDecorator(node)) {
      const expr = node.expression;
      if (ts.isCallExpression(expr)) {
        const name = calleeName(expr);
        count(names.called, name ?? '(not a name)');
        record('the decorator itself', node, name, ts.isIdentifier(expr.expression) ? '@name(...)' : '@a.name(...)');
        for (const arg of expr.arguments) inside(arg, node);
      } else {
        const name = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : null;
        count(names.bare, name ?? '(not a name)');
        record('the decorator itself', node, name, ts.isIdentifier(expr) ? '@name' : '@a.name or other');
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const explainedEither = new Set([...explained['the decorator itself'], ...explained['a call inside its arguments']]);
const byWhere = new Map();
for (const where of explainedBy.values()) count(byWhere, where);
const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
const sorted = (map) => Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
const result = {
  corpus: resolve(root),
  call_pairs: { agree: agree.size, lacks: lacks.size },
  calling_files_with_an_at_sign_parsed: filesParsed,
  lacking_pairs_that_are: {
    'the decorator itself': explained['the decorator itself'].size,
    'a call inside its arguments': explained['a call inside its arguments'].size,
    either: explainedEither.size,
  },
  lacking_pairs_by_where_the_decorator_is: sorted(byWhere),
  decorator_sites: sorted(sites),
  called_names_top_25: top(names.called, 25),
  bare_names_top_25: top(names.bare, 25),
  samples: sorted(samples),
};
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
const { samples: _samples, ...printed } = result;
console.log(JSON.stringify(printed, null, 1));
