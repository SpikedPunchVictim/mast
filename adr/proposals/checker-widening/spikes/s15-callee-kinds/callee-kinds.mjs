#!/usr/bin/env node
/**
 * Spike s15 for checker-widening: every call in a corpus, by what the compiler says its
 * callee is.
 *
 *   node callee-kinds.mjs <corpus root> <out.json> [--workspace-src] [--node-next] <tsconfig> [<tsconfig> ...]
 *
 * `--node-next` is for a project whose tsconfig extends a package that is not installed
 * (directus): it sets NodeNext modules, an ES2022 target and `strict` where the config
 * that could be read sets no module resolution.
 *
 * s14 found that mast has no symbol row for a function inside a TypeScript `namespace` or
 * for a method of an interface, so no import rule can give those calls an edge. This counts
 * how many calls that is by any route, and what the other callee kinds without a row cost
 * (`fixture.out.txt` beside this script is what mast stores for each kind).
 *
 * The callee is the declaration of the signature the compiler resolved for the call
 * (`getResolvedSignature`), which for a call through an interface is the member of the
 * interface, not an implementation. Call expressions only: no `new`, no tagged template,
 * no decorator. Sites are counted, and distinct callee declarations beside them.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const ts = createRequire(join(REPO, 'package.json'))('typescript');

const [rootArg, out, ...rest] = process.argv.slice(2);
const workspaceSrc = rest.includes('--workspace-src');
const nodeNext = rest.includes('--node-next');
const tsconfigs = rest.filter((a) => a !== '--workspace-src' && a !== '--node-next');
if (!rootArg || !out || tsconfigs.length === 0) {
  console.error('usage: callee-kinds.mjs <corpus root> <out.json> [--workspace-src] <tsconfig> [<tsconfig> ...]');
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
const distinct = new Map();
const seenFiles = new Set();
const count = (map, key, text) => {
  map.set(key, (map.get(key) ?? 0) + 1);
  if (text === undefined) return;
  const list = samples.get(key) ?? [];
  samples.set(key, list);
  if (list.length < 5) list.push(text);
};
const byKind = new Map();
const byKindForm = new Map();
const byKindImplementors = new Map();

const isStatic = (decl) => decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true;
const isAbstract = (decl) => decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) === true;

/** Where a declaration sits: in a TypeScript namespace, in a function body, or at the top of its file. */
function scopeOf(decl) {
  for (let node = decl.parent; node; node = node.parent) {
    if (ts.isModuleDeclaration(node)) return ts.isStringLiteral(node.name) ? 'in a declared module' : 'in a TypeScript namespace';
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return 'inside a function or class body';
    if (ts.isSourceFile(node)) return 'at the top of its file';
  }
  return 'at the top of its file';
}

/** The holder of a function value: what the arrow function or function expression is assigned to. */
function holderOf(fn) {
  let node = fn.parent;
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))) node = node.parent;
  if (!node) return 'a function expression, not held';
  if (ts.isVariableDeclaration(node)) return `a constant holding a function, ${scopeOf(node)}`;
  if (ts.isPropertyDeclaration(node)) return isStatic(node) ? 'a static class property holding a function' : 'a class property holding a function';
  if (ts.isPropertyAssignment(node)) return 'a property of an object literal holding a function';
  return 'a function expression, not held';
}

/** What declares a function type: `FunctionType`, a call signature, and so on. */
function typeHolderOf(decl) {
  let node = decl.parent;
  while (node && (ts.isParenthesizedTypeNode(node) || ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node) || ts.isOptionalTypeNode(node))) node = node.parent;
  if (!node) return 'a function type, elsewhere';
  if (ts.isPropertySignature(node)) return ts.isInterfaceDeclaration(node.parent) ? 'a property of an interface with a function type' : 'a property of a type literal with a function type';
  if (ts.isParameter(node)) return 'a parameter with a function type';
  if (ts.isPropertyDeclaration(node)) return 'a class property with a function type, no function in it';
  if (ts.isTypeAliasDeclaration(node)) return 'a type alias for a function type';
  if (ts.isVariableDeclaration(node)) return 'a variable with a function type';
  if (ts.isInterfaceDeclaration(node)) return 'a call signature of an interface';
  if (ts.isTypeLiteralNode(node)) return 'a call signature of a type literal';
  return 'a function type, elsewhere';
}

function kindOf(decl) {
  if (ts.isFunctionDeclaration(decl)) return `a function, ${scopeOf(decl)}`;
  if (ts.isMethodDeclaration(decl)) {
    if (ts.isObjectLiteralExpression(decl.parent)) return 'a method of an object literal';
    const cls = ts.isClassExpression(decl.parent) ? ' of a class expression' : '';
    return `${isAbstract(decl) ? 'an abstract method' : isStatic(decl) ? 'a static method' : 'a method'}${cls}`;
  }
  if (ts.isMethodSignature(decl)) return ts.isInterfaceDeclaration(decl.parent) ? 'a method of an interface' : 'a method of a type literal';
  if (ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) return holderOf(decl);
  if (ts.isFunctionTypeNode(decl) || ts.isCallSignatureDeclaration(decl)) return typeHolderOf(decl);
  if (ts.isConstructorDeclaration(decl) || ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) return 'a constructor, by super()';
  if (ts.isJSDocSignature(decl) || ts.isJSDocFunctionType(decl)) return 'a JSDoc signature';
  return ts.SyntaxKind[decl.kind];
}

