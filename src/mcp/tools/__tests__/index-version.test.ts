// D138: nothing that read the index looked at the version it was built with.
// A read tool answered from rows another schema version wrote, and
// `mast_status` printed this binary's version over them with `index_fresh: true`.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig, CURRENT_SCHEMA_VERSION, type ResolvedConfig } from '../../../store/config.js';
import { runIndex } from '../../../indexer/index.js';
import { openDatabase } from '../../../graph/db.js';
import { SqliteChunkStore } from '../../../store/sqliteChunkStore.js';
import { registerAllTools } from '../../register-tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

/**
 * Arguments for every tool that answers from the stored rows. A tool missing
 * from here and from `NOT_A_READ` fails the first test below, so a new tool
 * cannot be registered without deciding which of the two it is.
 */
const READ_TOOLS: Readonly<Record<string, Record<string, unknown>>> = {
  mast_search: { query: 'add' },
  mast_project_skeleton: {},
  mast_exports: { file_path: 'math.ts' },
  mast_signature: { symbol: 'add' },
  mast_callers: { symbol: 'add' },
  mast_dependencies: { file_path: 'calc.ts' },
  mast_implementors: { interface_name: 'Shape' },
  mast_rename_impact: { symbol: 'add' },
};

/** `mast_status` reports the version, `mast_reindex` repairs it, `mast_efficiency` reads kept metrics. */
const NOT_A_READ: readonly string[] = ['mast_status', 'mast_reindex', 'mast_efficiency'];

let dir: string;
let config: ResolvedConfig;
let db: ReturnType<typeof openDatabase>;
let builtStamp: string;
const handlers = new Map<string, Handler>();

function stampPath(): string {
  return join(config.resolved_state_dir, 'index.json');
}

/** The stamp another mast would have left: its version over the real counts. */
function stampAs(version: string): void {
  const built = JSON.parse(builtStamp) as Record<string, unknown>;
  writeFileSync(stampPath(), JSON.stringify({ ...built, schema_version: version }));
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`tool ${name} is not registered`);
  const result = await handler(args);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mast-index-version-'));
  writeFileSync(join(dir, 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
  writeFileSync(join(dir, 'calc.ts'), "import { add } from './math';\nexport const three = add(1, 2);\n");
  config = resolveConfig({ projectRoot: dir });
  await runIndex(config, { incremental: false });
  builtStamp = readFileSync(stampPath(), 'utf8');

  db = openDatabase(config.resolved_state_dir);
  const server = {
    tool(name: string, _d: string, _s: unknown, handler: Handler) { handlers.set(name, handler); },
  } as unknown as McpServer;
  registerAllTools(server, { db, chunkStore: new SqliteChunkStore(db), config, sessionId: 'index-version-test' });
});

afterAll(async () => {
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe('a read tool over an index another schema version built', () => {
  it('has a decision recorded for every registered tool', () => {
    expect([...handlers.keys()].sort()).toEqual([...Object.keys(READ_TOOLS), ...NOT_A_READ].sort());
  });

  it.each(Object.entries(READ_TOOLS))('%s answers when the index is this version\'s', async (name, args) => {
    writeFileSync(stampPath(), builtStamp);

    await expect(call(name, args)).resolves.toBeDefined();
  });

  it.each(Object.entries(READ_TOOLS))('%s refuses an older index, naming both versions and the fix', async (name, args) => {
    stampAs('1.3.0');

    const refusal = call(name, args);

    await expect(refusal).rejects.toThrow(/schema 1\.3\.0/);
    await expect(refusal).rejects.toThrow(`schema ${CURRENT_SCHEMA_VERSION}`);
    await expect(refusal).rejects.toThrow(/`mast index`/);
  });

  it.each(Object.entries(READ_TOOLS))('%s refuses a newer index, naming both versions', async (name, args) => {
    stampAs('9.9.0');

    const refusal = call(name, args);

    await expect(refusal).rejects.toThrow(/schema 9\.9\.0/);
    await expect(refusal).rejects.toThrow(`schema ${CURRENT_SCHEMA_VERSION}`);
  });

  // The stamp a rebuild leaves while it runs: the old version's name over an
  // index with nothing in it. No row of the old version is left to answer
  // from, and `index_empty` already says what an empty answer means, so a
  // server that is rebuilding at startup keeps answering.
  it('answers while an older index is emptied and waiting for its rebuild', async () => {
    writeFileSync(stampPath(), JSON.stringify({
      schema_version: '1.3.0', last_indexed: null, file_count: 0, chunk_count: 0,
    }));

    await expect(call('mast_search', { query: 'add' })).resolves.toBeDefined();
  });
});

describe('mast_status over an index another schema version built', () => {
  it('reports the version that built the index beside the binary\'s', async () => {
    stampAs('1.3.0');

    const status = await call('mast_status');

    expect(status).toMatchObject({ schema_version: CURRENT_SCHEMA_VERSION, index_schema_version: '1.3.0' });
  });

  it('is not fresh, and gives the version as the cause', async () => {
    stampAs('1.3.0');

    const status = await call('mast_status');

    expect(status).toMatchObject({ index_fresh: false, freshness_cause: 'index_version' });
  });

  it('reports the same version twice and is fresh when they agree', async () => {
    writeFileSync(stampPath(), builtStamp);

    const status = await call('mast_status');

    expect(status).toMatchObject({
      schema_version: CURRENT_SCHEMA_VERSION,
      index_schema_version: CURRENT_SCHEMA_VERSION,
      index_fresh: true,
      freshness_cause: null,
    });
  });

  it('says the stamp could not be read', async () => {
    writeFileSync(stampPath(), '');

    const status = await call('mast_status');

    expect(status).toMatchObject({
      index_schema_version: null, index_fresh: false, freshness_cause: 'stamp_unreadable',
    });
  });
});
