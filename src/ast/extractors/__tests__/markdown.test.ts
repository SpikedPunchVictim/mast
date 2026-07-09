import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MarkdownExtractor } from '../markdown.js';
import { extractFile } from '../../extract.js';
import { resolveConfig } from '../../../store/config.js';
import { runIndex } from '../../../indexer/index.js';
import { openDatabase } from '../../../graph/db.js';
import { searchFts } from '../../../search/fts.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOC_SRC = `# MAST Spec

Intro paragraph under the title.

## 1. Overview

Overview text.

### 1.1 Details

Nested details fold into the parent section at default depth.

## 2. Search

Search text.
`;

const PREAMBLE_SRC = `Some text before any heading.

## First Section

Body.
`;

const TITLE_ONLY_SRC = `# Just A Title

Only intro text, no sections.
`;

const FENCED_SRC = `## Real Section

\`\`\`bash
# not a heading — shell comment inside a fence
echo hi
\`\`\`

More text.

## Second Section

Done.
`;

const extractor = new MarkdownExtractor();

/** Convenience wrapper with the defaults used by the indexer. */
function extract(src: string, depth = 2, splitThreshold = 100) {
  return extractor.extractChunks(src, 'doc.md', 1234, splitThreshold, depth);
}

// ---------------------------------------------------------------------------
// MarkdownExtractor — heading-based chunking
// ---------------------------------------------------------------------------

describe('MarkdownExtractor', () => {
  it('declares markdown language and .md extension', () => {
    expect(extractor.language).toBe('markdown');
    expect(extractor.extensions).toContain('.md');
  });

  it('produces one doc chunk per heading section at default depth', () => {
    const chunks = extract(DOC_SRC);
    // Sections: "# MAST Spec" (title + intro), "## 1. Overview" (with folded
    // ### 1.1), "## 2. Search".
    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      expect(c.chunk_type).toBe('doc');
      expect(c.language).toBe('markdown');
      expect(c.is_exported).toBe(false);
      expect(c.parent_symbol).toBeNull();
    }
  });

  it('symbol_name is the heading path prefixed with the file name', () => {
    const chunks = extract(DOC_SRC);
    const names = chunks.map((c) => c.symbol_name);
    expect(names).toContain('doc.md > MAST Spec');
    expect(names).toContain('doc.md > MAST Spec > 1. Overview');
    expect(names).toContain('doc.md > MAST Spec > 2. Search');
  });

  it('headings deeper than the chunk depth fold into their parent section', () => {
    const chunks = extract(DOC_SRC);
    const overview = chunks.find((c) => c.symbol_name?.endsWith('1. Overview'));
    expect(overview).toBeDefined();
    expect(overview!.content).toContain('### 1.1 Details');
    expect(overview!.content).toContain('Nested details');
  });

  it('a larger depth turns deeper headings into their own chunks', () => {
    const chunks = extract(DOC_SRC, 3);
    const names = chunks.map((c) => c.symbol_name);
    expect(names).toContain('doc.md > MAST Spec > 1. Overview > 1.1 Details');
  });

  it('content before the first heading becomes a preamble chunk named after the file', () => {
    const chunks = extract(PREAMBLE_SRC);
    expect(chunks[0]!.symbol_name).toBe('doc.md');
    expect(chunks[0]!.content).toContain('Some text before any heading.');
    expect(chunks[1]!.symbol_name).toBe('doc.md > First Section');
  });

  it('a file with only a # title yields a single chunk', () => {
    const chunks = extract(TITLE_ONLY_SRC);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.symbol_name).toBe('doc.md > Just A Title');
    expect(chunks[0]!.content).toContain('Only intro text');
  });

  it('ignores # lines inside fenced code blocks', () => {
    const chunks = extract(FENCED_SRC);
    expect(chunks).toHaveLength(2);
    const first = chunks.find((c) => c.symbol_name?.endsWith('Real Section'));
    expect(first!.content).toContain('# not a heading');
  });

  it('returns [] for empty or whitespace-only files', () => {
    expect(extract('')).toHaveLength(0);
    expect(extract('   \n\n  ')).toHaveLength(0);
  });

  it('splits oversized sections into overlapping sub-chunks with unique ids', () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
    const src = `## Big Section\n\n${body}\n`;
    const chunks = extract(src, 2, 20);
    expect(chunks.length).toBeGreaterThan(1);
    const ids = new Set(chunks.map((c) => c.chunk_id));
    expect(ids.size).toBe(chunks.length);
    // All sub-chunks keep the section's heading path.
    for (const c of chunks) {
      expect(c.symbol_name).toBe('doc.md > Big Section');
    }
  });

  it('start/end lines are 1-indexed and cover the section', () => {
    const chunks = extract(DOC_SRC);
    expect(chunks[0]!.start_line).toBe(1);
    const last = chunks[chunks.length - 1]!;
    expect(last.end_line).toBe(DOC_SRC.trimEnd().split('\n').length);
  });
});

// ---------------------------------------------------------------------------
// extractFile dispatch — .md flows through without tree-sitter
// ---------------------------------------------------------------------------

describe('extractFile with markdown', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-md-extract-'));
    writeFileSync(join(tmpDir, 'guide.md'), DOC_SRC);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts doc chunks and reports markdown language', () => {
    const result = extractFile(join(tmpDir, 'guide.md'), tmpDir, 3, 100);
    expect(result.language).toBe('markdown');
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.every((c) => c.chunk_type === 'doc')).toBe(true);
  });

  it('produces no graph symbols, imports, or edges', () => {
    const result = extractFile(join(tmpDir, 'guide.md'), tmpDir, 3, 100);
    expect(result.symbols).toHaveLength(0);
    expect(result.imports).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: index a project containing markdown
// ---------------------------------------------------------------------------

describe('indexing markdown files', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-md-index-'));
    writeFileSync(join(tmpDir, 'guide.md'), DOC_SRC);
    writeFileSync(join(tmpDir, 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');

    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('default config includes .md so the file is indexed', async () => {
    const rows = await db.selectFrom('files').select(['path', 'language']).execute();
    const md = rows.find((r) => r.path === 'guide.md');
    expect(md).toBeDefined();
    expect(md!.language).toBe('markdown');
  });

  it('doc sections are searchable via chunk_fts', async () => {
    const hits = await searchFts(db, 'Overview text', { limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('writes no symbols rows for the markdown file', async () => {
    const symbols = await db
      .selectFrom('symbols as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select('s.name')
      .where('f.path', '=', 'guide.md')
      .execute();
    expect(symbols).toHaveLength(0);
  });

  it('writes no identifier_fts rows for doc chunks', async () => {
    const rows = await db
      .selectFrom('identifier_fts')
      .select('chunk_id')
      .where('file_path', '=', 'guide.md')
      .execute();
    expect(rows).toHaveLength(0);
  });
});
