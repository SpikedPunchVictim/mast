// Q4 — Checker vs heuristic agreement / false-green hunt (Stage 1.1,
// IMPLEMENTATION_PLAN_VEXP.md).
//
// Recreates (does NOT modify) the scenario from
// src/graph/__tests__/verified-callers.test.ts as standalone fixture files:
// that test file has exactly ONE scenario — a cross-file `import` resolution
// (handleLogin imported into routes.ts, called bare). This is the only
// scenario in that test file; see REPORT.md limitations for what this does
// NOT cover (field_type/parameter_type/new_expression/same_file resolutions
// have no fixtures in verified-callers.test.ts to recreate).
//
// Runs the REAL pipeline (runIndex from dist/, exactly as the test does) to
// get the heuristic's POTENTIAL_CALL edge, then independently resolves the
// same call site with the TypeScript checker. Any heuristic-verified edge
// that the checker proves points at the WRONG declaration is a severity-zero
// false-green finding, reported verbatim regardless of outcome.
//
//   node eval/spikes/checker-edges/q4-agreement.mjs

import ts from 'typescript';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../../../dist/store/config.js';
import { runIndex } from '../../../dist/indexer/index.js';
import { openDatabase } from '../../../dist/graph/db.js';
import { querySymbolByName, queryVerifiedCallers } from '../../../dist/graph/queries.js';
import { SPIKE_DIR } from './paths.mjs';

// Verbatim from verified-callers.test.ts (HANDLER_SRC / ROUTES_SRC) — copied,
// not imported, since that test file must not be modified and does not export
// these constants.
const HANDLER_SRC = `export function handleLogin(): void {}\n`;
const ROUTES_SRC = `import { handleLogin } from './handler';
export function registerRoutes(): void {
  handleLogin();
}
`;

const tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-edges-q4-'));
writeFileSync(join(tmpDir, 'handler.ts'), HANDLER_SRC);
writeFileSync(join(tmpDir, 'routes.ts'), ROUTES_SRC);
// Minimal tsconfig so the checker can build a Program over just these two files.
writeFileSync(join(tmpDir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    strict: true, skipLibCheck: true, noEmit: true,
  },
  include: ['*.ts'],
}));

const config = resolveConfig({ projectRoot: tmpDir });
await runIndex(config, { incremental: false });
const db = openDatabase(config.resolved_state_dir);

const [target] = await querySymbolByName(db, 'handleLogin', 'handler.ts');
const heuristicCallers = target ? await queryVerifiedCallers(db, target.id, false) : [];
await db.destroy();

// --- Checker resolution over the same fixture ---
const configFile = ts.readConfigFile(join(tmpDir, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, tmpDir);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();
const routesSourceFile = program.getSourceFile(join(tmpDir, 'routes.ts').split('\\').join('/'));

let checkerResolution = null;
if (routesSourceFile) {
  function findCall(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'handleLogin') {
      return node.expression;
    }
    let found = null;
    ts.forEachChild(node, (child) => { found = found ?? findCall(child); });
    return found;
  }
  const calleeIdentifier = findCall(routesSourceFile);
  if (calleeIdentifier) {
    let symbol = checker.getSymbolAtLocation(calleeIdentifier);
    for (let hops = 0; symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && hops < 8; hops++) {
      const aliased = checker.getAliasedSymbol(symbol);
      if (!aliased || aliased === symbol) break;
      symbol = aliased;
    }
    const decl = symbol?.getDeclarations()?.[0];
    if (decl) {
      const declSourceFile = decl.getSourceFile();
      const line = declSourceFile.getLineAndCharacterOfPosition(decl.getStart(declSourceFile)).line + 1;
      checkerResolution = {
        resolved_file: declSourceFile.fileName.split('\\').join('/').split('/').pop(),
        resolved_line: line,
        points_at_handler_ts: declSourceFile.fileName.endsWith('handler.ts'),
      };
    }
  }
}

rmSync(tmpDir, { recursive: true, force: true });

const heuristicEdge = heuristicCallers.find((c) => c.caller_symbol === 'registerRoutes');
const contradictions = [];

if (heuristicEdge) {
  if (!checkerResolution) {
    contradictions.push({
      severity: 'zero',
      description: 'Heuristic emitted a VERIFIED edge (registerRoutes -> handleLogin, resolution=' +
        heuristicEdge.resolution + ') but the checker could not resolve the same call site at all.',
    });
  } else if (!checkerResolution.points_at_handler_ts) {
    contradictions.push({
      severity: 'zero',
      description: 'Heuristic emitted a VERIFIED edge (registerRoutes -> handleLogin, resolution=' +
        heuristicEdge.resolution + ') but the checker resolves the same call to a DIFFERENT declaration: ' +
        `${checkerResolution.resolved_file}:${checkerResolution.resolved_line}. FALSE GREEN.`,
    });
  }
}

const result = {
  scope_note: 'verified-callers.test.ts contains exactly ONE scenario (cross-file import resolution). ' +
    'No field_type/parameter_type/new_expression/same_file fixtures exist in that test file to recreate — ' +
    'see REPORT.md limitations.',
  heuristic_edge_found: heuristicEdge !== undefined,
  heuristic_edge: heuristicEdge ?? null,
  checker_resolution: checkerResolution,
  contradictions,
  contradiction_count: contradictions.length,
  verdict: contradictions.length === 0
    ? 'Zero contradictions on the one available scenario.'
    : `${contradictions.length} SEVERITY-ZERO FALSE-GREEN FINDING(S) — see contradictions.`,
};

writeFileSync(join(SPIKE_DIR, 'q4-results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
