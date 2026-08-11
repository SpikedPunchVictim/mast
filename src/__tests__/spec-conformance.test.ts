import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig, CURRENT_SCHEMA_VERSION } from '../store/config.js';
import { openDatabase } from '../graph/db.js';
import { SqliteChunkStore } from '../store/sqliteChunkStore.js';
import type { AppContext } from '../mcp/context.js';
import { registerAllTools } from '../mcp/register-tools.js';
import { IMMEDIATE_WRITE_BUSY_TIMEOUT_MS } from '../graph/populate.js';
import { TOKENIZER_LABEL, FULL_FILE_TOKENIZE_BUDGET_PER_CALL } from '../telemetry/tokenizer.js';

/**
 * D3 (IMPLEMENTATION_PLAN.md Stage 4) — the testable half of the mechanism
 * from eval/GITNEXUS_COMPARISON.md §14.5 ("Spec drift: quarantine and
 * execute, don't annotate"): hand-maintained per-claim conformance MARKERS
 * rot exactly like the claims they annotate did, because nothing forces them
 * to stay accurate. Making a claim "normative" only means something if it is
 * CITED AND ASSERTED here — every assertion below pairs a targeted extraction
 * from MAST_SPEC.md's own text (read fresh off disk, anchored to a section
 * phrase rather than a line number, since line numbers rot on every edit and
 * section anchors don't) with the corresponding code constant or behavior,
 * so the test goes red the moment EITHER side drifts from the other. This
 * file grows by exactly one assertion per future spec-conformance finding —
 * it does not get reorganized or "cleaned up" independent of that.
 *
 * **Deliberately NOT covered**: runtime-timing claims (the §9.0 "10–50ms" JIT
 * re-parse figure, §7.4's cold-start "2–4 seconds" / step time budgets). A
 * timing assertion in CI is a flake machine — real durations vary with
 * machine load, disk cache state, and CI runner class in ways no fixed
 * threshold survives. Those figures stay descriptive prose, verified by the
 * eval/ measurement harness (E7/E7-r2, D6), not by this suite.
 *
 * **Extraction failure is a failure, never a silent skip** — if an anchor
 * phrase can't be found (the spec section was reworded), the assertion
 * throws naming the missing anchor instead of quietly passing on `undefined`.
 */

const TEST_FILE_URL = import.meta.url;
const SELF_PATH = fileURLToPath(TEST_FILE_URL);
const SRC_ROOT = join(dirname(SELF_PATH), '..');
const PACKAGE_ROOT = join(SRC_ROOT, '..');
const SPEC_PATH = join(PACKAGE_ROOT, 'MAST_SPEC.md');

function readSpec(): string {
  return readFileSync(SPEC_PATH, 'utf8');
}

/**
 * Returns the `windowChars`-long slice of `spec` starting at `anchor`, or
 * throws naming the missing anchor. Every extraction below anchors on a
 * distinctive phrase rather than a line number so the assertion survives
 * unrelated edits elsewhere in the spec.
 */
function windowAfter(spec: string, anchor: string, windowChars = 400): string {
  const idx = spec.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      `MAST_SPEC.md anchor not found: ${JSON.stringify(anchor)} — the spec text ` +
        `this assertion depends on has moved or been reworded; update the anchor.`,
    );
  }
  return spec.slice(idx, idx + windowChars);
}

/** Extracts the first regex capture group as a number from the window after `anchor`. */
function extractNumber(spec: string, anchor: string, pattern: RegExp, windowChars = 400): number {
  const window = windowAfter(spec, anchor, windowChars);
  const match = pattern.exec(window);
  if (match?.[1] === undefined) {
    throw new Error(
      `MAST_SPEC.md anchor ${JSON.stringify(anchor)} found, but value pattern ${String(pattern)} ` +
        `did not match the text after it: ${JSON.stringify(window.slice(0, 150))}`,
    );
  }
  return Number(match[1].replace(/_/g, ''));
}

/** Extracts and `JSON.parse`s the first ```json fenced block found after `anchor`. */
function extractFencedJson(spec: string, anchor: string): unknown {
  const anchorIdx = spec.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(`MAST_SPEC.md anchor not found: ${JSON.stringify(anchor)}`);
  }
  const fenceStart = spec.indexOf('```json', anchorIdx);
  if (fenceStart === -1) {
    throw new Error(`MAST_SPEC.md: no \`\`\`json fence found after anchor ${JSON.stringify(anchor)}`);
  }
  const bodyStart = spec.indexOf('\n', fenceStart) + 1;
  const fenceEnd = spec.indexOf('```', bodyStart);
  if (fenceEnd === -1) {
    throw new Error(`MAST_SPEC.md: unterminated \`\`\`json fence after anchor ${JSON.stringify(anchor)}`);
  }
  return JSON.parse(spec.slice(bodyStart, fenceEnd)) as unknown;
}

