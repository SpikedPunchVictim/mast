import { extname } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { LanguageExtractor } from './parser.js';
import { parseSource } from './parser.js';
import { TypeScriptExtractor, symbolsFromChunks, extractImports, extractEdges, extractSignatures, type ExtractedSignature } from './extractors/typescript.js';
import { getImportResolver } from '../indexer/import-resolver.js';

export type { ExtractedSignature } from './extractors/typescript.js';
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
  // Resolve each import specifier to a real indexed file (§13.7): relative
  // probing, tsconfig aliases, workspace packages, symlink realpath.
  const resolver = getImportResolver(projectRoot);
  const imports = extractImports(tree, relativePath).map((imp) => {
    const r = resolver.resolve(imp.module, relativePath);
    return { module: imp.module, symbols: imp.symbols, isExternal: r.isExternal, resolvedPath: r.resolvedPath };
  });
  const edges = extractEdges(tree, relativePath, src);

  return { chunks, language, symbols, imports, edges };
}

/**
 * Extract body-free signatures (with params + return type) for every symbol in
 * a file. Used by `mast_signature` and `mast_exports` at query time so they
 * report declarations, not function bodies (§10.2). Returns `[]` for
 * unsupported extensions or on parse failure.
 */
export function extractFileSignatures(absPath: string): readonly ExtractedSignature[] {
  const extension = extname(absPath);
  if (!EXT_TO_EXTRACTOR.has(extension)) return [];
  try {
    const src = readFileSync(absPath, 'utf-8');
    const tree = parseSource(src, extension);
    return extractSignatures(tree, src);
  } catch {
    return [];
  }
}
