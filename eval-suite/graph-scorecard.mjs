#!/usr/bin/env node
/**
 * Graph scorecard — for every kind of thing mast stores about TypeScript, how much of it
 * agrees with what the TypeScript compiler says about the same files.
 *
 *   node eval-suite/graph-scorecard.mjs run --root <project> --tsconfig <tsconfig.json> \
 *        --db <graph.db> [--prefix <dir/>] [--workspace-src] [--label <text>] [--out <file.json[.gz]>]
 *   node eval-suite/graph-scorecard.mjs compare <before.json[.gz]> <after.json[.gz]> [--out <file.json>]
 *
 * `run` reads a graph mast has already written (index first, with the build under test)
 * and writes a scorecard: one line item per symbol kind, edge type, and import record,
 * each with the keys that agree, are wrong, are lacking, are extra, or could not be judged
 * (`scorecard-lib.mjs` defines these). `compare` puts two scorecards side by side, lists
 * every key that changed bucket, and exits 1 if anything that agreed was lost or anything
 * is newly wrong. Exit 2 is a usage error.
 *
 * The reference is the TypeScript compiler API and nothing of mast's: this file imports no
 * mast code and does not use `mast index --checker`, which resolves through mast's own
 * symbol and import rows and so shares their defects. It grew out of
 * `adr/proposals/graph-reference/spikes/s1-call-edges/reference.mjs`, which judged call
 * edges only and joined declarations by line.
 *
 * `--tsconfig` is read relative to `--root`. `--workspace-src` maps each package under
 * `<root>/packages` to its `src/` by name, so a call into another package resolves to the
 * source mast indexed and not to build output. `--prefix` limits what is scored to the
 * files under it; a target may be declared in any indexed file. `--label` is kept in the
 * result: say which build wrote the index and which copy of the corpus it is.
 *
 * Without `--out` the result goes to `eval-suite/out/` (ignored by git). Nothing is ever
 * written under `eval/results/`.
 *
 * What it does not score: JavaScript and Markdown files, search ranking, chunk contents,
 * and the parameter types `mast_signature` resolves when asked. Line numbers are not
 * compared either: keys are paths and names so that two runs can be compared.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { workspacePackageDirs } from './workspace-packages.mjs';
import { compareScorecards, emptyBuckets, formatComparison, formatScorecard, normalise, scoreSets, sourceBesideDeclaration } from './scorecard-lib.mjs';

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLISHED = resolve(SUITE_DIR, '..', 'eval', 'results');

function usage(message) {
  if (message) console.error(message);
  console.error('usage: graph-scorecard.mjs run --root <dir> --tsconfig <file> --db <graph.db> [--prefix <dir/>] [--workspace-src] [--label <text>] [--out <file>]');
  console.error('       graph-scorecard.mjs compare <before> <after> [--out <file>]');
  process.exit(2);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--workspace-src') flags['workspace-src'] = true;
    else if (arg.startsWith('--')) flags[arg.slice(2)] = argv[++i];
    else positional.push(arg);
  }
  return { flags, positional };
}

/** The first file an `exports` entry names: a string, or the first string under its conditions. */
function entryOf(entry) {
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object' || entry === null) return null;
  for (const condition of ['types', 'import', 'require', 'default']) {
    const found = entryOf(entry[condition]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The source file behind a package entry that names build output: `dist/di.js` and
 * `./dist/di.d.ts` are `src/di.ts`. Null when no such source file exists.
 */
function sourceOf(packageDir, entry) {
  if (typeof entry !== 'string') return null;
  const bare = entry.replace(/^\.\//, '').replace(/(\.d)?\.(ts|mts|cts|js|mjs|cjs)$/, '');
  // Sources are usually under `src/`; a few packages keep them beside `package.json`.
  for (const inSource of [bare.replace(/^(dist|build|lib)(\/(esm|cjs))?\//, 'src/'), bare.replace(/^(dist|build|lib)(\/(esm|cjs))?\//, '')]) {
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      if (existsSync(join(packageDir, inSource + ext))) return join(packageDir, inSource + ext);
    }
  }
  return null;
}

function readCard(path) {
  const raw = readFileSync(path);
  return JSON.parse(path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'));
}

function writeOut(path, value) {
  const target = resolve(path);
  if (target.startsWith(PUBLISHED + sep)) usage(`refusing to write into ${PUBLISHED}`);
  mkdirSync(dirname(target), { recursive: true });
  const text = JSON.stringify(value, null, 1) + '\n';
  writeFileSync(target, target.endsWith('.gz') ? gzipSync(text) : text);
  return target;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'compare') runCompare(parseArgs(rest));
else if (command === 'run') runScore(parseArgs(rest));
else usage();

function runCompare({ flags, positional }) {
  if (positional.length !== 2) usage('compare takes two scorecards');
  const [before, after] = positional.map(readCard);
  const main = compareScorecards(before, after);
  const breakdowns = compareScorecards({ items: before.breakdowns ?? {} }, { items: after.breakdowns ?? {} });
  console.log(`before: ${positional[0]}\nafter:  ${positional[1]}\n`);
  console.log(formatComparison(main));
  console.log('\nBroken down (not part of the verdict; the same keys under mast\'s label or the shape of the call):\n');
  console.log(formatComparison(breakdowns, { keysPerMove: 0 }).split('\n\n')[0]);
  if (flags.out) console.log(`\nwritten: ${writeOut(flags.out, { before: positional[0], after: positional[1], ...main, breakdowns: breakdowns.rows })}`);
  process.exit(main.pass ? 0 : 1);
}

function runScore({ flags }) {
  if (!flags.root || !flags.tsconfig || !flags.db) usage('run needs --root, --tsconfig and --db');
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const Database = require('better-sqlite3');
  const started = Date.now();
  const root = resolve(flags.root);
  const prefix = flags.prefix ?? '';
  const configPath = resolve(root, flags.tsconfig);
  if (!existsSync(configPath)) usage(`no tsconfig at ${configPath}`);

  // ---- mast's side ---------------------------------------------------------------------
  const db = new Database(resolve(flags.db), { readonly: true });
  const allFiles = db.prepare('SELECT id, path, language FROM files').all();
  const pathOfFile = new Map(allFiles.map((f) => [f.id, f.path]));
  const allIndexedPaths = new Set(allFiles.map((f) => f.path));
  const scored = allFiles.filter((f) => f.language === 'typescript' && f.path.startsWith(prefix));
  const scoredPaths = new Set(scored.map((f) => f.path));
  const symbolRows = db.prepare('SELECT id, name, kind, file_id, line, is_exported FROM symbols').all();
  const edgeRows = db.prepare("SELECT from_id, to_id, edge_type, COALESCE(resolution, '') AS resolution FROM edges").all();
  const importRows = db.prepare('SELECT file_id, module, symbols, resolved_path FROM imports').all();
  const starRows = db.prepare('SELECT from_file_id, to_file_id FROM re_export_files').all();
  db.close();

  const symbolById = new Map(symbolRows.map((s) => [s.id, { ...s, path: pathOfFile.get(s.file_id) }]));
  const keyOfSymbol = (s) => `${s.path}:${s.name}`;
  /** Every `path:name` mast has a declaration for (markers left out), anywhere in the index. */
  const declared = new Set();
  /** kind -> keys, for the scored files. */
  const mastSymbols = {};
  const mastExported = new Map();
  let repeatedRows = 0;
  /**
   * Keys that name more than one declaration row: a static and an instance member of one
   * name, a getter and a setter, a class merged with an interface, a type and a value of
   * one name. A key cannot say which row an edge is on, so an end of an edge on one of
   * these is written `key@line` on both sides (`rowKeyOf`, `keyOfDecl`), the line being
   * the declaration's (D121).
   */
  const sharedKeys = new Set();
  for (const s of symbolById.values()) {
    const key = keyOfSymbol(s);
    if (s.kind !== 'export') {
      if (declared.has(key)) sharedKeys.add(key);
      declared.add(key);
    }
    if (!scoredPaths.has(s.path)) continue;
    const kindKeys = (mastSymbols[s.kind] ??= new Set());
    if (kindKeys.has(key)) repeatedRows++;
    kindKeys.add(key);
    if (s.kind !== 'export') mastExported.set(key, mastExported.get(key) === true || s.is_exported === 1);
  }
  /** The rows of each shared key, as `key@line`: what an end of an edge on one is called. */
  const sharedRowKey = (key, line) => `${key}@${line}`;
  for (const s of symbolById.values()) {
    if (s.kind !== 'export' && sharedKeys.has(keyOfSymbol(s))) declared.add(sharedRowKey(keyOfSymbol(s), s.line));
  }
  /** A stored row as an end of an edge. A marker is the one row of its kind and keeps its key. */
  const rowKeyOf = (s) => (s.kind !== 'export' && sharedKeys.has(keyOfSymbol(s)) ? sharedRowKey(keyOfSymbol(s), s.line) : keyOfSymbol(s));
  const edgesOfType = (type) =>
    edgeRows
      .filter((e) => e.edge_type === type)
      .map((e) => ({ ...e, from: symbolById.get(e.from_id), to: symbolById.get(e.to_id) }))
      .filter((e) => e.from !== undefined && e.to !== undefined && scoredPaths.has(e.from.path));
  const pairKey = (fromKey, toKey) => `${fromKey} > ${toKey}`;

  // ---- the compiler's side ---------------------------------------------------------------
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(configPath));
  const configErrors = [...(read.error ? [read.error] : []), ...parsed.errors].map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
  let workspacePackages = 0;
  if (flags['workspace-src']) {
    const paths = {};
    for (const dir of workspacePackageDirs(root)) {
      if (!existsSync(join(dir, 'src'))) continue;
      const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
      if (!name || name in paths) continue;
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      paths[name] = [sourceOf(dir, manifest.types ?? manifest.main ?? entryOf(manifest.exports?.['.'])) ?? join(dir, 'src', 'index.ts')];
      // Sub-path exports (`@scope/pkg/tool`) first: `paths` takes the longest prefix, and
      // an exact entry beats the wildcard.
      for (const [subpath, entry] of Object.entries(typeof manifest.exports === 'object' && manifest.exports !== null ? manifest.exports : {})) {
        const source = subpath.startsWith('./') && !subpath.includes('*') ? sourceOf(dir, entryOf(entry)) : null;
        if (source !== null) paths[`${name}/${subpath.slice(2)}`] = [source];
      }
      paths[`${name}/*`] = [join(dir, 'src', '*')];
      workspacePackages++;
    }
    parsed.options.paths = { ...paths, ...(parsed.options.paths ?? {}) };
  }
  // The files the tsconfig names, whatever mast indexed: what `file: indexed` is scored
  // against, and what says whether two runs are of the same corpus.
  const configFiles = parsed.fileNames
    .filter((f) => !f.endsWith('.d.ts') && /\.(ts|tsx|mts|cts)$/.test(f))
    .map((f) => relative(root, resolve(f)).split(sep).join('/'))
    .filter((p) => !p.startsWith('..') && p.startsWith(prefix))
    .sort();
  const corpusHash = createHash('sha256');
  for (const p of configFiles) corpusHash.update(p).update('\0').update(readFileSync(join(root, p))).update('\0');
  const program = ts.createProgram({ rootNames: scored.map((f) => join(root, f.path)), options: { ...parsed.options, noEmit: true } });
  const checker = program.getTypeChecker();
  const rel = (fileName) => relative(root, resolve(fileName)).split(sep).join('/');
  const resolveAlias = (symbol) => {
    let s = symbol;
    for (let hop = 0; hop < 8 && s && s.flags & ts.SymbolFlags.Alias; hop++) s = checker.getAliasedSymbol(s);
    return s;
  };
  const isTopLevel = (node) => node.parent !== undefined && ts.isSourceFile(node.parent);
  // A computed name (`[Symbol.iterator]`) is kept as written.
  const memberName = (m) => (ts.isConstructorDeclaration(m) ? 'constructor' : !m.name ? null : ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) || ts.isPrivateIdentifier(m.name) ? m.name.text : m.name.getText());
  const isMember = (m) => ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m);

  /**
   * The `path:name` a declaration would have as a mast symbol, by the rules of MAST_SPEC
   * §10.1 (top-level functions, classes, interfaces, type aliases and variables, and the
   * members of a top-level class), or null for anything else: a nested function, an
   * interface member, a parameter. Whether mast has it is a separate question.
   */
  function keyOfDecl(decl) {
    const key = baseKeyOfDecl(decl);
    return key !== null && sharedKeys.has(key) ? sharedRowKey(key, lineOfDecl(decl)) : key;
  }
  /**
   * The line mast gives a declaration: where it starts, after any decorators, and for a
   * variable where its statement does.
   */
  function lineOfDecl(decl) {
    const node = ts.isVariableDeclaration(decl) ? decl.parent.parent : decl;
    const sf = node.getSourceFile();
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
    const start = decorators.length === 0 ? node.getStart(sf) : ts.skipTrivia(sf.text, decorators[decorators.length - 1].end);
    return sf.getLineAndCharacterOfPosition(start).line + 1;
  }
  function baseKeyOfDecl(decl) {
    const path = rel(decl.getSourceFile().fileName);
    if (isMember(decl) && ts.isClassDeclaration(decl.parent) && isTopLevel(decl.parent) && decl.parent.name) {
      const name = memberName(decl);
      return name === null ? null : `${path}:${decl.parent.name.text}.${name}`;
    }
    if ((ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)) && isTopLevel(decl) && decl.name) {
      return `${path}:${decl.name.text}`;
    }
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && ts.isVariableStatement(decl.parent.parent) && isTopLevel(decl.parent.parent)) {
      return `${path}:${decl.name.text}`;
    }
    return null;
  }
  /** The keys of a symbol's declarations that mast has a symbol for. */
  const isTypeDecl = (d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d);
  /**
   * The declarations of a symbol that a use of `meaning` names. A symbol can be a type and
   * a value at once (an interface merged with a class, a type alias beside a constant); a
   * call or a class's `extends` is of the value, `implements` of the type. All of them when
   * none is of the meaning.
   */
  const declsOfMeaning = (decls, meaning) => {
    const meant = decls.filter((d) => isTypeDecl(d) === (meaning === 'type'));
    return meant.length > 0 ? meant : decls;
  };
  /**
   * A declaration as the end of an edge. One in a `.d.ts` with a script beside it stands
   * for the script's declaration of the same name, when mast has one: that is the code a
   * call runs, and the file mast resolves the import to (D162).
   */
  function targetKeyOfDecl(decl) {
    const key = keyOfDecl(decl);
    if (key === null) return null;
    const path = rel(decl.getSourceFile().fileName);
    const script = sourceBesideDeclaration(path, (p) => allIndexedPaths.has(p));
    const inScript = script + key.slice(path.length);
    return script !== path && declared.has(inScript) ? inScript : key;
  }
  const declaredKeysOf = (symbol, meaning = 'value') =>
    [...new Set(declsOfMeaning(symbol?.declarations ?? [], meaning).map(targetKeyOfDecl).filter((k) => k !== null && declared.has(k)))];

  const ref = {
    symbols: { function: [], class: [], method: [], interface: [], type: [], export: [] },
    exported: new Map(),
    parentOf: [],
    heritage: { EXTENDS: [], IMPLEMENTS: [] }, // { from, resolved, targets }
    reExports: [], // { marker, resolved, targets }
    stars: [], // { from, resolved, target }
    importFiles: [], // { path, module, resolved, target }
    importNames: [],
    calls: [], // { caller, names, resolved, targets, shape }
  };
  const notes = {};
  const note = (what) => { notes[what] = (notes[what] ?? 0) + 1; };

  /** The file a module specifier resolves to, as a path under the root, or null if the compiler finds none. */
  function fileOfSpecifier(specifier) {
    const file = checker.getSymbolAtLocation(specifier)?.declarations?.find(ts.isSourceFile);
    return file === undefined ? null : sourceBesideDeclaration(rel(file.fileName), (p) => allIndexedPaths.has(p));
  }
  const indexedOrNull = (path) => (path !== null && allIndexedPaths.has(path) ? path : null);

  /** What is called. A tagged template calls its tag. */
  const calleeOf = (call) => (ts.isTaggedTemplateExpression(call) ? call.tag : call.expression);
  function shapeOf(call) {
    const callee = calleeOf(call);
    if (ts.isNewExpression(call)) return 'new X()';
    if (ts.isIdentifier(callee)) return 'f()';
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

  const isHolder = (d) => ts.isVariableDeclaration(d) || ts.isBindingElement(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d);
  /**
   * What a call through a holder reaches: the signature's declaration. For `new` it is the
   * class constructed, by the same rule as a `new` of a name: its own constructor when it
   * declares one, and the class otherwise. The signature's declaration is not used there,
   * since for a class with no constructor it is the one a parent declares. A holder typed
   * with a construct signature (`{ new (): T }`) holds no particular class, and keeps the
   * signature.
   */
  function heldBy(call) {
    const signature = checker.getResolvedSignature(call);
    if (signature === undefined) return [];
    const written = signature.declaration;
    // `export const f = () => {}`: the signature is the arrow's, and the symbol mast has
    // is the variable it initializes.
    const isInitializer = written !== undefined && (ts.isArrowFunction(written) || ts.isFunctionExpression(written)) &&
      ts.isVariableDeclaration(written.parent) && written.parent.initializer === written;
    const declared = isInitializer ? written.parent : written;
    const ofAClass = declared === undefined || ts.isConstructorDeclaration(declared);
    if (!ts.isNewExpression(call) || !ofAClass) return declared ? [declared] : [];
    const classes = (checker.getReturnTypeOfSignature(signature).getSymbol()?.declarations ?? []).filter(ts.isClassDeclaration);
    if (classes.length === 0) return declared ? [declared] : [];
    const ctors = classes.flatMap((c) => c.members.filter(ts.isConstructorDeclaration));
    const ctor = ctors.find((c) => c.body) ?? ctors[0];
    return ctor ? [ctor] : classes;
  }

  /** The nearest enclosing declaration mast has a symbol for. A field initializer's is its class. */
  function callerOf(node) {
    for (let n = node.parent; n; n = n.parent) {
      const key = ts.isVariableStatement(n) ? null : keyOfDecl(n);
      if (key !== null && declared.has(key)) return key;
    }
    return null;
  }

  /** member key -> the shapes declared under it, to tell an accessor pair from two members. */
  const accessorShapes = new Map();
  for (const sf of program.getSourceFiles()) {
    const path = rel(sf.fileName);
    if (!scoredPaths.has(path)) continue;
    const localKinds = new Map();
    const exportedLocally = new Set();
    const aliases = [];
    const publicMembers = [];
    const add = (kind, name, isExported) => {
      const key = `${path}:${name}`;
      ref.symbols[kind].push(key);
      if (kind !== 'export') ref.exported.set(key, ref.exported.get(key) === true || isExported);
      if (!name.includes('.')) localKinds.set(name, kind);
    };
    const hasExport = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;

    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) add('function', stmt.name.text, hasExport(stmt));
      else if (ts.isInterfaceDeclaration(stmt)) add('interface', stmt.name.text, hasExport(stmt));
      else if (ts.isTypeAliasDeclaration(stmt)) add('type', stmt.name.text, hasExport(stmt));
      else if (ts.isClassDeclaration(stmt) && stmt.name) {
        const className = stmt.name.text;
        add('class', className, hasExport(stmt));
        for (const m of stmt.members) {
          if (!isMember(m)) continue;
          const name = memberName(m);
          if (name === null) continue;
          const isPrivate = (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Private) !== 0 || (m.name && ts.isPrivateIdentifier(m.name));
          add('method', `${className}.${name}`, hasExport(stmt) && !isPrivate);
          if (!isPrivate) publicMembers.push({ className, key: `${path}:${className}.${name}` });
          ref.parentOf.push(pairKey(keyOfDecl(stmt), keyOfDecl(m)));
          // A getter and a setter of one property are two rows and one thing.
          const isAccessor = ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m);
          const isStatic = (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) !== 0;
          const shapes = accessorShapes.get(`${path}:${className}.${name}`) ?? new Set();
          accessorShapes.set(`${path}:${className}.${name}`, shapes.add(`${isAccessor ? 'accessor' : 'other'}:${isStatic}`));
        }
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) { note('top-level destructuring declaration'); continue; }
          // A function expression counts as the arrow does (D144); `function*` is one too.
          if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) add('function', d.name.text, hasExport(stmt));
          else note('top-level variable that is not a function');
        }
      } else if (ts.isEnumDeclaration(stmt)) note('enum');
      else if (ts.isModuleDeclaration(stmt)) note('namespace or module declaration');
      else if (ts.isExportAssignment(stmt)) note('export default <expression>');
      else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) note('unnamed default function or class');

      // extends / implements
      if ((ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) && stmt.name) {
        for (const clause of stmt.heritageClauses ?? []) {
          const type = clause.token === ts.SyntaxKind.ImplementsKeyword ? 'IMPLEMENTS' : 'EXTENDS';
          for (const t of clause.types) {
            const symbol = resolveAlias(checker.getSymbolAtLocation(t.expression));
            const meaning = type === 'EXTENDS' && ts.isClassDeclaration(stmt) ? 'value' : 'type';
            ref.heritage[type].push({ from: keyOfDecl(stmt), resolved: (symbol?.declarations ?? []).length > 0, targets: declaredKeysOf(symbol, meaning) });
          }
        }
      }

      if (ts.isImportDeclaration(stmt)) {
        const module = stmt.moduleSpecifier.text;
        const target = fileOfSpecifier(stmt.moduleSpecifier);
        ref.importFiles.push({ path, module, target });
        const clause = stmt.importClause;
        if (!clause) note('import for side effects');
        // `import X from` binds the module's `default`, and mast stores it as that name (D130).
        if (clause?.name) ref.importNames.push(`${path} { default } from '${module}'`);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) note('namespace import');
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            if (spec.propertyName) note('named import with an alias');
            ref.importNames.push(`${path} { ${(spec.propertyName ?? spec.name).text} } from '${module}'`);
          }
        }
      }

      if (ts.isExportDeclaration(stmt)) {
        if (stmt.moduleSpecifier && !stmt.exportClause) {
          const target = fileOfSpecifier(stmt.moduleSpecifier);
          ref.stars.push({ from: path, resolved: target !== null, target: indexedOrNull(target) });
        } else if (stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const spec of stmt.exportClause.elements) {
            add('export', spec.name.text, true);
            const symbol = resolveAlias(checker.getSymbolAtLocation(spec.name));
            ref.reExports.push({ marker: `${path}:${spec.name.text}`, resolved: (symbol?.declarations ?? []).length > 0, targets: declaredKeysOf(symbol) });
          }
        } else if (stmt.moduleSpecifier) note('export * as namespace');
        else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const spec of stmt.exportClause.elements) {
            // A named import that is then exported is a re-export with the `from` on
            // another line (D108): a marker, and an edge to the declaration.
            const local = checker.getExportSpecifierLocalTargetSymbol(spec);
            if ((local?.declarations ?? []).some(ts.isImportSpecifier)) {
              add('export', spec.name.text, true);
              const symbol = resolveAlias(local);
              ref.reExports.push({ marker: `${path}:${spec.name.text}`, resolved: (symbol?.declarations ?? []).length > 0, targets: declaredKeysOf(symbol) });
            } else if (spec.propertyName && spec.propertyName.text !== spec.name.text) aliases.push({ local: spec.propertyName.text, alias: spec.name.text });
            else exportedLocally.add(spec.name.text);
          }
        }
      }
    }
    // `export { a }` after the declaration exports `a`; `export { a as b }` gives `b` a
    // symbol of `a`'s kind and leaves `a` unexported (MAST_SPEC §10.1, local aliases).
    for (const name of exportedLocally) {
      const key = `${path}:${name}`;
      if (ref.exported.has(key)) ref.exported.set(key, true);
      // A member is exported when its class is and it is not private.
      for (const m of publicMembers) if (m.className === name) ref.exported.set(m.key, true);
    }
    for (const { local, alias } of aliases) {
      const kind = localKinds.get(local);
      if (kind === undefined) note('export { a as b } of a name with no symbol kind');
      else add(kind, alias, true);
    }

    const visit = (node) => {
      // `const { X } = await import('./x')`: mast records it as an import of `X`.
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isAwaitExpression(node.initializer)) {
        const call = node.initializer.expression;
        const specifier = ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword && call.arguments.length === 1 ? call.arguments[0] : null;
        if (specifier !== null && ts.isStringLiteralLike(specifier)) {
          ref.importFiles.push({ path, module: specifier.text, target: fileOfSpecifier(specifier) });
          for (const element of node.name.elements) {
            const exported = element.propertyName ?? element.name;
            if (ts.isIdentifier(exported) && ts.isIdentifier(element.name)) ref.importNames.push(`${path} { ${exported.text} } from '${specifier.text}'`);
          }
        }
      }
      // A tagged template is a call of its tag, and mast stores it as one.
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
        const callee = calleeOf(node);
        const nameNode = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : null;
        const caller = nameNode === null ? null : callerOf(node);
        if (nameNode === null) note('call whose callee is not a name or a property');
        else if (caller === null) note('call outside any declaration mast has a symbol for');
        else {
          const symbol = resolveAlias(checker.getSymbolAtLocation(nameNode));
          let decls = declsOfMeaning(symbol?.declarations ?? [], 'value');
          // `this.acc()` reads the property and calls what it holds: the getter runs, not the setter.
          if (decls.some(ts.isGetAccessorDeclaration)) decls = decls.filter((d) => !ts.isSetAccessorDeclaration(d));
          const names = [nameNode.text];
          // `new X()` reaches X's constructor when the class declares one, and the class
          // otherwise (decided 2026-10-07). An implementation is preferred to an overload.
          if (ts.isNewExpression(node)) {
            names.push('constructor');
            const ctors = decls.filter(ts.isClassDeclaration).flatMap((c) => c.members.filter(ts.isConstructorDeclaration));
            const ctor = ctors.find((c) => c.body) ?? ctors[0];
            if (ctor) decls = [ctor];
          }
          let targets = [...new Set(decls.map(targetKeyOfDecl).filter((k) => k !== null && declared.has(k)))];
          // The name is a variable, a parameter or a field that holds the thing called
          // (`const { X } = await import('./x')`, `const f = g`). The symbol is the
          // holder; the signature the compiler picked for the call says what is held.
          if (targets.length === 0 && decls.length > 0 && decls.every(isHolder)) {
            const held = heldBy(node);
            const heldTargets = [...new Set(held.map(targetKeyOfDecl).filter((k) => k !== null && declared.has(k)))];
            if (heldTargets.length > 0) { targets = heldTargets; note('call through a variable, judged by its signature'); }
          }
          ref.calls.push({ caller, names, resolved: decls.length > 0, targets, shape: shapeOf(node) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // ---- scoring -------------------------------------------------------------------------
  // Listed as one key with more than one row, except a getter and setter of one property,
  // which are two rows and one thing. Their edges are told apart by row all the same.
  const listedSharedKeys = new Set(sharedKeys);
  for (const [key, shapes] of accessorShapes) {
    if (shapes.size === 1 && [...shapes][0].startsWith('accessor:')) listedSharedKeys.delete(key);
  }

  const items = {};
  const breakdowns = {};

  // A file the tsconfig names and mast has no row for has no symbol, edge or import on
  // either side below, so it is counted here or nowhere.
  items['file: indexed'] = { ...scoreSets(configFiles, scored.map((f) => f.path)), extra: [] };
  {
    const shared = emptyBuckets();
    for (const key of listedSharedKeys) if (scoredPaths.has(key.slice(0, key.lastIndexOf(':')))) shared.unjudged.push(key);
    items['symbol: one key, more than one row'] = shared;
  }

  for (const kind of Object.keys(ref.symbols)) {
    items[`symbol: ${kind}`] = scoreSets(ref.symbols[kind], mastSymbols[kind] ?? []);
  }
  for (const kind of Object.keys(mastSymbols)) {
    if (!(kind in ref.symbols)) items[`symbol: ${kind}`] = scoreSets([], mastSymbols[kind]);
  }
  // The exported flag, for declarations both sides have.
  const flag = emptyBuckets();
  for (const [key, isExported] of ref.exported) {
    if (!mastExported.has(key)) continue;
    (mastExported.get(key) === isExported ? flag.agree : flag.wrong).push(`${key} exported=${isExported}`);
  }
  items['symbol flag: is_exported'] = flag;

  /**
   * Score edges where the reference names targets per source. A stored edge the reference
   * does not have is wrong when the reference resolved everything that source refers to
   * (so it knows the edge belongs elsewhere or nowhere), and unjudged when it could not.
   */
  function scoreEdges(mastPairs, entries, sourceOf) {
    const buckets = emptyBuckets();
    const referencePairs = new Set(entries.flatMap((e) => e.targets.map((t) => pairKey(sourceOf(e), t))));
    const unresolvedSources = new Set(entries.filter((e) => !e.resolved).map(sourceOf));
    const mast = new Set(mastPairs.map((p) => p.key));
    for (const p of mastPairs) {
      if (referencePairs.has(p.key)) buckets.agree.push(p.key);
      else if (unresolvedSources.has(p.source)) buckets.unjudged.push(p.key);
      else buckets.wrong.push(p.key);
    }
    for (const key of referencePairs) if (!mast.has(key)) buckets.lacks.push(key);
    return buckets;
  }
  const storedPairs = (type) => edgesOfType(type).map((e) => ({ source: rowKeyOf(e.from), key: pairKey(rowKeyOf(e.from), rowKeyOf(e.to)), resolution: e.resolution }));

  items['edge: PARENT_OF'] = scoreSets(ref.parentOf, storedPairs('PARENT_OF').map((p) => p.key));
  items['edge: EXTENDS'] = scoreEdges(storedPairs('EXTENDS'), ref.heritage.EXTENDS, (e) => e.from);
  items['edge: IMPLEMENTS'] = scoreEdges(storedPairs('IMPLEMENTS'), ref.heritage.IMPLEMENTS, (e) => e.from);

  // A marker's edge may reach another marker; what is compared is the declaration at the end.
  const reExportNext = new Map(edgeRows.filter((e) => e.edge_type === 'RE_EXPORTS').map((e) => [e.from_id, e.to_id]));
  const reExportPairs = [];
  for (const [fromId] of reExportNext) {
    const from = symbolById.get(fromId);
    if (from === undefined || !scoredPaths.has(from.path)) continue;
    let end = symbolById.get(reExportNext.get(fromId));
    for (let hop = 0; hop < 8 && end !== undefined && end.kind === 'export' && reExportNext.has(end.id); hop++) end = symbolById.get(reExportNext.get(end.id));
    if (end === undefined) continue;
    if (end.kind === 'export') note('RE_EXPORTS chain that ends on a marker');
    reExportPairs.push({ source: rowKeyOf(from), key: pairKey(rowKeyOf(from), rowKeyOf(end)) });
  }
  items['edge: RE_EXPORTS (to the declaration)'] = scoreEdges(reExportPairs, ref.reExports, (e) => e.marker);

  const starPairs = starRows
    .map((r) => ({ source: pathOfFile.get(r.from_file_id), key: `${pathOfFile.get(r.from_file_id)} => ${pathOfFile.get(r.to_file_id)}` }))
    .filter((p) => scoredPaths.has(p.source));
  {
    const buckets = emptyBuckets();
    const referencePairs = new Set(ref.stars.filter((s) => s.target).map((s) => `${s.from} => ${s.target}`));
    const unresolved = new Set(ref.stars.filter((s) => !s.resolved).map((s) => s.from));
    const mast = new Set(starPairs.map((p) => p.key));
    for (const p of starPairs) (referencePairs.has(p.key) ? buckets.agree : unresolved.has(p.source) ? buckets.unjudged : buckets.wrong).push(p.key);
    for (const key of referencePairs) if (!mast.has(key)) buckets.lacks.push(key);
    items['export * (file to file)'] = buckets;
  }

  // Imports: the file each statement resolves to, and the names it binds.
  {
    const buckets = emptyBuckets();
    const keyOf = (path, module, target) => `${path} '${module}' => ${target}`;
    // An import the compiler resolves outside the index (build output of another package,
    // a `.json` file) is one it cannot hold against mast: mast agrees if it names the same
    // file, and is not judged otherwise. Only an indexed file can be lacking.
    const everyReferenceKey = new Set(ref.importFiles.filter((i) => i.target !== null).map((i) => keyOf(i.path, i.module, i.target)));
    const referenceKeys = new Set(ref.importFiles.filter((i) => indexedOrNull(i.target) !== null).map((i) => keyOf(i.path, i.module, i.target)));
    const unresolved = new Set(ref.importFiles.filter((i) => indexedOrNull(i.target) === null).map((i) => `${i.path} '${i.module}'`));
    const mastKeys = new Set();
    const mastNames = [];
    for (const row of importRows) {
      const path = pathOfFile.get(row.file_id);
      if (!scoredPaths.has(path)) continue;
      for (const name of JSON.parse(row.symbols)) mastNames.push(`${path} { ${name} } from '${row.module}'`);
      if (row.resolved_path === null) continue;
      const key = keyOf(path, row.module, row.resolved_path);
      if (mastKeys.has(key)) continue;
      mastKeys.add(key);
      (everyReferenceKey.has(key) ? buckets.agree : unresolved.has(`${path} '${row.module}'`) ? buckets.unjudged : buckets.wrong).push(key);
    }
    for (const key of referenceKeys) if (!mastKeys.has(key)) buckets.lacks.push(key);
    items['import: the file it resolves to'] = buckets;
    items['import: named binding'] = scoreSets(ref.importNames, mastNames);
  }

  // Calls. One key per caller and callee, as mast stores one edge per pair.
  {
    const all = emptyBuckets();
    const referencePairs = new Map(); // key -> shape of the first call that gave it
    const sameFile = (key) => { const [a, b] = key.split(' > '); return a.slice(0, a.lastIndexOf(':')) === b.slice(0, b.lastIndexOf(':')); };
    /** caller|name -> whether every call of that name in the caller resolved. */
    const callsByName = new Map();
    for (const c of ref.calls) {
      for (const t of c.targets) {
        const key = pairKey(c.caller, t);
        if (!referencePairs.has(key)) referencePairs.set(key, c.shape);
      }
      for (const name of c.names) {
        const k = `${c.caller}|${name}`;
        callsByName.set(k, (callsByName.get(k) ?? true) && c.resolved);
      }
    }
    const stored = edgesOfType('POTENTIAL_CALL');
    const storedKeys = new Set();
    for (const e of stored) {
      const key = pairKey(rowKeyOf(e.from), rowKeyOf(e.to));
      if (storedKeys.has(key)) continue; // repeated symbol rows
      storedKeys.add(key);
      const bare = e.to.name.slice(e.to.name.lastIndexOf('.') + 1);
      const everyCallResolved = callsByName.get(`${rowKeyOf(e.from)}|${bare}`);
      const bucket = referencePairs.has(key) ? 'agree' : everyCallResolved === true ? 'wrong' : 'unjudged';
      all[bucket].push(key);
      const label = `call edge, stored as ${e.resolution || '(no label)'}`;
      (breakdowns[label] ??= emptyBuckets())[bucket].push(key);
      if (bucket !== 'agree') continue;
      const shape = `call written as ${referencePairs.get(key)}, ${sameFile(key) ? 'same file' : 'other file'}`;
      (breakdowns[shape] ??= emptyBuckets()).agree.push(key);
    }
    for (const [key, shape] of referencePairs) {
      if (storedKeys.has(key)) continue;
      all.lacks.push(key);
      (breakdowns[`call written as ${shape}, ${sameFile(key) ? 'same file' : 'other file'}`] ??= emptyBuckets()).lacks.push(key);
    }
    items['edge: POTENTIAL_CALL'] = all;
  }

  const card = {
    check: 'eval-suite/graph-scorecard',
    meta: {
      ran_at: new Date().toISOString(),
      typescript: ts.version,
      label: flags.label ?? null,
      // The directory's name only: a baseline is committed, and the full path is one machine's.
      root: basename(root),
      tsconfig: rel(configPath),
      prefix,
      config_errors: configErrors,
      workspace_packages_mapped_to_source: workspacePackages,
      scored_typescript_files: scored.length,
      tsconfig_files: configFiles.length,
      corpus_hash: corpusHash.digest('hex'),
      program_source_files: program.getSourceFiles().length,
      repeated_symbol_rows: repeatedRows,
      wall_ms: Date.now() - started,
      peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
    },
    notes: Object.fromEntries(Object.entries(notes).sort()),
    items: Object.fromEntries(Object.entries(items).sort().map(([k, v]) => [k, normalise(v)])),
    breakdowns: Object.fromEntries(Object.entries(breakdowns).sort().map(([k, v]) => [k, normalise(v)])),
  };
  const out = writeOut(flags.out ?? join(SUITE_DIR, 'out', 'graph-scorecard.json'), card);
  console.log(formatScorecard(card));
  console.log('\nCalls, broken down:\n');
  console.log(formatScorecard({ items: card.breakdowns }));
  console.log('\nSeen by the compiler and given no line item:');
  for (const [what, n] of Object.entries(card.notes)) console.log(`  ${String(n).padStart(7)}  ${what}`);
  console.log(`\n${JSON.stringify(card.meta)}\nwritten: ${out}`);
  if (scored.length === 0) {
    console.error(`no indexed TypeScript file under ${JSON.stringify(prefix)}: nothing was scored`);
    process.exit(2);
  }
  if (configErrors.length > 0) {
    console.error(`tsconfig errors, the reference is not to be trusted: ${configErrors.join('; ')}`);
    process.exit(2);
  }
}