/** How the callee is written at the call. */
function formOf(expr) {
  if (ts.isIdentifier(expr)) return 'f()';
  if (!ts.isPropertyAccessExpression(expr)) return 'not a name or a property access';
  const parts = [];
  let node = expr;
  while (ts.isPropertyAccessExpression(node)) { parts.push('p'); node = node.expression; }
  const dots = parts.length;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return dots === 1 ? 'this.f()' : dots === 2 ? 'this.a.f()' : 'this.a.b.f() or longer';
  if (node.kind === ts.SyntaxKind.SuperKeyword) return 'super.f()';
  if (ts.isIdentifier(node)) return dots === 1 ? 'a.f()' : dots === 2 ? 'a.b.f()' : 'a.b.c.f() or longer';
  return 'on the result of an expression';
}

const keyOf = (decl) => `${decl.getSourceFile().fileName}:${decl.pos}`;

const programs = [];
for (const tsconfig of tsconfigs) {
  const path = join(root, tsconfig);
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) { programs.push({ tsconfig, error: 'could not be read' }); continue; }
  const fallback = nodeNext && parsed.options.moduleResolution === undefined
    ? { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, strict: true }
    : {};
  const options = { ...parsed.options, ...fallback, noEmit: true, paths: { ...workspacePaths, ...(parsed.options.paths ?? {}) } };
  const program = ts.createProgram({ rootNames: parsed.fileNames, options });
  const checker = program.getTypeChecker();

  // Classes that name an interface in their own `implements` clause, per interface.
  const implementors = new Map();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !inCorpus(sf.fileName)) continue;
    const visit = (node) => {
      if (ts.isClassLike(node)) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
          for (const type of clause.types) {
            let symbol = checker.getSymbolAtLocation(type.expression);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            for (const decl of symbol?.declarations ?? []) {
              if (!ts.isInterfaceDeclaration(decl)) continue;
              const set = implementors.get(keyOf(decl)) ?? new Set();
              implementors.set(keyOf(decl), set);
              set.add(keyOf(node));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  let files = 0;
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !inCorpus(sf.fileName) || seenFiles.has(sf.fileName)) continue;
    seenFiles.add(sf.fileName);
    files += 1;
    const at = (node) => `${relative(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${node.getText(sf).split('\n')[0].slice(0, 70)}`;
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
        const decl = checker.getResolvedSignature(node)?.declaration;
        if (!decl) {
          count(tally, 'no declaration: the callee has no type here, or the type has no signature');
        } else {
          const file = decl.getSourceFile();
          const where = !inCorpus(file.fileName) ? 'outside the corpus' : file.isDeclarationFile ? 'in a .d.ts of the corpus' : 'in the corpus';
          if (where !== 'in the corpus') {
            count(tally, `callee ${where}`);
          } else {
            const kind = kindOf(decl);
            count(byKind, kind, at(node));
            const set = distinct.get(kind) ?? new Set();
            distinct.set(kind, set);
            set.add(keyOf(decl));
            count(byKindForm, `${kind} | written ${formOf(node.expression)}`);
            if (kind === 'a method of an interface' || kind === 'a property of an interface with a function type') {
              const n = implementors.get(keyOf(decl.parent.kind === ts.SyntaxKind.InterfaceDeclaration ? decl.parent : decl.parent.parent))?.size ?? 0;
              count(byKindImplementors, `${kind} | ${n === 0 ? 'no class' : n === 1 ? 'one class' : 'two or more classes'} names the interface in an implements clause`);
            }
            count(tally, 'callee in the corpus');
          }
        }
        count(tally, 'call expressions');
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  programs.push({
    tsconfig,
    corpus_files_first_seen_here: files,
    config_errors: parsed.errors.length,
    module_resolution: options.moduleResolution === undefined ? 'not set' : ts.ModuleResolutionKind[options.moduleResolution],
  });
}

const sorted = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
const result = {
  corpus: root,
  workspace_src: workspaceSrc,
  node_next_fallback: nodeNext,
  programs,
  corpus_files_read: seenFiles.size,
  totals: sorted(tally),
  sites_by_callee_kind: sorted(byKind),
  distinct_callees_by_kind: Object.fromEntries([...distinct.entries()].map(([k, v]) => [k, v.size]).sort((a, b) => b[1] - a[1])),
  sites_by_callee_kind_and_form: Object.fromEntries([...byKindForm.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  interface_sites_by_implementors: sorted(byKindImplementors),
  samples: Object.fromEntries([...samples.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
};
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ programs, corpus_files_read: seenFiles.size, totals: result.totals }, null, 1));
for (const [k, v] of Object.entries(result.sites_by_callee_kind)) console.log(String(v).padStart(7), String(result.distinct_callees_by_kind[k]).padStart(6), k);
console.log(JSON.stringify(result.interface_sites_by_implementors, null, 1));
