import type { Chunk, Language, SymbolRecord, ImportRecord, EdgeRecord } from './types.js';

// ---------------------------------------------------------------------------
// Language extractor contract (§13.4)
// ---------------------------------------------------------------------------

/**
 * One `identifier_fts` row: the identifier tokens extracted from a chunk.
 * Produced by the extractor (not the graph layer) because what counts as an
 * "identifier" is a language-level judgment — e.g. markdown prose contributes
 * none, since a doc that merely mentions a symbol name is not a call site.
 */
export interface IdentifierRow {
  readonly chunk_id: string;
  /** Space-separated identifier tokens for the FTS index. */
  readonly identifiers: string;
}

/**
 * Everything the indexing pipeline needs from one source file. Each extractor
 * owns the full story for its language: languages without a symbol graph
 * (markdown) return empty `symbols` / `imports` / `edges` / `identifierRows`
 * and the pipeline needs no per-language branches.
 */
export interface FileExtraction {
  /** Concrete language of THIS file — may differ from the extractor's primary
   *  language (the TypeScript extractor also handles `.js`/`.jsx`). */
  readonly language: Language;
  readonly chunks: readonly Chunk[];
  readonly symbols: readonly SymbolRecord[];
  readonly imports: readonly ImportRecord[];
  readonly edges: readonly EdgeRecord[];
  readonly identifierRows: readonly IdentifierRow[];
}

/** Per-run knobs passed to every extractor; each reads what applies to it. */
export interface ExtractorOptions {
  /** Absolute project root — used for import specifier resolution (§13.7). */
  readonly projectRoot: string;
  /** Source lines expanded around AST boundaries in stored content. */
  readonly contextLines: number;
  /** Lines above which a declaration/section splits into sub-chunks (§10.1). */
  readonly chunkSplitThreshold: number;
  /** Max ATX heading level that starts a markdown doc chunk (§10.1). */
  readonly markdownHeadingDepth: number;
}

/**
 * Contract every language extractor must satisfy.
 *
 * Parsing strategy is the implementer's concern — the TypeScript extractor
 * parses with tree-sitter internally, the markdown extractor line-scans. The
 * pipeline (extract.ts) only dispatches by extension and consumes the
 * `FileExtraction`; it never special-cases a language.
 */
export interface LanguageExtractor {
  /** Primary language identifier for this extractor. */
  readonly language: Language;
  /** File extensions this extractor handles (e.g. `['.ts', '.tsx']`). */
  readonly extensions: readonly string[];
  /**
   * Extract everything the index needs from one file. Called once per file
   * per index run. May throw on unparseable input — the indexer catches and
   * logs per §7.1 (never aborts the full run).
   *
   * @param src - Raw UTF-8 source text.
   * @param filePath - Relative to project root; used in chunk IDs.
   * @param fileMtime - File modification time at index time (unix seconds).
   */
  extract(src: string, filePath: string, fileMtime: number, options: ExtractorOptions): FileExtraction;
}
