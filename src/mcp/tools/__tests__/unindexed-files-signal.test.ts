// D054's open half: the partial-index warning across every tool that returns a
// primary result set, not just `mast_search`.
//
// The severity zero this closes: a caller reads an empty or thin answer,
// concludes "it isn't there", and edits or deletes code that is in fact
// referenced from a file the index never saw. Until now `mast_signature`,
// `mast_callers`, `mast_implementors`, `mast_exports`, `mast_dependencies`,
// `mast_rename_impact` and `mast_project_skeleton` all answered `0` for a
// symbol sitting on disk with no signal at all.
//
// The tools split on what their answer CLAIMS, which is the part worth pinning:
// an exhaustive-set tool warns even when it found something, because "3
// verified callers" over an incomplete corpus reads exactly like a complete
// answer; a named-lookup tool warns only when it found nothing, because a hit
// is correct however much else is missing.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig } from '../../../store/config.js';
import { runIndex } from '../../../indexer/index.js';
import { openDatabase } from '../../../graph/db.js';
import { SqliteChunkStore } from '../../../store/sqliteChunkStore.js';
import type { AppContext } from '../../context.js';
import type { FreshnessProbe } from '../../freshness-probe.js';
import { registerSearchTool } from '../search.js';
import { registerSignatureTool } from '../signature.js';
import { registerCallersTool } from '../callers.js';
import { registerExportsTool } from '../exports.js';
import { registerDependenciesTool } from '../dependencies.js';
import { registerImplementorsTool } from '../implementors.js';
import { registerRenameImpactTool } from '../rename-impact.js';
import { registerProjectSkeletonTool } from '../project-skeleton.js';

type AnyHandler = (args: Record<string, unknown>) => Promise<{ content: [{ text: string }] }>;
type Registrar = (server: McpServer, ctx: AppContext) => void;

const REGISTRARS: Record<string, Registrar> = {
  mast_search: registerSearchTool,
  mast_signature: registerSignatureTool,
  mast_callers: registerCallersTool,
  mast_exports: registerExportsTool,
  mast_dependencies: registerDependenciesTool,
  mast_implementors: registerImplementorsTool,
  mast_rename_impact: registerRenameImpactTool,
  mast_project_skeleton: registerProjectSkeletonTool,
};

/** Every tool that claims its result set is exhaustive, and so warns regardless of hits. */
const EXHAUSTIVE_SET = ['mast_search', 'mast_callers', 'mast_implementors', 'mast_rename_impact', 'mast_project_skeleton'] as const;
/** Every tool that answers about one named thing, and so warns only on a miss. */
const NAMED_LOOKUP = ['mast_signature', 'mast_exports', 'mast_dependencies'] as const;

/** Arguments that FIND something in the fixture below, per tool. */
const HIT: Record<string, Record<string, unknown>> = {
  mast_search: { query: 'addNumbers' },
  mast_signature: { symbol: 'addNumbers' },
  mast_callers: { symbol: 'addNumbers' },
  mast_exports: { file_path: 'math.ts' },
  mast_dependencies: { file_path: 'calc.ts' },
  mast_implementors: { interface_name: 'Shape' },
  mast_rename_impact: { symbol: 'addNumbers', new_name: 'sumNumbers' },
  mast_project_skeleton: {},
};

/** Arguments that find NOTHING — the "it isn't there" answer this signal guards. */
const MISS: Record<string, Record<string, unknown>> = {
  mast_search: { query: 'zzzNoSuchSymbolAnywhere' },
  mast_signature: { symbol: 'zzzNoSuchSymbolAnywhere' },
  mast_callers: { symbol: 'zzzNoSuchSymbolAnywhere' },
  mast_exports: { file_path: 'zzz-no-such-file.ts' },
  mast_dependencies: { file_path: 'zzz-no-such-file.ts' },
  mast_implementors: { interface_name: 'ZzzNoSuchInterface' },
  mast_rename_impact: { symbol: 'zzzNoSuchSymbolAnywhere', new_name: 'other' },
  mast_project_skeleton: { directory: 'zzz-no-such-dir' },
};

function stubProbe(value: number | null): FreshnessProbe {
  return { peekUnindexed: () => value, invalidate: () => {}, refresh: () => {}, settled: () => Promise.resolve() };
}

