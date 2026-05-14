import { createRequire } from 'node:module';
import type { Chunk } from './types.js';

// tree-sitter v0.21 ships a CJS-only native addon.
// createRequire is required to load it from an ESM module context.
const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const Parser = require('tree-sitter');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { typescript: tsGrammar, tsx: tsxGrammar } = require('tree-sitter-typescript');

export type { Tree, SyntaxNode } from 'tree-sitter';

// Re-export the raw Parser class for extractors that need direct access.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
export const TreeSitterParser: any = Parser;
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
export const TypeScriptGrammar: any = tsGrammar;
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
export const TsxGrammar: any = tsxGrammar;

/**
 * Contract every language extractor must satisfy.
 *
 * `extractChunks` is the primary entry point called by the indexer.
 * `declarationHash` and `bodyHash` produce stable sha256 fingerprints used
 * for incremental reindex optimisation (§7.1 stability hash rule).
 */
export interface LanguageExtractor {
  /** Language identifier written into each chunk's `language` field. */
  readonly language: string;
  /** File extensions this extractor handles (e.g. `['.ts', '.tsx']`). */
  readonly extensions: readonly string[];
  /**
   * Parse `src` and extract all chunks. Called once per file per index run.
   * @param parsedTree - Pre-parsed tree-sitter Tree for `src`.
   * @param src - Raw UTF-8 source text.
   * @param filePath - Relative path to project root, used in chunk IDs.
   * @param fileMtime - File modification time at index time.
   * @param contextLines - Lines of context to expand around each AST boundary.
   * @param chunkSplitThreshold - Line count above which a declaration is split into overlapping sub-chunks.
   */
  extractChunks(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parsedTree: any,
    src: string,
    filePath: string,
    fileMtime: number,
    contextLines: number,
    chunkSplitThreshold: number,
  ): Chunk[];
  /** sha256 of the declaration's signature text (body excluded). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declarationHash(node: any, src: string): string;
  /** sha256 of the declaration's body text (signature excluded). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bodyHash(node: any, src: string): string;
}

/**
 * Parse a source file with tree-sitter.
 * Returns the raw tree object (typed as `any` because tree-sitter v0.21
 * ships no TypeScript declarations for its return types).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseSource(src: string, extension: string): any {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
  const parser = new Parser();
  const grammar = extension === '.tsx' ? TsxGrammar : TypeScriptGrammar;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  parser.setLanguage(grammar);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return parser.parse(src);
}
