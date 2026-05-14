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
  | 'block';

export type Language = 'typescript' | 'javascript';

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
  readonly similarity_threshold: number;
  /** Reciprocal Rank Fusion constant k (default 60). */
  readonly rrf_k: number;
  /** Lines above which a declaration is split into overlapping sub-chunks. */
  readonly chunk_split_threshold: number;
  /** Source lines before/after AST boundaries included in stored content. */
  readonly context_lines: number;
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
  readonly file_busy_returning_stale_cache?: true;
}

export interface SearchResponse {
  readonly mode: SearchMode;
  readonly results: readonly SearchResult[];
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

export interface StatusResult {
  readonly state_dir: string;
  readonly last_indexed: string | null;
  readonly indexed_files: number;
  readonly chunk_count: number;
  readonly stale_files: number;
  readonly parse_errors: number;
  readonly index_fresh: boolean;
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
