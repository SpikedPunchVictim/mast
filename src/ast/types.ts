/** All domain types shared across MAST subsystems. */

// ---------------------------------------------------------------------------
// Core index types
// ---------------------------------------------------------------------------

export type ChunkType =
  | 'function'
  | 'method'
  | 'class_shell'
  | 'interface'
  | 'type'
  | 'export'
  | 'block'
  /** Markdown document section (heading-based chunking, §10.1). */
  | 'doc';

export type Language = 'typescript' | 'javascript' | 'markdown';

/**
 * A single indexed code chunk — maps to one AST declaration (or a sub-chunk
 * when the declaration exceeds `chunk_split_threshold` lines).
 *
 * `start_line` / `end_line` always reflect AST declaration boundaries.
 * `content` may extend `context_lines` beyond those boundaries for display.
 */
export interface Chunk {
  readonly chunk_id: string;       // sha256(file_path + ":" + start_line)
  readonly file_path: string;      // relative to project_root
  readonly start_line: number;     // 1-indexed, AST boundary
  readonly end_line: number;       // 1-indexed, inclusive, AST boundary
  readonly content: string;        // raw source, context_lines-expanded
  readonly chunk_type: ChunkType;
  readonly symbol_name: string | null;
  /** Enclosing class name for `method` chunks; null for all others. */
  readonly parent_symbol: string | null;
  readonly is_exported: boolean;
  readonly language: Language;
  readonly file_mtime: number;     // unix seconds at index time
  /**
   * sha256 of the symbol's signature (declaration up to, not including, the
   * body). Transient: computed from the AST during extraction and consumed by
   * `symbolsFromChunks`; NOT persisted to chunks.lance. Undefined on
   * `block` chunks and on chunks reconstructed from the store.
   */
  readonly declaration_hash?: string;
  /**
   * sha256 of the symbol's body. For `class_shell`, the sorted member
   * signatures (no method bodies), per §10.1. Transient — see `declaration_hash`.
   */
  readonly body_hash?: string;
}

/** Stability hashes stored per chunk for incremental reindex optimisation. */
export interface ChunkHashes {
  readonly chunk_id: string;
  /** sha256 of signature text only (excludes body). */
  readonly declaration_hash: string;
  /** sha256 of body text; for class_shell, over sorted member signatures. */
  readonly body_hash: string;
}

export interface VectorEntry {
  readonly chunk_id: string;
  readonly embedding: readonly number[];
  readonly model_version: string;
  /**
   * sha256 of the chunk content this vector was computed from. Set by the embed
   * orchestration (not the model) so freshness can be checked on reindex: a
   * chunk whose content changed has a new hash and is re-embedded even though
   * its `chunk_id` (file_path:start_line) is unchanged. Optional on the wire;
   * always populated before insert.
   */
  readonly content_hash?: string;
}

// ---------------------------------------------------------------------------
// Graph population records (produced by AST extraction, consumed by populate.ts)
// ---------------------------------------------------------------------------

export interface SymbolRecord {
  readonly name: string;
  /** `function | class | interface | type | const | method` */
  readonly kind: string;
  readonly line: number;
  readonly isExported: boolean;
  /** sha256 of signature text only (excludes body). */
  readonly declarationHash: string | null;
  /** sha256 of body text; for class_shell, over sorted member signatures. */
  readonly bodyHash: string | null;
}

export interface ImportRecord {
  readonly module: string;
  readonly symbols: readonly string[];
  readonly isExternal: boolean;
  /** Resolved relative path for intra-monorepo imports; null for external. */
  readonly resolvedPath: string | null;
}

