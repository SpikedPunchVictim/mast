#!/usr/bin/env node
/**
 * Spike s10 for checker-widening: what is called through a namespace import.
 *
 *   node sites.mjs <corpus root> <out.json> [--workspace-src] <tsconfig> [<tsconfig> ...]
 *
 * Builds one program per tsconfig and, for every call and `new` in a source file of the
 * corpus (not a declaration file, not under node_modules; a file in two programs is read
 * once) whose callee is a property access chain rooted in a name that is a module
 * namespace, records:
 *
 *   root      how the file got the namespace: `import * as ns`, a named import of an
 *             `export * as ns` (or of a re-exported namespace import), `import ns = require`
 *   written   `ns.f()`, `new ns.C()`, `ns.a.f()` (one name between), deeper
 *   target    what the compiler says the callee is, and whether it is in the corpus
 *   direct    whether the target is declared in the file the import's specifier resolves
 *             to, or is reached through a re-export of that file
 *
 * It also counts type references written `ns.T`, for the size of the same gap on the
 * type side. Sites, not caller/callee pairs. `--workspace-src` as in s9.
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
  console.error('usage: sites.mjs <corpus root> <out.json> [--workspace-src] <tsconfig> [<tsconfig> ...]');
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
  if (list.length < 5) list.push(text);
};

/** The names of a property access chain, root first, or null when it is not all names. */
function chain(expr) {
  const names = [];
  let node = expr;
  while (ts.isPropertyAccessExpression(node)) { names.unshift(node.name); node = node.expression; }
  if (!ts.isIdentifier(node)) return null;
  names.unshift(node);
  return names;
}

/** How the root name got a namespace, or null when it is not one. */
function namespaceRoot(checker, id) {
  const symbol = checker.getSymbolAtLocation(id);
  const decl = symbol?.declarations?.[0];
  if (!decl) return null;
  if (ts.isNamespaceImport(decl)) return { how: 'import * as ns', specifier: decl.parent.parent.moduleSpecifier };
  if (ts.isImportEqualsDeclaration(decl)) return { how: 'import ns = require', specifier: null };
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl)) {
    const target = checker.getAliasedSymbol(symbol);
    const targetDecl = target?.declarations?.[0];
    if (targetDecl && ts.isSourceFile(targetDecl)) {
      return { how: ts.isImportClause(decl) ? 'a default import that is a namespace' : 'a named import of a namespace', specifier: null };
    }
  }
  return null;
}

function targetOf(checker, nameNode) {
  let symbol = checker.getSymbolAtLocation(nameNode);
  if (!symbol) return { target: 'unresolved', where: 'unresolved', file: null };
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!decl) return { target: 'unresolved', where: 'unresolved', file: null };
  const file = decl.getSourceFile().fileName;
  const where = inCorpus(file) ? 'in the corpus' : 'outside it';
  let target = ts.SyntaxKind[decl.kind];
  if (ts.isVariableDeclaration(decl)) {
    const init = decl.initializer;
    target = !init ? 'a variable, no initializer'
      : ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? 'a variable holding a function'
      : ts.isCallExpression(init) ? 'a variable holding the result of a call'
      : `a variable holding ${ts.SyntaxKind[init.kind]}`;
  } else if (ts.isFunctionDeclaration(decl)) target = 'a function';
  else if (ts.isClassDeclaration(decl)) target = 'a class';
  else if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) target = 'a method';
  else if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isPropertyAssignment(decl)) target = 'a property';
  return { target, where, file };
}

const programs = [];
for (const tsconfig of tsconfigs) {
  const path = join(root, tsconfig);
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) { programs.push({ tsconfig, error: 'could not be read' }); continue; }
  const options = { ...parsed.options, noEmit: true, paths: { ...workspacePaths, ...(parsed.options.paths ?? {}) } };
  const program = ts.createProgram({ rootNames: parsed.fileNames, options });
  const checker = program.getTypeChecker();
  let files = 0;
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !inCorpus(sf.fileName) || seenFiles.has(sf.fileName)) continue;
    seenFiles.add(sf.fileName);
    files += 1;
    const at = (node) => `${relative(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${node.getText(sf).split('\n')[0].slice(0, 70)}`;
    const visit = (node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        count('all calls and news', at(node));
        const names = ts.isPropertyAccessExpression(node.expression) ? chain(node.expression) : null;
        const ns = names === null ? null : namespaceRoot(checker, names[0]);
        if (names !== null && ns !== null) {
          const isNew = ts.isNewExpression(node);
          const written = names.length === 2 ? (isNew ? 'new ns.C()' : 'ns.f()')
            : names.length === 3 ? (isNew ? 'new ns.a.C()' : 'ns.a.f()') : 'deeper';
          const { target, where, file } = targetOf(checker, names[names.length - 1]);
          let direct = '';
          if (where === 'in the corpus' && ns.specifier !== null) {
            const resolved = ts.resolveModuleName(ns.specifier.text, sf.fileName, options, ts.sys).resolvedModule?.resolvedFileName;
            direct = resolved === undefined ? ' | specifier not resolved' : resolved === file ? ' | declared in the imported file' : ' | through a re-export';
          }
          count(`${written} | ${ns.how} | ${where} | ${target}${direct}`, at(node));
        }
      }
      if (ts.isTypeReferenceNode(node) && ts.isQualifiedName(node.typeName) && ts.isIdentifier(node.typeName.left)) {
        const ns = namespaceRoot(checker, node.typeName.left);
        if (ns !== null) {
          const { where } = targetOf(checker, node.typeName.right);
          count(`type reference ns.T | ${ns.how} | ${where}`, at(node));
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
