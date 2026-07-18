import type { Db } from '../graph/db.js';
import type { VerifiedCaller, PotentialMatch } from '../ast/types.js';
import { searchIdentifiers } from './fts.js';
import { queryCheckerVerdicts } from '../graph/queries.js';

// ---------------------------------------------------------------------------
// Potential-match collection (§9 mast_callers) — the single shared definition
// of "what counts as a potential match", consumed by mast_callers,
// mast_rename_impact (both via mcp/tools/_helpers.ts), and the
// `mast index --checker` pass (graph/checker-resolver.ts). Lives in `search/`
// rather than `mcp/tools/` so the checker pass (which sits at the graph/indexer
// layer) can depend on it without an mcp/tools → graph/indexer inversion —
// `search` already sits between `graph`/`store` and `mcp`/indexer consumers.
// ---------------------------------------------------------------------------

/** The chunk fields candidate collection actually reads. */
export interface CandidateChunkRecord {
  readonly chunk_id: string;
  readonly file_path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly symbol_name: string | null;
}

/**
 * Role interface (§4.3) over "fetch chunks by id" — the only capability this
 * module needs from a chunk store. `LanceStore` satisfies it structurally, so
 * `mast_callers`/`mast_rename_impact` pass their `ctx.lance` directly. The
 * `mast index --checker` pass passes an in-memory prefetched source instead:
 * its Phase A runs candidate collection for EVERY indexed symbol, and one
 * LanceDB round-trip per symbol was measured at 50+ CPU-minutes on the
 * kluster monorepo (10,733 symbols) without completing — one full scan up
 * front plus Map lookups keeps identical semantics at a fraction of the cost.
 */
export interface ChunkByIdSource {
  getChunksByIds(ids: readonly string[]): Promise<readonly CandidateChunkRecord[]>;
}

/**
 * Chunk-level detail behind a potential match. `collectPotentialMatches` (the
 * public shape `mast_callers`/`mast_rename_impact` consume) and the checker
 * pass (which additionally needs `end_line` and the call site's enclosing
 * symbol to classify, and on a definite match, write a caller edge) both
 * derive from this one query — never forked.
 */
export interface PotentialMatchCandidate {
  readonly file_path: string;
  readonly start_line: number;
  readonly end_line: number;
  /** The call site's own enclosing symbol (e.g. the function it appears
   *  inside) — NOT the queried symbol. Null for a `block` chunk (top-level
   *  code with no enclosing declaration). */
  readonly chunk_symbol_name: string | null;
}

/**
 * Identifier-FTS hits for `symbolName` that are NOT already covered by a
 * verified caller — the raw candidate pool behind `potential_matches` (§9
 * mast_callers), before checker-verdict filtering.
 */
export async function collectPotentialMatchCandidates(
  db: Db,
  chunkSource: ChunkByIdSource,
  symbolName: string,
  verified: readonly VerifiedCaller[],
  limit = 50,
): Promise<PotentialMatchCandidate[]> {
  const identRows = await searchIdentifiers(db, symbolName, limit);
  const chunks = await chunkSource.getChunksByIds(identRows.map((r) => r.chunk_id));

  // Exclude chunk IDs already covered by the verified set.
  const verifiedKeys = new Set(verified.map((c) => `${c.file_path}:${c.line}`));
  const candidates: PotentialMatchCandidate[] = [];
  for (const chunk of chunks) {
    if (verifiedKeys.has(`${chunk.file_path}:${chunk.start_line}`)) continue;
    candidates.push({
      file_path: chunk.file_path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      chunk_symbol_name: chunk.symbol_name,
    });
  }
  return candidates;
}

export interface PotentialMatchesResult {
  readonly matches: readonly PotentialMatch[];
  /** Candidates the checker pass classified as not a call site (§10.3.2), dropped from `matches`. */
  readonly checkerClassifiedNonCallSite: number;
  /** Candidates the checker pass resolved to a DIFFERENT declaration, dropped from `matches`. */
  readonly checkerClassifiedDifferentDeclaration: number;
}

/**
 * Identifier-FTS hits for `symbolName` that are NOT already covered by a
 * verified caller — the "review required" set. Shared by `mast_callers` and
 * `mast_rename_impact` so the two tools can never disagree about what counts
 * as a potential match.
 *
 * When `mast index --checker` (Stage 1.2) has classified a candidate as
 * `non_call_site` or `resolves_to_different`, it is dropped here rather than
 * re-surfaced as a review site forever — a `resolves_to_queried` candidate is
 * also dropped defensively (it should already be excluded via `verified`
 * through the checker edge's own `call_line`, but the checker's more-precise
 * call line can differ from the chunk's `start_line` for a multi-line chunk;
 * this filter closes that gap using the SAME (file_path, start_line) key the
 * verdict was recorded against). `unresolved` candidates are never persisted
 * as verdicts (see `checker_verdicts` in `graph/db.ts`) and always remain.
 */
export async function collectPotentialMatches(
  db: Db,
  chunkSource: ChunkByIdSource,
  symbolId: number,
  symbolName: string,
  verified: readonly VerifiedCaller[],
  limit = 50,
): Promise<PotentialMatchesResult> {
  const candidates = await collectPotentialMatchCandidates(db, chunkSource, symbolName, verified, limit);
  const verdicts = await queryCheckerVerdicts(db, symbolId);
  const verdictByKey = new Map<string, string>();
  for (const v of verdicts) verdictByKey.set(`${v.file_path}:${v.call_site_line}`, v.verdict);

  const matches: PotentialMatch[] = [];
  let checkerClassifiedNonCallSite = 0;
  let checkerClassifiedDifferentDeclaration = 0;
  for (const c of candidates) {
    const verdict = verdictByKey.get(`${c.file_path}:${c.start_line}`);
    if (verdict === 'non_call_site') { checkerClassifiedNonCallSite++; continue; }
    if (verdict === 'resolves_to_different') { checkerClassifiedDifferentDeclaration++; continue; }
    if (verdict === 'resolves_to_queried') continue;
    matches.push({
      file_path: c.file_path,
      line: c.start_line,
      context: c.chunk_symbol_name ?? '',
      reason: 'identifier_match_no_resolved_edge',
    });
  }
  return { matches, checkerClassifiedNonCallSite, checkerClassifiedDifferentDeclaration };
}
