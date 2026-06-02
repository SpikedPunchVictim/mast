import { extname } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { LanguageExtractor } from './parser.js';
import { parseSource } from './parser.js';
import { TypeScriptExtractor, symbolsFromChunks, extractImports, extractEdges } from './extractors/typescript.js';
import type { Chunk, Language, SymbolRecord, ImportRecord, EdgeRecord } from './types.js';

// ---------------------------------------------------------------------------
// Extractor registry
// ---------------------------------------------------------------------------

const EXTRACTORS: readonly LanguageExtractor[] = [new TypeScriptExtractor()];

const EXT_TO_EXTRACTOR = new Map<string, LanguageExtractor>();
for (const ext of EXTRACTORS) {
  for (const extension of ext.extensions) {
    EXT_TO_EXTRACTOR.set(extension, ext);
  }
}

export function supportsExtension(extension: string): boolean {
  return EXT_TO_EXTRACTOR.has(extension);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ExtractResult {
  readonly chunks: readonly Chunk[];
  readonly language: string;
  readonly symbols: readonly SymbolRecord[];
  readonly imports: readonly ImportRecord[];
  readonly edges: readonly EdgeRecord[];
}

/**
 * Parse and extract chunks, symbols, and imports from a single file.
 *
 * Throws if the file cannot be read. On tree-sitter parse errors the caller
 * should catch and log at `warn` level per §7.1 (never abort the full run).
 */
export function extractFile(
  filePath: string,
  projectRoot: string,
  contextLines: number,
  chunkSplitThreshold: number,
): ExtractResult {
  const extension = extname(filePath);
  const extractor = EXT_TO_EXTRACTOR.get(extension);
  if (extractor === undefined) {
    throw new Error(`No extractor registered for extension "${extension}"`);
  }

  const src = readFileSync(filePath, 'utf-8');
  const mtime = statSync(filePath).mtimeMs / 1_000;

  // Relative path for chunk IDs and stored file_path field.
  const relativePath = filePath.startsWith(projectRoot)
    ? filePath.slice(projectRoot.length).replace(/^\//, '')
    : filePath;

  const tree = parseSource(src, extension);
  const rawChunks = extractor.extractChunks(tree, src, relativePath, mtime, contextLines, chunkSplitThreshold);

  // TypeScriptExtractor handles both TS and JS but always reports 'typescript'.
  // Derive the correct language from the file extension so that language filters work.
  const language: Language = (extension === '.js' || extension === '.jsx') ? 'javascript' : 'typescript';
  const chunks: readonly Chunk[] = language === extractor.language
    ? rawChunks
    : rawChunks.map((c) => ({ ...c, language }));

  const symbols = symbolsFromChunks(chunks);
  const imports = extractImports(tree, relativePath);
  const edges = extractEdges(tree, relativePath, src);

  return { chunks, language, symbols, imports, edges };
}