describe('unindexed_files — the partial-index warning across every result-set tool', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;
  let baseCtx: AppContext;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-unindexed-signal-'));
    writeFileSync(join(tmpDir, 'math.ts'), 'export function addNumbers(a: number, b: number): number { return a + b; }\n');
    writeFileSync(join(tmpDir, 'calc.ts'), "import { addNumbers } from './math';\nexport const total = addNumbers(1, 2);\n");
    writeFileSync(join(tmpDir, 'models.ts'), 'export interface Shape { area(): number; }\nexport class Circle implements Shape { area(): number { return 1; } }\n');
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
    baseCtx = { db, chunkStore: new SqliteChunkStore(db), config, sessionId: 'test' };
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function callTool(tool: string, args: Record<string, unknown>, probe: FreshnessProbe | undefined): Promise<Record<string, unknown>> {
    const handlers = new Map<string, AnyHandler>();
    const server = {
      tool(name: string, _d: string, _s: unknown, handler: AnyHandler) { handlers.set(name, handler); },
    } as unknown as McpServer;
    REGISTRARS[tool]!(server, { ...baseCtx, ...(probe !== undefined ? { freshness: probe } : {}) });
    return handlers.get(tool)!(args).then((r) => JSON.parse(r.content[0].text) as Record<string, unknown>);
  }

  /**
   * Guards the whole file. Every assertion below is about a tool that found
   * something or found nothing; if a HIT stopped hitting or a MISS started
   * hitting, the matrix would keep passing while testing the opposite case.
   * `resultCount` reads whichever primary array the tool actually returns.
   */
  function resultCount(tool: string, res: Record<string, unknown>): number {
    // `potential_matches` counts: without a `mast index --checker` pass
    // `mast_callers` resolves nothing, so a real hit on this fixture is two
    // potential matches and zero verified ones. Omitting it made the HIT case
    // for `mast_callers` silently assert the empty case instead.
    const arrays = ['results', 'exports', 'imports', 'files', 'verified_callers',
                    'potential_matches', 'declaration_sites', 'barrel_exports'];
    // A response carrying NONE of these keys would count 0 and make every MISS
    // assertion below pass without testing anything — the vacuous pass this
    // guard exists to prevent, reintroduced one level up. The HIT case would
    // catch it, but only as a bare `0 is not > 0` naming no cause, so fail here
    // with the tool that returned an unrecognised shape.
    const present = arrays.filter((k) => Array.isArray(res[k]));
    if (present.length === 0) {
      throw new Error(
        `${tool} returned none of the known result arrays (${arrays.join(', ')}) — ` +
          `got keys [${Object.keys(res).join(', ')}]. Add its array to resultCount, ` +
          `or every MISS assertion for it is passing on an empty count it never read.`,
      );
    }
    // Narrowed to the only property this uses. The element shapes differ across
    // the eight tools and are irrelevant here — the question is just "did it
    // return anything?".
    return present.reduce((n, k) => n + (res[k] as { length: number }).length, 0);
  }

  it.each([...EXHAUSTIVE_SET, ...NAMED_LOOKUP])('fixture check: %s HIT actually finds something', async (tool) => {
    expect(resultCount(tool, await callTool(tool, HIT[tool]!, stubProbe(0)))).toBeGreaterThan(0);
  });

  it.each([...EXHAUSTIVE_SET, ...NAMED_LOOKUP])('fixture check: %s MISS actually finds nothing', async (tool) => {
    expect(resultCount(tool, await callTool(tool, MISS[tool]!, stubProbe(0)))).toBe(0);
  });

  // -- the S0 itself: an empty answer over an incomplete corpus ---------------

  it.each([...EXHAUSTIVE_SET, ...NAMED_LOOKUP])(
    '%s warns when it finds nothing and the index is behind',
    async (tool) => {
      const res = await callTool(tool, MISS[tool]!, stubProbe(12));

      expect(res['unindexed_files'], `${tool} answered "not found" over a corpus missing 12 files, silently`).toBe(12);
    },
  );

  // -- the policy split ------------------------------------------------------

  it.each(EXHAUSTIVE_SET)('%s warns even when it DID find results, because it claims exhaustiveness', async (tool) => {
    const res = await callTool(tool, HIT[tool]!, stubProbe(12));

    expect(res['unindexed_files']).toBe(12);
  });

  it.each(NAMED_LOOKUP)('%s stays quiet when it found what was asked for', async (tool) => {
    const res = await callTool(tool, HIT[tool]!, stubProbe(12));

    expect(res).not.toHaveProperty('unindexed_files');
  });

  // -- absence must never be a claim of cleanliness --------------------------

  it.each([...EXHAUSTIVE_SET, ...NAMED_LOOKUP])('%s omits the field when the index is complete', async (tool) => {
    const res = await callTool(tool, MISS[tool]!, stubProbe(0));

    expect(res).not.toHaveProperty('unindexed_files');
  });

  it.each([...EXHAUSTIVE_SET, ...NAMED_LOOKUP])(
    '%s omits the field when freshness is unknown, rather than claiming zero',
    async (tool) => {
      const res = await callTool(tool, MISS[tool]!, stubProbe(null));

      expect(res).not.toHaveProperty('unindexed_files');
    },
  );

  it.each([...EXHAUSTIVE_SET, ...NAMED_LOOKUP])('%s works with no probe wired, as on the CLI path', async (tool) => {
    const res = await callTool(tool, MISS[tool]!, undefined);

    expect(res).not.toHaveProperty('unindexed_files');
  });
});
