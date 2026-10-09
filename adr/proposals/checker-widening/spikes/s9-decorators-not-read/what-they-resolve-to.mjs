#!/usr/bin/env node
/**
 * Spike s9 for checker-widening: the decorators and calls the resolver does not read, by
 * what the compiler says they are.
 *
 *   node what-they-resolve-to.mjs <corpus root> <out.json> [--workspace-src] <tsconfig> [<tsconfig> ...]
 *
 * Builds one program per tsconfig (paths relative to the corpus root) and, for every
 * decorator and every call or `new` in a source file of the corpus that is in the program
 * (not a declaration file, not under node_modules; a file in two programs is read once),
 * resolves the callee and records what its declaration is and where:
 *
 *   form      `@name`, `@name(...)`, `@a.name`, `@a.name(...)`, other; or `call` / `new`
 *   through   for a qualified name, whether `a` is a namespace import
 *   target    function, class, method, a variable holding a function, a variable holding
 *             something else (a decorator factory's result, say), ...
 *   where     in the corpus, in node_modules, or unresolved
 *
 * `--workspace-src` maps every package of the corpus that has a `src/` to it (`name` to
 * `src/index.ts`, `name/*` to `src/*`), for a monorepo with nothing installed. It is cruder
 * than the scorecard's mapping, which reads each package's entry points, so more callees
 * are unresolved here than there.
 *
 * The questions: how many decorators with no parentheses name something in the corpus (and
 * so could have an edge); how many decorators and calls go to a variable that holds no
 * function (which has no symbol in the index); how many go through a namespace import.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const ts = createRequire(join(REPO, 'package.json'))('typescript');

const [rootArg, out, ...rest] = process.argv.slice(2);
const workspaceSrc = rest.includes('--workspace-src');
const tsconfigs = rest.filter((a) => a !== '--workspace-src');
if (!rootArg || !out || tsconfigs.length === 0) {
  console.error('usage: what-they-resolve-to.mjs <corpus root> <out.json> <tsconfig> [<tsconfig> ...]');
  process.exit(2);
}
const root = resolve(rootArg);
const inCorpus = (file) => {
  const rel = relative(root, file);
  return !rel.startsWith('..') && !rel.split('/').includes('node_modules');
};

const workspacePaths = {};
if (workspaceSrc) {
  const walk = (dir, depth) => {
    if (depth > 5) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const sub = join(dir, entry.name);
      if (existsSync(join(sub, 'package.json')) && existsSync(join(sub, 'src'))) {
        const name = JSON.parse(readFileSync(join(sub, 'package.json'), 'utf8')).name;
        if (name && !(name in workspacePaths)) {
          workspacePaths[name] = [join(sub, 'src', 'index.ts')];
          workspacePaths[`${name}/*`] = [join(sub, 'src', '*')];
        }
      }
      walk(sub, depth + 1);
    }
  };
  walk(root, 0);
}

const tally = new Map();
const samples = new Map();
const seenFiles = new Set();
const count = (key, text) => {
  tally.set(key, (tally.get(key) ?? 0) + 1);
  const list = samples.get(key) ?? [];
  samples.set(key, list);
  if (list.length < 4) list.push(text);
};

function targetOf(checker, callee) {
  let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
  if (!symbol) return { target: 'unresolved', where: 'unresolved' };
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!decl) return { target: 'unresolved', where: 'unresolved' };
  const where = inCorpus(decl.getSourceFile().fileName) ? 'in the corpus' : 'outside it';
  let target = ts.SyntaxKind[decl.kind];
  if (ts.isVariableDeclaration(decl)) {
    const init = decl.initializer;
    const topLevel = ts.isSourceFile(decl.parent?.parent?.parent ?? decl);
    target = !init ? 'a variable, no initializer'
      : ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? 'a variable holding a function'
      : ts.isCallExpression(init) ? 'a variable holding the result of a call'
      : ts.isClassExpression(init) ? 'a variable holding a class'
      : `a variable holding ${ts.SyntaxKind[init.kind]}`;
    if (!topLevel) target += ' (not top level)';
  } else if (ts.isFunctionDeclaration(decl)) target = 'a function';
  else if (ts.isClassDeclaration(decl)) target = 'a class';
  else if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) target = 'a method';
  else if (ts.isParameter(decl)) target = 'a parameter';
  else if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isPropertyAssignment(decl)) target = 'a property';
  return { target, where };
}
function through(checker, callee) {
  if (!ts.isPropertyAccessExpression(callee)) return '';
  if (!ts.isIdentifier(callee.expression)) return '';
  const symbol = checker.getSymbolAtLocation(callee.expression);
  const decl = symbol?.declarations?.[0];
  return decl && ts.isNamespaceImport(decl) ? ' | through a namespace import' : '';
}

const programs = [];
for (const tsconfig of tsconfigs) {
  const path = join(root, tsconfig);
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) { programs.push({ tsconfig, error: 'could not be read' }); continue; }
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true, paths: { ...workspacePaths, ...(parsed.options.paths ?? {}) } },
  });
  const checker = program.getTypeChecker();
  let files = 0;
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !inCorpus(sf.fileName) || seenFiles.has(sf.fileName)) continue;
    seenFiles.add(sf.fileName);
    files += 1;
    const at = (node) => `${relative(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${node.getText(sf).split('\n')[0].slice(0, 60)}`;
    const visit = (node) => {
      if (ts.isDecorator(node)) {
        const expr = node.expression;
        const called = ts.isCallExpression(expr);
        const callee = called ? expr.expression : expr;
        const form = ts.isIdentifier(callee) ? (called ? '@name(...)' : '@name')
          : ts.isPropertyAccessExpression(callee) ? (called ? '@a.name(...)' : '@a.name') : 'decorator, other';
        if (form === 'decorator, other') count(`${form}`, at(node));
        else {
          const { target, where } = targetOf(checker, callee);
          count(`${form}${through(checker, callee)} | ${where} | ${target}`, at(node));
        }
        // The decorator's own call is counted above, not again as a call.
        if (called) expr.arguments.forEach(visit);
        return;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) {
          const { target, where } = targetOf(checker, callee);
          const ns = through(checker, callee);
          if (where === 'in the corpus' && (target.startsWith('a variable') || ns !== '')) {
            count(`${ts.isNewExpression(node) ? 'new' : 'call'}${ns} | ${where} | ${target}`, at(node));
          }
          count(`all calls and news | ${where}`, at(node));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  programs.push({ tsconfig, corpus_files_first_seen_here: files });
}

const sorted = (map) => Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
const result = { corpus: root, workspace_src: workspaceSrc, programs, corpus_files_read: seenFiles.size, counts: sorted(tally), samples: sorted(samples) };
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ programs, corpus_files_read: seenFiles.size, counts: result.counts }, null, 1));
