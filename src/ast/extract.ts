import { extname } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { parseSource } from './parser.js';
import type { LanguageExtractor, FileExtraction, IdentifierRow } from './extractor.js';
import type { Chunk } from './types.js';
import { TypeScriptExtractor, extractSignatures, sha256, type ExtractedSignature } from './extractors/typescript.js';
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

  const extraction = extractor.extract(src, relativePath, mtime, {
    projectRoot,
    contextLines,
    chunkSplitThreshold,
    markdownHeadingDepth,
  });

  // Collision guard (GITNEXUS_COMPARISON.md §15.3): genuine same-line
  // siblings — multiple real declarations sharing one physical line (e.g.
  // several methods on one line), or generated/minified files where every
  // top-level statement shares start_line — produce identical chunk_ids
  // under the position-based `sha256(file:start_line)` scheme. Applied here,
  // the one dispatch chokepoint, so every extractor (typescript, markdown) is
  // covered without scattering disambiguation through individual chunkId
  // call sites. The first chunk at a given id is left unchanged, so the
  // ~99.97% of files with no collision see zero id churn.
  const chunks = dedupeChunkIds(extraction.chunks);
  // Re-key BEFORE dropping empties: the re-keying is positional, and filtering
  // first is what destroys the position (D040).
  const identifierRows = remapIdentifierRows(extraction.chunks, chunks, extraction.identifierRows)
    .filter((row) => row.identifiers.length > 0);

  return { ...extraction, chunks, identifierRows };
}

/**
 * Disambiguate `chunk_id` collisions within one file's chunk list. The first
 * chunk seen for a given id keeps it; the 2nd+ occurrence gets a namespaced
 * ordinal suffix, assigned in stable source order so two runs over identical
 * input produce identical ids (§7.1 determinism).
 *
 * The preimage is `${file_path}:${start_line}#dup:${n}` — NOT the raw
 * `file:start:n` — because that would collide with the existing sub-chunk id
 * scheme `sha256(file:startLine:subIndex)` (typescript.ts, `pushChunks`).
 * `#dup` namespaces the two preimage families apart. Content-hash ids were
 * rejected: they would break the documented "a content edit keeps the same
 * chunk_id" contract that `vectorKey` (embedder.ts) and `isFileUnchanged`
 * (indexer/index.ts) depend on. A `(file, start, end, type)` composite was
 * also rejected — it still collides when multiple same-type siblings share
 * one line (see lab3.ts in GITNEXUS_COMPARISON.md §15.3).
 */
export function dedupeChunkIds(chunks: readonly Chunk[]): readonly Chunk[] {
  const occurrences = new Map<string, number>();
  return chunks.map((chunk) => {
    const occurrence = occurrences.get(chunk.chunk_id) ?? 0;
    occurrences.set(chunk.chunk_id, occurrence + 1);
    if (occurrence === 0) return chunk;
    return { ...chunk, chunk_id: sha256(`${chunk.file_path}:${chunk.start_line}#dup:${occurrence}`) };
  });
}

/**
 * Re-key `identifierRows` (produced by the extractor against pre-dedup
 * `chunk_id`s) to the post-dedup ids from `dedupeChunkIds`, so
 * `identifier_fts` rows stay attributable to the right chunk.
 *
 * **Positional**, not keyed by `chunk_id` — which is exactly the point. Before
 * dedup a `chunk_id` does NOT identify a chunk uniquely (that is what dedup is
 * for), so a row carrying a colliding id names a *group*, not a member. The
 * previous implementation resolved that ambiguity with a per-id FIFO and was
 * exact only while every chunk in a group also produced a row — an invariant
 * stated in this comment and enforced by nothing. It held in practice (measured:
 * zero violations over n8n at its pinned SHA, 19,056 files / 4 collision groups,
 * and mast's own src, 130 files), but it rested on an argument about identifier
 * emission inside a 1,637-line extractor rather than on anything a compiler or a
 * test could see. `FileExtraction.identifierRows` now carries one row per chunk,
 * so the correspondence is total and this function is a zip (D040).
 *
 * @throws Error if the list is neither empty nor one-per-chunk. That is a broken
 * extractor contract, not a data condition: it is caught per-file by `runIndex`,
 * counted as a parse error, and retried — loudly, rather than writing identifier
 * rows onto the wrong chunk where nothing downstream could detect it.
 */
export function remapIdentifierRows(
  originalChunks: readonly Chunk[],
  dedupedChunks: readonly Chunk[],
  identifierRows: readonly IdentifierRow[],
): readonly IdentifierRow[] {
  if (identifierRows.length === 0) return identifierRows;

  if (identifierRows.length !== originalChunks.length || dedupedChunks.length !== originalChunks.length) {
    throw new Error(
      `identifier row remap requires one identifier row per chunk: got ${identifierRows.length} rows, ` +
      `${originalChunks.length} chunks, ${dedupedChunks.length} deduped chunks`,
    );
  }

  return identifierRows.map((row, i) => {
    const deduped = dedupedChunks[i];
    if (deduped === undefined || deduped.chunk_id === row.chunk_id) return row;
    return { ...row, chunk_id: deduped.chunk_id };
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