/** Extracts a plain (non-json) fenced block's trimmed text found after `anchor`. */
function extractFencedText(spec: string, anchor: string): string {
  const anchorIdx = spec.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(`MAST_SPEC.md anchor not found: ${JSON.stringify(anchor)}`);
  }
  const fenceStart = spec.indexOf('```', anchorIdx);
  if (fenceStart === -1) {
    throw new Error(`MAST_SPEC.md: no fenced block found after anchor ${JSON.stringify(anchor)}`);
  }
  const bodyStart = spec.indexOf('\n', fenceStart) + 1;
  const fenceEnd = spec.indexOf('```', bodyStart);
  if (fenceEnd === -1) {
    throw new Error(`MAST_SPEC.md: unterminated fenced block after anchor ${JSON.stringify(anchor)}`);
  }
  return spec.slice(bodyStart, fenceEnd).trim();
}

// Zod schemas (project CLAUDE.md §3.2: validate at the trust boundary — a
// markdown file's embedded JSON example crosses one) for the two fenced
// JSON blocks this file extracts and parses.
const ConfigExampleSchema = z.object({
  state_dir: z.string(),
  project_root: z.string(),
  file_extensions: z.array(z.string()),
  exclude_patterns: z.array(z.string()),
  rrf_k: z.number(),
  declaration_exact_ranker: z.boolean(),
  chunk_split_threshold: z.number(),
  context_lines: z.number(),
  markdown_heading_depth: z.number(),
});

const IndexJsonExampleSchema = z.object({
  schema_version: z.string(),
  last_indexed: z.string(),
  file_count: z.number(),
  chunk_count: z.number(),
});

