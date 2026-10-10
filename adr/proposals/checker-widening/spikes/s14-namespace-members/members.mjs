#!/usr/bin/env node
/**
 * Spike s14 for checker-widening: the two forms through a namespace import that rule 11
 * does not read.
 *
 *   node members.mjs <corpus root> <out.json> [--workspace-src] <tsconfig> [<tsconfig> ...]
 *
 * 1. `ns.a.f()`: by what `a` is (a class, a TypeScript namespace, a constant holding an
 *    object literal, ...) and what `f` is (a static method, a function in the namespace,
 *    a method of an interface, ...), and whether `a` is declared in the file the import
 *    names.
 * 2. A method called on a receiver whose written type is `ns.T`: `p.m()` for a parameter
 *    or a local annotated `ns.T`, `this.f.m()` for a field or a constructor parameter
 *    property annotated so. By what the receiver is, what `T` is, and whether the callee
 *    is in the corpus. These are the calls a type written `ns.T` costs.
 *
 * Sites, not caller/callee pairs. The head of the script is s10's `sites.mjs`.
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
  console.error('usage: members.mjs <corpus root> <out.json> [--workspace-src] <tsconfig> [<tsconfig> ...]');
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

const kindOf = (decl) => {
  if (!decl) return 'unresolved';
  if (ts.isClassDeclaration(decl)) return 'a class';
  if (ts.isModuleDeclaration(decl)) return 'a TypeScript namespace';
  if (ts.isEnumDeclaration(decl)) return 'an enum';
  if (ts.isInterfaceDeclaration(decl)) return 'an interface';
  if (ts.isTypeAliasDeclaration(decl)) return 'a type alias';
  if (ts.isFunctionDeclaration(decl)) return 'a function';
  if (ts.isVariableDeclaration(decl)) {
    const init = decl.initializer;
    return !init ? 'a constant, no initializer'
      : ts.isObjectLiteralExpression(init) ? 'a constant holding an object literal'
      : ts.isNewExpression(init) ? 'a constant holding new X()'
      : ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? 'a constant holding a function'
      : `a constant holding ${ts.SyntaxKind[init.kind]}`;
  }
  if (ts.isMethodDeclaration(decl)) return decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ? 'a static method' : 'a method';
  if (ts.isMethodSignature(decl)) return 'a method of an interface';
  if (ts.isPropertyDeclaration(decl)) return decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ? 'a static property' : 'a property';
  if (ts.isPropertySignature(decl) || ts.isPropertyAssignment(decl)) return 'a property of an object or interface';
  if (ts.isGetAccessor(decl)) return 'a getter';
  return ts.SyntaxKind[decl.kind];
};
const declOf = (checker, node) => {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
};
const whereOf = (decl) => (!decl ? 'unresolved' : inCorpus(decl.getSourceFile().fileName) ? 'in the corpus' : 'outside it');

/** `T` when `typeNode` is written `ns.T` with `ns` a module namespace, else null. */
const namespaceTypeName = (checker, typeNode) => {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isQualifiedName(typeNode.typeName)) return null;
  if (!ts.isIdentifier(typeNode.typeName.left)) return null;
  return namespaceRoot(checker, typeNode.typeName.left) === null ? null : typeNode.typeName.right;
};

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
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const names = chain(node.expression);
        const ns = names === null ? null : namespaceRoot(checker, names[0]);
        if (names !== null && ns !== null && names.length === 3) {
          const owner = declOf(checker, names[1]);
          const callee = declOf(checker, names[2]);
          let direct = '';
          if (owner && inCorpus(owner.getSourceFile().fileName) && ns.specifier !== null) {
            const resolved = ts.resolveModuleName(ns.specifier.text, sf.fileName, options, ts.sys).resolvedModule?.resolvedFileName;
            direct = resolved === owner.getSourceFile().fileName ? ' | a declared in the imported file' : ' | a through a re-export';
          }
          count(`ns.a.f() | a is ${kindOf(owner)} | f is ${kindOf(callee)} | f ${whereOf(callee)}${direct}`, at(node));
        }
        // A method on a receiver whose written type is `ns.T`.
        const receiver = node.expression.expression;
        const isThisField = ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword;
        if (ts.isIdentifier(receiver) || isThisField) {
          const receiverDecl = checker.getSymbolAtLocation(isThisField ? receiver.name : receiver)?.valueDeclaration;
          const typeName = receiverDecl && (ts.isParameter(receiverDecl) || ts.isPropertyDeclaration(receiverDecl) || ts.isVariableDeclaration(receiverDecl))
            ? namespaceTypeName(checker, receiverDecl.type) : null;
          if (typeName !== null) {
            const what = isThisField ? (ts.isParameter(receiverDecl) ? 'this.f, a constructor parameter property' : 'this.f, a field')
              : ts.isParameter(receiverDecl) ? 'a parameter' : 'a local';
            const callee = declOf(checker, node.expression.name);
            count(`x.m() with x: ns.T | x is ${what} | T is ${kindOf(declOf(checker, typeName))} | m is ${kindOf(callee)} | m ${whereOf(callee)}`, at(node));
          }
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
console.log(JSON.stringify({ programs, corpus_files_read: seenFiles.size }, null, 1));
for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(7), k);