export interface EdgeRecord {
  readonly fromName: string;
  readonly toName: string;
  readonly edgeType: string;
  /** How a POTENTIAL_CALL receiver was statically linked (§10.3.1). */
  readonly resolution?: CallerResolution;
  /** 1-indexed source line of the call site (POTENTIAL_CALL only). */
  readonly callLine?: number;
  /** Trimmed source text of the call-site line (POTENTIAL_CALL only). */
  readonly context?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MastConfig {
  readonly state_dir: string;
  readonly project_root: string;
  readonly file_extensions: readonly string[];
  readonly exclude_patterns: readonly string[];
  readonly embedding_model: string;
  /**
   * Directory where Transformers.js caches ONNX model weights.
   * When omitted, resolved at runtime: `/opt/transformers-cache` if writable
   * (Docker pre-warmed), otherwise `~/.cache/mast/transformers`.
   */
  readonly transformers_cache_dir?: string;
  // similarity_threshold was removed (Task 9): the absolute cosine gate was
  // miscalibrated for the shipped model (0/28 gold conceptual queries cleared
  // 0.70) and cosine scales are model-specific. Vector candidates now enter
  // RRF by rank (§7.3); no knob replaced it because no honest cross-model
  // default exists.
  /** Reciprocal Rank Fusion constant k (default 60). */
  readonly rrf_k: number;
  /** Lines above which a declaration is split into overlapping sub-chunks. */
  readonly chunk_split_threshold: number;
  /** Source lines before/after AST boundaries included in stored content. */
  readonly context_lines: number;
  /**
   * Maximum ATX heading level that starts a new markdown doc chunk (§10.1).
   * Headings deeper than this fold into their enclosing section. Default 2 —
   * "one chunk per `##` section".
   */
  readonly markdown_heading_depth: number;
}

// ---------------------------------------------------------------------------
// Index metadata (index.json)
// ---------------------------------------------------------------------------

export interface IndexMeta {
  schema_version: string;
  last_indexed: string | null;   // ISO 8601, null when never indexed
  file_count: number;
  chunk_count: number;
  model: string;
  parse_errors?: number;         // files skipped in the last index run due to parse failures
  seed_commit?: string;          // git rev baked into Docker seed layer
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export type SearchMode = 'hybrid' | 'lexical';

/** Attached to every read-tool response to track token savings. */
export interface ToolStats {
  readonly tool: string;
  readonly tokens_returned: number;
  readonly tokens_full_file_upper_bound: number;
  readonly files_referenced: readonly string[];
  /** 1 - (tokens_returned / tokens_full_file_upper_bound) */
  readonly efficiency_ratio: number;
  readonly duration_ms: number;
  readonly mode?: SearchMode;    // present only on mast_search
}

// ---------------------------------------------------------------------------
// MCP tool I/O types
// ---------------------------------------------------------------------------

// --- mast_search ---

export interface SearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly language?: Language | null;
  readonly file_pattern?: string | null;
  readonly chunk_type?: ChunkType | null;
  readonly only_exported?: boolean;
}

/**
 * Presentation hint attached by the post-RRF shell/method dedup pass
 * (§9 mast_search). Exactly one shape:
 * - a surviving `method` whose class shell was suppressed carries
 *   `{ parent_symbol }` — "the class outline also matched";
 * - a surviving `class_shell` whose methods were suppressed carries
 *   `{ methods_matched }` — the qualified method names that also matched.
 */
export type RelatedHint =
  | { readonly parent_symbol: string }
  | { readonly methods_matched: readonly string[] };

export interface SearchResult {
  readonly file_path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly content: string;
  readonly chunk_type: ChunkType;
  readonly symbol_name: string | null;
  readonly parent_symbol: string | null;
  readonly is_exported: boolean;
  readonly similarity_score: number | null;  // null in lexical mode
  readonly match_score: number | null;       // BM25 score (negative); null when no FTS hit
  readonly rank: number;
  readonly match_snippet: string | null;
  /** Present only when the shell/method dedup pass suppressed a counterpart. */
  readonly related?: RelatedHint;
  readonly file_busy_returning_stale_cache?: true;
}

/**
 * A "did you mean" candidate surfaced when a search returns no results.
 * Advisory only — suggestions are never counted as results (§9 mast_search).
 */
export interface SearchSuggestion {
  readonly symbol: string;
  readonly file_path: string;
  /**
   * Why this symbol is a candidate — e.g. "similar symbol name",
   * "matched split query terms", "identifier near-miss".
   */
  readonly reason: string;
}

export interface SearchResponse {
  readonly mode: SearchMode;
  readonly results: readonly SearchResult[];
  /**
   * Present (possibly empty) only when `results` is empty — the zero-result
   * assist path ran. Omitted entirely when results were found.
   */
  readonly suggestions?: readonly SearchSuggestion[];
  readonly _stats: ToolStats;
}

// --- mast_project_skeleton ---

export interface ProjectSkeletonInput {
  readonly directory?: string | null;
  readonly max_depth?: number;
  readonly file_pattern?: string | null;
}

export interface FileSkeleton {
  readonly file_path: string;
  readonly exports: readonly string[];
}

export interface ProjectSkeletonResponse {
  readonly files: readonly FileSkeleton[];
  readonly _stats: ToolStats;
}

// --- mast_exports ---

export interface ExportsInput {
  readonly file_path: string;
}

export interface ExportEntry {
  readonly name: string;
  readonly kind: string;
  readonly signature: string;
  readonly line: number;
  readonly doc: string | null;
}

export interface ExportsResponse {
  readonly file_path: string;
  readonly exports: readonly ExportEntry[];
  readonly _stats: ToolStats;
}

// --- mast_signature ---

export interface SignatureInput {
  readonly symbol: string;
  readonly file_path?: string | null;
}

export interface ParamEntry {
  readonly name: string;
  readonly type: string;
}

export interface TypeContextEntry {
  readonly name: string;
  readonly signature: string;
  readonly file_path: string;
  readonly line: number;
  readonly truncated: boolean;
}

export interface SignatureResult {
  readonly symbol: string;
  readonly file_path: string;
  readonly line: number;
  readonly signature: string;
  readonly doc: string | null;
  readonly params: readonly ParamEntry[];
  readonly return_type: string | null;
  readonly type_context: readonly TypeContextEntry[];
  readonly file_busy_returning_stale_cache?: true;
}

export interface SignatureResponse {
  readonly results: readonly SignatureResult[];
  readonly _stats: ToolStats;
}

// --- mast_callers ---

export interface CallersInput {
  readonly symbol: string;
  readonly file_path?: string | null;
  readonly transitive?: boolean;
  readonly include_potential?: boolean;
}

export type CallerResolution =
  | 'import'
  | 'field_type'
  | 'parameter_type'
  | 'new_expression'
  | 'same_file';

export interface VerifiedCaller {
  readonly file_path: string;
  readonly line: number;
  readonly caller_symbol: string;
  readonly context: string;
  readonly resolution: CallerResolution;
  readonly file_busy_returning_stale_cache?: true;
}

export interface PotentialMatch {
  readonly file_path: string;
  readonly line: number;
  readonly context: string;
  readonly reason: 'identifier_match_no_resolved_edge';
}

export interface CallersResponse {
  readonly verified_callers: readonly VerifiedCaller[];
  readonly potential_matches: readonly PotentialMatch[];
  readonly summary: {
    readonly verified_count: number;
    readonly potential_count: number;
    readonly transitive: boolean;
  };
  readonly _stats: ToolStats;
}

// --- mast_rename_impact ---

export interface RenameImpactInput {
  readonly symbol: string;
  readonly file_path?: string | null;
}

export interface DeclarationSite {
  readonly file_path: string;
  readonly line: number;
  readonly kind: string;
  readonly is_exported: boolean;
}

export interface BarrelExportSite {
  readonly file_path: string;
  /** Line of the re-export specifier; null for star barrels (file-level). */
  readonly line: number | null;
  /** Name the barrel exposes — differs from the symbol name when aliased. */
  readonly exported_as: string;
  readonly via: 'named' | 'star';
}

/**
 * Composed refactor checklist for renaming a symbol (§9 mast_rename_impact).
 * Every section reuses an existing query capability — declarations from the
 * symbols table, callers from POTENTIAL_CALL edges, review sites from
 * identifier_fts, barrels from RE_EXPORTS + re_export_files.
 */
export interface RenameImpactResponse {
  readonly symbol: string;
  readonly declaration_sites: readonly DeclarationSite[];
  readonly verified_callers: readonly VerifiedCaller[];
  readonly potential_matches: readonly PotentialMatch[];
  readonly barrel_exports: readonly BarrelExportSite[];
  readonly summary: {
    readonly declaration_count: number;
    readonly verified_count: number;
    readonly potential_count: number;
    readonly barrel_count: number;
    /** Human-readable framing: "N verified…, M review-required…, K barrel…". */
    readonly checklist: string;
  };
  readonly _stats: ToolStats;
}

// --- mast_dependencies ---

export interface DependenciesInput {
  readonly file_path: string;
}

export interface DependencyEntry {
  readonly module: string;
  readonly symbols: readonly string[];
  readonly is_external: boolean;
  readonly resolved_path?: string;
}

export interface DependenciesResponse {
  readonly file_path: string;
  readonly imports: readonly DependencyEntry[];
  readonly _stats: ToolStats;
}

// --- mast_implementors ---

export interface ImplementorsInput {
  readonly interface_name: string;
}

export interface ImplementorResult {
  readonly class_name: string;
  readonly file_path: string;
  readonly line: number;
  readonly methods: readonly string[];
}

export interface ImplementorsResponse {
  readonly results: readonly ImplementorResult[];
  readonly _stats: ToolStats;
}

// --- mast_reindex ---

export interface ReindexInput {
  readonly full?: boolean;
}

export interface ReindexResult {
  readonly files_indexed: number;
  readonly files_skipped: number;
  readonly chunks_added: number;
  readonly chunks_removed: number;
  readonly parse_errors: number;
  readonly duration_ms: number;
}

// --- mast_status ---

/**
 * Why the index is not fully fresh (null when it is). Distinguishes Phase 1
 * staleness (chunk line coordinates lag disk — corrected by JIT on read) from
 * a Phase 2 backlog (parsing current, embeddings lagging — semantic ranking
 * degraded until the background embedder catches up).
 */
export type FreshnessCause = 'phase1_stale' | 'embedding_backlog' | 'both' | null;

export interface StatusResult {
  readonly state_dir: string;
  readonly last_indexed: string | null;
  readonly indexed_files: number;
  readonly chunk_count: number;
  readonly stale_files: number;
  /** Chunks whose current content has no stored vector (§6.2 freshness rule). */
  readonly pending_embeddings: number;
  readonly parse_errors: number;
  /** Phase 1 freshness only — an embedding backlog does not flip this. */
  readonly index_fresh: boolean;
  readonly freshness_cause: FreshnessCause;
  readonly model: string;
  readonly seed_commit?: string;
  readonly embedding_mode: SearchMode;
}

// --- mast_efficiency ---

export interface EfficiencyInput {
  readonly scope: 'session' | 'global';
  readonly since_minutes?: number;
}

export interface EfficiencyResult {
  readonly scope: 'session' | 'global';
  readonly window_started_at: string;
  readonly tokens_returned: number;
  readonly tokens_full_file_upper_bound: number;
  readonly efficiency_ratio: number;
  readonly calls_total: number;
  readonly calls_by_tool: Readonly<Record<string, number>>;
  readonly tokenizer: string;
  readonly counterfactual: string;
}
