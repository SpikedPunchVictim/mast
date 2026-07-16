// Q4 BONUS (beyond the plan's strict scope, which names only
// verified-callers.test.ts's one scenario) — a targeted false-green hunt
// prompted by reading src/graph/populate.ts:insertEdges while researching Q4.
//
// insertEdges resolves an edge's "to" name against ANY symbol in the whole
// graph.db sharing that name (`toRows` has no resolved_path / file filter —
// "any file, first match per name preserves prior behaviour", populate.ts
// comment). The `imports` table DOES correctly record each import's resolved
// target file — but insertEdges never consults it when resolving the edge's
// target symbol. This script checks whether that gap is reachable: two files
// export a same-named function; the caller's import explicitly names ONE of
// them (verified via the `imports` table, resolved_path column); does the
// resulting edge point at the file the import actually names, or at
// whichever same-named symbol happened to be inserted first?
//
// SEVERITY-ZERO FALSE-GREEN CONFIRMED (see REPORT.md): when the caller
// imports from the SECOND-inserted file, the edge is verified against the
// FIRST-inserted file's declaration instead — a wrong "verified" edge, exactly
// the failure mode the plan's false-green gate exists to catch. Independently
// confirmed with the TypeScript checker on the same fixture below.
//
//   node eval/spikes/checker-edges/q4b-adversarial-same-name.mjs

import ts from 'typescript';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../../../dist/store/config.js';
import { runIndex } from '../../../dist/indexer/index.js';
import { openDatabase } from '../../../dist/graph/db.js';
import { querySymbolByName, queryVerifiedCallers } from '../../../dist/graph/queries.js';
import { SPIKE_DIR } from './paths.mjs';

const tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-edges-q4b-'));
mkdirSync(join(tmpDir, 'moduleA'));
mkdirSync(join(tmpDir, 'moduleB'));

// Two unrelated files, each exporting a function with the SAME name.
// (moduleA is created/inserted first in the walk order — matches the
// filesystem-traversal order used by the indexer.)
writeFileSync(join(tmpDir, 'moduleA', 'handler.ts'), `export function handleLogin(): string { return 'A'; }\n`);
writeFileSync(join(tmpDir, 'moduleB', 'handler.ts'), `export function handleLogin(): string { return 'B'; }\n`);
// routes.ts imports explicitly from moduleB (the SECOND-inserted file) —
// this is the direction that reproduces the bug (importing from moduleA,
// the first-inserted file, coincidentally "works" and is not evidence of
// correct resolution — both directions were tried during this spike).
writeFileSync(join(tmpDir, 'routes.ts'), `import { handleLogin } from './moduleB/handler';
export function registerRoutes(): void {
  handleLogin();
}
`);
writeFileSync(join(tmpDir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    strict: true, skipLibCheck: true, noEmit: true,
  },
  include: ['*.ts', 'moduleA/*.ts', 'moduleB/*.ts'],
}));

const config = resolveConfig({ projectRoot: tmpDir });
await runIndex(config, { incremental: false });
const db = openDatabase(config.resolved_state_dir);

const targetA = (await querySymbolByName(db, 'handleLogin', 'moduleA/handler.ts'))[0];
const targetB = (await querySymbolByName(db, 'handleLogin', 'moduleB/handler.ts'))[0];
const importsRow = await db.selectFrom('imports as i').innerJoin('files as f', 'f.id', 'i.file_id')
  .select(['i.resolved_path']).where('f.path', '=', 'routes.ts').executeTakeFirst();

const callersOfA = targetA ? await queryVerifiedCallers(db, targetA.id, false) : [];
const callersOfB = targetB ? await queryVerifiedCallers(db, targetB.id, false) : [];
await db.destroy();

// --- Independent checker verification of the TRUE resolution ---
const configFile = ts.readConfigFile(join(tmpDir, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, tmpDir);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();
const routesSourceFile = program.getSourceFile(join(tmpDir, 'routes.ts').split('\\').join('/'));

function findCall(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'handleLogin') {
    return node.expression;
  }
  let found = null;
  ts.forEachChild(node, (child) => { found = found ?? findCall(child); });
  return found;
}
const calleeIdentifier = routesSourceFile ? findCall(routesSourceFile) : null;
let checkerResolvedFile = null;
if (calleeIdentifier) {
  let symbol = checker.getSymbolAtLocation(calleeIdentifier);
  for (let hops = 0; symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && hops < 8; hops++) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (!aliased || aliased === symbol) break;
    symbol = aliased;
  }
  const decl = symbol?.getDeclarations()?.[0];
  if (decl) {
    const fileName = decl.getSourceFile().fileName;
    checkerResolvedFile = fileName.includes('moduleA') ? 'moduleA/handler.ts'
      : fileName.includes('moduleB') ? 'moduleB/handler.ts' : fileName;
  }
}

rmSync(tmpDir, { recursive: true, force: true });

const edgeToA = callersOfA.find((c) => c.caller_symbol === 'registerRoutes');
const edgeToB = callersOfB.find((c) => c.caller_symbol === 'registerRoutes');

// import resolved_path says moduleB; checker independently confirms moduleB;
// a heuristic edge landing on moduleA (not moduleB) is the false-green.
const falseGreen = edgeToA !== undefined && edgeToB === undefined && checkerResolvedFile === 'moduleB/handler.ts';

const result = {
  scenario: 'Two files export a same-named function; the caller imports explicitly from moduleB ' +
    '(confirmed via the imports table\'s resolved_path AND independently via the TypeScript checker). ' +
    'insertEdges (src/graph/populate.ts) resolves the edge\'s target purely by symbol name, with no ' +
    'filter on the importing file\'s resolved_path.',
  imports_table_resolved_path: importsRow?.resolved_path ?? null,
  checker_independently_resolves_to: checkerResolvedFile,
  heuristic_edge_into_moduleA_handleLogin: edgeToA ?? null,
  heuristic_edge_into_moduleB_handleLogin: edgeToB ?? null,
  false_green_confirmed: falseGreen,
  verdict: falseGreen
    ? 'SEVERITY-ZERO FALSE-GREEN CONFIRMED: import resolved_path AND the TypeScript checker both say ' +
      'moduleB/handler.ts, but the heuristic verified an edge into moduleA/handler.ts instead — a wrong ' +
      '"verified" edge. Root cause: src/graph/populate.ts insertEdges resolves POTENTIAL_CALL edge ' +
      'targets by bare symbol name across the ENTIRE graph.db (`toRows`, no resolved_path/file filter), ' +
      'ignoring the imports table it already has resolved_path for. Reproducible: importing from the ' +
      'FIRST-inserted same-named file "works" by insertion-order coincidence, not by correct resolution — ' +
      'importing from the SECOND (or later) fails, as shown here. This bug is PRE-EXISTING in the shipped ' +
      'resolver and is INDEPENDENT of the checker-edges feature under evaluation; it affects the current ' +
      '`verified_callers` contract today whenever two files export a same-named symbol.'
    : 'No false-green in this run.',
};

console.log(JSON.stringify(result, null, 2));
writeFileSync(join(SPIKE_DIR, 'q4b-results.json'), JSON.stringify(result, null, 2));