describe('spec conformance — MAST_SPEC.md ↔ src/', () => {
  describe('§4.1 mast.config.json example ↔ store/config.ts DEFAULTS', () => {
    // resolveConfig() against a fresh project root with no mast.config.json,
    // no persisted <state_dir>/config.json, and no CLI overrides resolves to
    // exactly DEFAULTS for every customisation key (§4's priority chain) —
    // this is the single source of truth for "the defaults", read through
    // the real resolution path rather than re-declared here (a re-declared
    // expectation would drift independently of DEFAULTS the same way the
    // spec's own copy did).
    let defaults: ReturnType<typeof resolveConfig>;
    let example: z.infer<typeof ConfigExampleSchema>;
    let tmpProjectRoot: string;

    beforeAll(() => {
      tmpProjectRoot = mkdtempSync(join(tmpdir(), 'mast-spec-conformance-defaults-'));
      defaults = resolveConfig({ projectRoot: tmpProjectRoot, stateDirOverride: join(tmpProjectRoot, '.mast') });
      example = ConfigExampleSchema.parse(extractFencedJson(readSpec(), '### 4.1 `mast.config.json`'));
    });

    afterAll(() => {
      rmSync(tmpProjectRoot, { recursive: true, force: true });
    });

    it('rrf_k matches', () => {
      expect(example.rrf_k).toBe(defaults.rrf_k);
      expect(example.rrf_k).toBe(60);
    });

    it('chunk_split_threshold matches', () => {
      expect(example.chunk_split_threshold).toBe(defaults.chunk_split_threshold);
      expect(example.chunk_split_threshold).toBe(100);
    });

    it('context_lines matches', () => {
      expect(example.context_lines).toBe(defaults.context_lines);
      expect(example.context_lines).toBe(3);
    });

    it('markdown_heading_depth matches', () => {
      expect(example.markdown_heading_depth).toBe(defaults.markdown_heading_depth);
      expect(example.markdown_heading_depth).toBe(2);
    });

    it('declaration_exact_ranker matches', () => {
      expect(example.declaration_exact_ranker).toBe(defaults.declaration_exact_ranker);
      expect(example.declaration_exact_ranker).toBe(true);
    });

    it('file_extensions matches', () => {
      expect(example.file_extensions).toEqual(defaults.file_extensions);
    });

    it('exclude_patterns matches', () => {
      expect(example.exclude_patterns).toEqual(defaults.exclude_patterns);
    });
  });

  it('§8 `mast init --state-dir` documented default ↔ store/config.ts DEFAULTS.state_dir', () => {
    const spec = readSpec();
    const window = windowAfter(spec, 'Where to write index state (default: <path>');
    const match = /<path>(\/[.\w-]+)\)/.exec(window);
    if (match?.[1] === undefined) {
      throw new Error(`MAST_SPEC.md: could not parse the documented state-dir default near "Where to write index state" — window: ${JSON.stringify(window.slice(0, 120))}`);
    }
    // Strip the leading path separator the doc renders as `<path>/.mast` to
    // compare against the bare `.mast` DEFAULTS carries.
    const documentedDefault = match[1].replace(/^\//, '');

    const tmpProjectRoot = mkdtempSync(join(tmpdir(), 'mast-spec-conformance-statedir-'));
    try {
      const defaults = resolveConfig({ projectRoot: tmpProjectRoot });
      expect(documentedDefault).toBe(defaults.state_dir);
      expect(documentedDefault).toBe('.mast');
    } finally {
      rmSync(tmpProjectRoot, { recursive: true, force: true });
    }
  });

  it('§5 index.json example schema_version ↔ store/config.ts CURRENT_SCHEMA_VERSION', () => {
    const example = IndexJsonExampleSchema.parse(extractFencedJson(readSpec(), '`index.json` example:'));
    expect(example.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  // D8 (IMPLEMENTATION_PLAN.md "D8 result"): §9's documented `mast_status`
  // response advertises the running binary's schema version as an operator's
  // only in-product signal that a long-lived server is executing a stale build
  // against a since-migrated state dir. A spec example that drifts from the
  // constant would make the one field that exists to expose staleness itself
  // misleading — so it is pinned here, exactly as §5's index.json example is.
  it('§9 mast_status output example schema_version ↔ CURRENT_SCHEMA_VERSION', () => {
    const example = extractFencedJson(readSpec(), '**Output:** `StatusResult`') as {
      schema_version: string;
    };
    expect(example.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("§7.4 Step 3's constant prose (\"currently `\\\"1.3.0\\\"`\") ↔ CURRENT_SCHEMA_VERSION", () => {
    const spec = readSpec();
    const window = windowAfter(spec, '`CURRENT_SCHEMA_VERSION` is a constant in the mast binary (currently');
    const match = /currently `"([\d.]+)"`/.exec(window);
    if (match?.[1] === undefined) {
      throw new Error(`MAST_SPEC.md: could not parse the "currently ..." schema-version literal — window: ${JSON.stringify(window.slice(0, 150))}`);
    }
    expect(match[1]).toBe(CURRENT_SCHEMA_VERSION);
  });

  describe("§7.4 Step 3's registered-tool enumeration ↔ registerAllTools' actual registrations", () => {
    // Capture-server trick (cli/query.ts's `createCaptureServer`, and
    // `mcp/tools/__tests__/tools.test.ts`'s `createMockServer`): a
    // structural `{ tool(name, description, schemaShape, handler) }` stand-in
    // records every registered tool's name without opening a real MCP
    // transport. `registerAllTools` never dereferences `ctx` during
    // registration itself (only inside each tool's async handler closure,
    // which this test never invokes), but a real `AppContext` is built here
    // anyway — a fresh, empty on-disk database — so this test never depends
    // on that "registration doesn't touch ctx" assumption staying true.
    let registeredToolNames: string[];
    let tmpProjectRoot: string;
    let db: ReturnType<typeof openDatabase>;

    beforeAll(() => {
      tmpProjectRoot = mkdtempSync(join(tmpdir(), 'mast-spec-conformance-tools-'));
      const config = resolveConfig({ projectRoot: tmpProjectRoot });
      mkdirSync(config.resolved_state_dir, { recursive: true });
      db = openDatabase(config.resolved_state_dir);
      const ctx: AppContext = {
        db,
        chunkStore: new SqliteChunkStore(db),
        config,
        sessionId: 'spec-conformance-test-session',
      };

      const tools = new Map<string, unknown>();
      const captureServer = {
        tool(name: string, _description: string, _schemaShape: unknown, _handler: unknown): void {
          tools.set(name, _handler);
        },
      };
      registerAllTools(captureServer as unknown as McpServer, ctx);
      registeredToolNames = [...tools.keys()].sort();
    });

    afterAll(async () => {
      await db.destroy();
      rmSync(tmpProjectRoot, { recursive: true, force: true });
    });

    it('registers exactly 11 tools, matching the spec\'s "all 11 tools" claim', () => {
      expect(registeredToolNames.length).toBe(11);
    });

    it('the registered tool names match the spec\'s enumerated list exactly', () => {
      const spec = readSpec();
      const anchor = 'register all 11 tools (';
      const anchorIdx = spec.indexOf(anchor);
      if (anchorIdx === -1) {
        throw new Error(`MAST_SPEC.md anchor not found: ${JSON.stringify(anchor)}`);
      }
      const listStart = anchorIdx + anchor.length;
      const listEnd = spec.indexOf(')', listStart);
      if (listEnd === -1) {
        throw new Error('MAST_SPEC.md: unterminated tool list after "register all 11 tools ("');
      }
      // The list spans several lines of the startup-ladder box-drawing
      // diagram (each continuation line prefixed with "│    │  "); strip
      // everything but word characters from each comma-separated entry
      // rather than trying to match the diagram's exact whitespace/pipe
      // layout.
      const names = spec
        .slice(listStart, listEnd)
        .split(',')
        .map((raw) => raw.replace(/[^a-zA-Z0-9_]/g, ''))
        .filter((name) => name.length > 0)
        .sort();

      expect(names).toEqual(registeredToolNames);
    });
  });

  it('§7.6 dedicated JIT-write busy_timeout (200ms) ↔ IMMEDIATE_WRITE_BUSY_TIMEOUT_MS', () => {
    const spec = readSpec();
    const documented = extractNumber(spec, 'dedicated, short `busy_timeout` of', /(\d+)ms/);
    expect(documented).toBe(IMMEDIATE_WRITE_BUSY_TIMEOUT_MS);
    expect(documented).toBe(200);
  });

  it('§7.6 proper-lockfile stale threshold (10 seconds / 10000ms) ↔ store/lock.ts STALE_MS', () => {
    const spec = readSpec();
    const documented = extractNumber(spec, 'Always pass `{ stale:', /stale:\s*(\d+)/);
    expect(documented).toBe(10_000);

    // STALE_MS is not exported from store/lock.ts (its only consumer is the
    // module's own acquireLock) — reading the source constant's declared
    // value directly, the same "extract a literal from source text" technique
    // used against MAST_SPEC.md above, avoids widening lock.ts's public API
    // just to make this one value test-visible.
    const lockSource = readFileSync(join(SRC_ROOT, 'store', 'lock.ts'), 'utf8');
    const codeMatch = /const STALE_MS = ([\d_]+);/.exec(lockSource);
    if (codeMatch?.[1] === undefined) {
      throw new Error('store/lock.ts: could not find "const STALE_MS = <value>;" — has the declaration changed shape?');
    }
    const actual = Number(codeMatch[1].replace(/_/g, ''));
    expect(documented).toBe(actual);
  });

  it("§9 mast_callers/mast_rename_impact potential-match cap (50) ↔ collectPotentialMatchCandidates' default limit", () => {
    const spec = readSpec();
    const documented = extractNumber(
      spec,
      'The `identifier_fts` fetch behind `potential_matches` is capped at',
      /capped at (\d+) entries/,
    );
    expect(documented).toBe(50);

    // collectPotentialMatchCandidates' cap is a default parameter value, not
    // a named exported constant — read the declared default straight out of
    // the source, same technique as the STALE_MS assertion above.
    const potentialMatchesSource = readFileSync(join(SRC_ROOT, 'search', 'potential-matches.ts'), 'utf8');
    const codeMatch = /export async function collectPotentialMatchCandidates\([\s\S]*?limit\s*=\s*(\d+)/.exec(
      potentialMatchesSource,
    );
    if (codeMatch?.[1] === undefined) {
      throw new Error(
        'search/potential-matches.ts: could not find collectPotentialMatchCandidates\' default `limit` parameter — has the signature changed shape?',
      );
    }
    expect(documented).toBe(Number(codeMatch[1]));
  });

  it('§14.2 per-call tokenize budget (32) ↔ FULL_FILE_TOKENIZE_BUDGET_PER_CALL', () => {
    const spec = readSpec();
    const documented = extractNumber(spec, 'FULL_FILE_TOKENIZE_BUDGET_PER_CALL = ', /(\d+)/);
    expect(documented).toBe(FULL_FILE_TOKENIZE_BUDGET_PER_CALL);
    expect(documented).toBe(32);
  });

  it('§14.5 tokenizer label ↔ TOKENIZER_LABEL', () => {
    const spec = readSpec();
    const documented = extractFencedText(spec, 'The active tokenizer is reported verbatim');
    expect(documented).toBe(TOKENIZER_LABEL);
  });
});
