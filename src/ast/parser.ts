import { createRequire } from 'node:module';
import type { Tree, SyntaxNode } from 'tree-sitter';
import type { Chunk } from './types.js';

// tree-sitter ships a CJS-only native addon; createRequire loads it from ESM.
const require = createRequire(import.meta.url);

// `tree-sitter` ships its own TypeScript declarations (Tree, SyntaxNode, …), so
// the Parser class is fully typed. The grammar package `tree-sitter-typescript`
// ships no declarations. Derive the Language type from setLanguage's own
// parameter rather than importing Parser.Language directly — ESM + `export =`
// does not allow that namespace member import.
const Parser = require('tree-sitter') as typeof import('tree-sitter');
type Language = NonNullable<Parameters<InstanceType<typeof Parser>['setLanguage']>[0]>;
const { typescript: tsGrammar, tsx: tsxGrammar } = require('tree-sitter-typescript') as {
  typescript: Language;
  tsx: Language;
};

export type { Tree, SyntaxNode } from 'tree-sitter';

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
    parsedTree: Tree,
    src: string,
    filePath: string,
    fileMtime: number,
    contextLines: number,
    chunkSplitThreshold: number,
  ): Chunk[];
  /** sha256 of the declaration's signature text (body excluded). */
  declarationHash(node: SyntaxNode, src: string): string;
  /** sha256 of the declaration's body text (signature excluded). */
  bodyHash(node: SyntaxNode, src: string): string;
}

/** Parse a source file with tree-sitter, returning the syntax tree. */
export function parseSource(src: string, extension: string): Tree {
  const parser = new Parser();
  // setLanguage accepts an opaque native grammar object (typed `any` upstream).
  parser.setLanguage(extension === '.tsx' ? tsxGrammar : tsGrammar);
  return parser.parse(src);
}
