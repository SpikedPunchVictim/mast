import { extname } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { parseSource } from './parser.js';
import type { LanguageExtractor, FileExtraction } from './extractor.js';
import { TypeScriptExtractor, extractSignatures, type ExtractedSignature } from './extractors/typescript.js';
import { MarkdownExtractor } from './extractors/markdown.js';

export type { ExtractedSignature } from './extractors/typescript.js';

// ---------------------------------------------------------------------------
// Extractor registry
// ---------------------------------------------------------------------------

// Adding a language = adding one entry here. Each extractor owns its full
// extraction story (parsing included) behind the LanguageExtractor contract,
// so the pipeline never branches on language.
const EXTRACTORS: readonly LanguageExtractor[] = [new TypeScriptExtractor(), new MarkdownExtractor()];

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

export type ExtractResult = FileExtraction;

/**
 * Extract chunks, symbols, imports, edges, and identifier rows from a single
 * file, dispatching to the registered extractor for its extension.
 *
 * Throws if the file cannot be read. On parse errors the caller should catch
 * and log at `warn` level per §7.1 (never abort the full run).
 */
export function extractFile(
  filePath: string,
  projectRoot: string,
  contextLines: number,
  chunkSplitThreshold: number,
  markdownHeadingDepth = 2,
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

  return extractor.extract(src, relativePath, mtime, {
    projectRoot,
    contextLines,
    chunkSplitThreshold,
    markdownHeadingDepth,
  });
}

/**
 * Extract body-free signatures (with params + return type) for every symbol in
 * a file. Used by `mast_signature` and `mast_exports` at query time so they
 * report declarations, not function bodies (§10.2). Returns `[]` for
 * unsupported extensions or on parse failure.
 *
 * Deliberately TypeScript-only: signatures are a code concept, and doc chunks
 * have none — a non-TS extension takes the same `[]` path as an unsupported one.
 */
export function extractFileSignatures(absPath: string): readonly ExtractedSignature[] {
  const extension = extname(absPath);
  if (!(EXT_TO_EXTRACTOR.get(extension) instanceof TypeScriptExtractor)) return [];
  try {
    const src = readFileSync(absPath, 'utf-8');
    const tree = parseSource(src, extension);
    return extractSignatures(tree, src);
  } catch {
    return [];
  }
}
