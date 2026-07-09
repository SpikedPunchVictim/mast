import type { Chunk } from '../types.js';
import type { LanguageExtractor, FileExtraction, ExtractorOptions } from '../extractor.js';
import { chunkId, sha256 } from './typescript.js';

// ---------------------------------------------------------------------------
// Markdown extractor — heading-based doc chunking (§10.1)
// ---------------------------------------------------------------------------

/** ATX heading: 1–6 `#` followed by whitespace and the heading text. */
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Fence opener/closer: ``` or ~~~ optionally followed by an info string. */
const FENCE_RE = /^\s{0,3}(```|~~~)/;

interface Section {
  /** 1-indexed line of the section's heading (or 1 for the preamble). */
  readonly startLine: number;
  /** Heading path: `file.md > Ancestor > Own Heading` (file name only for preamble). */
  readonly symbolName: string;
}

/**
 * Heading-based chunker for markdown documents.
 *
 * No parser: a line scan with fence tracking is sufficient and avoids
 * shipping a markdown grammar — parsing strategy is internal to each
 * `LanguageExtractor`. Doc chunks carry no symbol graph: `extract` returns
 * empty `symbols` / `imports` / `edges`, and empty `identifierRows` because
 * `identifier_fts` feeds `mast_callers` potential_matches, where prose that
 * merely mentions a symbol name is noise, not a call site — docs participate
 * in search via chunk_fts + vectors only.
 *
 * Chunking rules (documented in MAST_SPEC.md §10.1):
 * - A new chunk starts at every ATX heading of level ≤ `maxHeadingDepth`;
 *   deeper headings fold into the enclosing section's content.
 * - `symbol_name` is the heading path: file name + every ancestor heading +
 *   the section's own heading, joined with " > ".
 * - Content before the first boundary heading becomes a preamble chunk whose
 *   `symbol_name` is the file name alone.
 * - `#` lines inside fenced code blocks (``` or ~~~) are not headings.
 * - Setext headings (`===` / `---` underlines) are not recognised — this
 *   repo's docs use ATX exclusively, and supporting both complicates the
 *   fence-aware scan for no observed payoff.
 * - Sections longer than `chunkSplitThreshold` lines split into overlapping
 *   sub-chunks using the same window/overlap/ID scheme as code declarations,
 *   so no single doc chunk exceeds the token budget the threshold encodes.
 * - No `context_lines` expansion: sections are self-delimiting, and expansion
 *   would duplicate neighbouring sections' text into every chunk.
 * - Doc chunks carry no `declaration_hash`/`body_hash` — there is no symbol
 *   row to compare against, so the incremental "unchanged file" fast path
 *   conservatively rewrites markdown files instead (see indexer/index.ts).
 */
export class MarkdownExtractor implements LanguageExtractor {
  readonly language = 'markdown';
  readonly extensions: readonly string[] = ['.md'];

  extract(src: string, filePath: string, fileMtime: number, options: ExtractorOptions): FileExtraction {
    const chunks = this.extractChunks(src, filePath, fileMtime, options.chunkSplitThreshold, options.markdownHeadingDepth);
    return { language: 'markdown', chunks, symbols: [], imports: [], edges: [], identifierRows: [] };
  }

  extractChunks(
    src: string,
    filePath: string,
    fileMtime: number,
    chunkSplitThreshold: number,
    maxHeadingDepth: number,
  ): Chunk[] {
    if (src.trim() === '') return [];

    const lines = src.split('\n');
    // Drop a trailing empty element produced by a terminating newline so the
    // last section's end_line matches the real last line of the file.
    if (lines[lines.length - 1] === '') lines.pop();

    const fileName = fileNameOf(filePath);
    const sections: Section[] = [];
    // Last-seen heading text per level (1-indexed); shallower ancestors form
    // the heading path of each new section. Sparse when a document skips
    // levels (e.g. `#` straight to `###`) — holes are filtered from paths.
    const headingStack: (string | undefined)[] = [];
    let inFence = false;
    let fenceMarker = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      const fence = FENCE_RE.exec(line);
      if (fence !== null) {
        const marker = fence[1] ?? '';
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (marker === fenceMarker) {
          inFence = false;
        }
        continue;
      }
      if (inFence) continue;

      const heading = HEADING_RE.exec(line);
      if (heading === null) continue;
      const level = (heading[1] ?? '').length;
      const text = heading[2] ?? '';

      // Track ancestors at every level so folded deep headings still
      // contribute to the path of later, shallower-or-equal siblings' children.
      headingStack.splice(level - 1);
      headingStack[level - 1] = text;

      if (level > maxHeadingDepth) continue; // folds into the current section

      // First boundary heading below line 1 implies a preamble chunk.
      if (sections.length === 0 && i > 0) {
        sections.push({ startLine: 1, symbolName: fileName });
      }
      const ancestors = headingStack.slice(0, level).filter((t): t is string => t !== undefined);
      const path = [fileName, ...ancestors].join(' > ');
      sections.push({ startLine: i + 1, symbolName: path });
    }

    // No headings at all — the whole file is one preamble chunk.
    if (sections.length === 0) {
      sections.push({ startLine: 1, symbolName: fileName });
    }

    const chunks: Chunk[] = [];
    for (let s = 0; s < sections.length; s++) {
      const section = sections[s];
      if (section === undefined) continue;
      const next = sections[s + 1];
      const endLine = next !== undefined ? next.startLine - 1 : lines.length;
      pushSectionChunks(chunks, {
        lines,
        filePath,
        fileMtime,
        chunkSplitThreshold,
        symbolName: section.symbolName,
        startLine: section.startLine,
        endLine,
      });
    }
    return chunks;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Basename of a relative path — the heading-path root. */
function fileNameOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

interface PushSectionOpts {
  readonly lines: readonly string[];
  readonly filePath: string;
  readonly fileMtime: number;
  readonly chunkSplitThreshold: number;
  readonly symbolName: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Push one doc chunk — or N overlapping sub-chunks when the section exceeds
 * `chunkSplitThreshold` lines. Mirrors the code-side split rule (window =
 * threshold, 10-line overlap, sub-index-qualified chunk IDs) so downstream
 * consumers see one consistent scheme.
 */
function pushSectionChunks(chunks: Chunk[], opts: PushSectionOpts): void {
  const { lines, filePath, fileMtime, symbolName, startLine, endLine } = opts;
  const base = {
    file_path: filePath,
    chunk_type: 'doc' as const,
    symbol_name: symbolName,
    parent_symbol: null,
    is_exported: false,
    language: 'markdown' as const,
    file_mtime: fileMtime,
  };

  if (endLine - startLine + 1 <= opts.chunkSplitThreshold) {
    chunks.push({
      ...base,
      chunk_id: chunkId(filePath, startLine),
      start_line: startLine,
      end_line: endLine,
      content: lines.slice(startLine - 1, endLine).join('\n'),
    });
    return;
  }

  const OVERLAP_LINES = 10;
  let subStart = startLine;
  let subIndex = 0;
  while (subStart <= endLine) {
    const subEnd = Math.min(subStart + opts.chunkSplitThreshold - 1, endLine);
    chunks.push({
      ...base,
      chunk_id: sha256(`${filePath}:${startLine}:${subIndex}`),
      start_line: subStart,
      end_line: subEnd,
      content: lines.slice(subStart - 1, subEnd).join('\n'),
    });
    if (subEnd >= endLine) break;
    subStart = subEnd - OVERLAP_LINES + 1;
    subIndex++;
  }
}
