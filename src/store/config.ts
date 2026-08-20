import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MastConfig } from '../ast/types.js';
import { ConfigEnvSchema } from '../env.js';

// 1.3.0 (F5, Stage 3): identifier_fts rows now carry QUALIFIED compound
// strings ("Class.method") appended after the bare-identifier bag — see
// ast/extractors/typescript.ts's `appendQualifiedCompounds` and MAST_SPEC.md
// §6.3. This is a CONTENT-format change to an already-existing column, not a
// new column, so a schema-diff check would not catch it: an old index's
// identifier_fts rows lack the compounds entirely, and `searchIdentifiers`'
// phrase query for a qualified method name would silently keep returning []
// against that stale state — exactly the class of wrong-version hazard §7.4's
// migration guard exists for (a confidently-empty answer, not an error).
// Bumping forces the §7.4 Step 2 wipe-and-full-reindex path, verified by
// mcp/__tests__/startup.test.ts's schema-mismatch coverage; the Docker seed
// (§7.4) picks up the new format automatically on its next build since it
// reindexes from a version-tagged image rather than reusing a mounted volume.
//
// 1.2.0: chunks moved from chunks.lance to a `chunks` table inside graph.db
// (M1, eval/GITNEXUS_COMPARISON.md §15.1) — the on-disk shape changed (a new
// SQLite table plus the retired Lance chunk table) so old state must not be
// read by code expecting the new layout. Per the never-shipped constraint
// (no customers, no migration data to preserve) the §7.4 Step 2 wipe-and-full-
// reindex path is the correct and sufficient handling, verified by
// mcp/__tests__/startup.test.ts's schema-mismatch coverage.
//
// 1.1.0: vectors.lance gained a `content_hash` column so re-embedding is keyed
// on chunk content, not just chunk_id (H1). A bump forces the §7.4 Step 2 wipe
// so an old vectors table (without the column) is rebuilt rather than read.
export const CURRENT_SCHEMA_VERSION = '1.3.0';

const DEFAULTS: MastConfig = {
  state_dir: '.mast',
  project_root: '.',
  // `.md` rides the existing exclude_patterns for vendored noise — dependency
  // READMEs live under node_modules/** which is already excluded; no
  // markdown-specific exclusion logic is applied.
  file_extensions: ['.ts', '.tsx', '.js', '.jsx', '.md'],
  // Build output, dependencies, and tests. `.mast/**` excludes this tool's own
  // state directory, which is the one path guaranteed to exist in every project
  // that runs it. (`.kluster/**` sat here until 2026-08-19 — a leftover from the
  // repository mast was extracted from, meaningless to any other consumer.)
  exclude_patterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/.next/**',
    '**/.turbo/**',
    '.mast/**',
    '**/*.test.ts',
    '**/*.spec.ts',
  ],
  rrf_k: 60,
  declaration_exact_ranker: true,
  chunk_split_threshold: 100,
  context_lines: 3,
  markdown_heading_depth: 2,
};

export interface ResolvedConfig extends MastConfig {
  /** Absolute path to the state directory. */
  readonly resolved_state_dir: string;
  /** Absolute path to the project root. */
  readonly resolved_project_root: string;
}

export interface ResolveConfigOptions {
  /** Absolute or relative path to project root (default: cwd). */
  projectRoot?: string;
  /**
   * Overrides state_dir from config file.
   * Falls back to MAST_STATE_DIR env var, then mast.config.json, then default.
   */
  stateDirOverride?: string;
  /**
   * Explicit override for `file_extensions` (F9, `mast init --extensions`).
   * Highest priority in the config merge — wins over `mast.config.json` and
   * any persisted `<state_dir>/config.json`.
   */
  extensions?: readonly string[];
  /**
   * Explicit override for `exclude_patterns` (F9, `mast init --exclude`).
   * Same priority as `extensions`.
   */
  excludePatterns?: readonly string[];
}

// F9 (Stage 3.5, eval/GITNEXUS_COMPARISON.md M3): the keys a caller may
// customise, as opposed to the path keys (`state_dir`, `project_root`,
// `resolved_state_dir`, `resolved_project_root`) that describe WHERE this
// resolution is running, not WHAT it configures. Used by
// `pickStateConfigCustomization` below to build an explicit picked-keys
// merge — never a spread-minus-deletes — so a path key can never leak in
// through this list by omission.
const CUSTOMIZATION_KEYS = [
  'file_extensions',
  'exclude_patterns',
  'rrf_k',
  'declaration_exact_ranker',
  'chunk_split_threshold',
  'context_lines',
  'markdown_heading_depth',
] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Picks ONLY the customisation keys out of a persisted `<state_dir>/config.json`
 * — never `state_dir`/`project_root`/`resolved_state_dir`/`resolved_project_root`.
 *
 * WHY this matters (path-portability hazard): `writeStateConfig` persists a
 * full `ResolvedConfig`, including ABSOLUTE paths resolved in a PREVIOUS
 * process. The SDD pipeline mounts the same workspace volume at different
 * container paths across runs, so an absolute path loaded back from a
 * previous container would silently resolve `resolved_state_dir` /
 * `resolved_project_root` to a location that doesn't exist (or worse, exists
 * but belongs to an unrelated project) in THIS container. Every path field
 * in the returned `ResolvedConfig` must always come from the CURRENT
 * resolution — never from disk.
 *
 * Unlike `mast.config.json` (see the precedent comment on `resolveConfig`
 * below, which trusts a plain `JSON.parse` cast because that file is
 * developer-authored and colocated with source control), a state
 * config.json is machine-written but crosses a trust boundary of its own —
 * an arbitrary file on disk that could be stale, foreign, or hand-edited.
 * Each picked key is minimally validated by shape (string array / number /
 * boolean) rather than trusted on cast; a key that fails validation is
 * dropped so DEFAULTS (or a lower-priority layer) fills it in instead of a
 * malformed value silently propagating.
 */
function pickStateConfigCustomization(source: Partial<MastConfig> | null): Partial<MastConfig> {
  if (source === null) return {};

  // `MastConfig`'s fields are `readonly` (immutable once constructed), but
  // this function BUILDS one field at a time — a mutable local view keeps
  // the assignments below straightforward. The returned value still exposes
  // the standard `Partial<MastConfig>` (readonly) shape to callers.
  const picked: { -readonly [K in keyof MastConfig]?: MastConfig[K] } = {};
  if (isStringArray(source.file_extensions)) picked.file_extensions = source.file_extensions;
  if (isStringArray(source.exclude_patterns)) picked.exclude_patterns = source.exclude_patterns;
  if (typeof source.rrf_k === 'number') picked.rrf_k = source.rrf_k;
  if (typeof source.declaration_exact_ranker === 'boolean') {
    picked.declaration_exact_ranker = source.declaration_exact_ranker;
  }
  if (typeof source.chunk_split_threshold === 'number') picked.chunk_split_threshold = source.chunk_split_threshold;
  if (typeof source.context_lines === 'number') picked.context_lines = source.context_lines;
  if (typeof source.markdown_heading_depth === 'number') {
    picked.markdown_heading_depth = source.markdown_heading_depth;
  }

  // Safety net for the path-portability rule above: fails loudly if a future
  // edit to this function ever assigns a key outside CUSTOMIZATION_KEYS (e.g.
  // a path key re-added by accident) instead of silently reintroducing the
  // shared-volume hazard this function exists to prevent.
  for (const key of Object.keys(picked)) {
    if (!(CUSTOMIZATION_KEYS as readonly string[]).includes(key)) {
      throw new Error(`pickStateConfigCustomization: unexpected key "${key}" outside CUSTOMIZATION_KEYS`);
    }
  }

  return picked;
}

/**
 * Resolve the active MAST configuration.
 *
 * State-directory priority order (highest to lowest) — unchanged by F9,
 * because the state dir must be resolved BEFORE the persisted state config
 * can be loaded from inside it:
 * 1. `stateDirOverride` (CLI `--state-dir` flag)
 * 2. `MAST_STATE_DIR` environment variable
 * 3. `state_dir` key in `mast.config.json`
 * 4. Built-in default (`.mast`)
 *
 * Priority order for every other config key (highest to lowest):
 * 1. Explicit overrides passed to this function (`extensions`/`excludePatterns`
 *    — CLI `mast init --extensions`/`--exclude`, F9)
 * 2. `mast.config.json` in `projectRoot`
 * 3. Persisted `<resolved_state_dir>/config.json` (F9 — previously write-only
 *    dead state; see `pickStateConfigCustomization` for why only the
 *    customisation keys are taken from it, never the path keys)
 * 4. Built-in defaults
 */
export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
  const resolvedProjectRoot = resolve(options.projectRoot ?? process.cwd());
  const configFile = join(resolvedProjectRoot, 'mast.config.json');

  // Never-shipped ⇒ no back-compat (IMPLEMENTATION_PLAN.md Stage 7 decision
  // 2): a `mast.config.json` written before Stage 7.2 may still carry the
  // removed embedding-model / Transformers.js cache-dir config keys. Nothing
  // here validates the parsed shape (plain JSON.parse + cast, no zod) — this
  // file is developer-authored and colocated with source control, unlike the
  // machine-written state config.json below which DOES get minimal shape
  // validation (see `pickStateConfigCustomization`). Those extra keys just
  // ride along on `fileConfig`/`merged` unread — the spread below never looks
  // them up, and `writeStateConfig` re-persisting `merged` via
  // `JSON.stringify` carries them along harmlessly too.
  let fileConfig: Partial<MastConfig> = {};
  if (existsSync(configFile)) {
    const raw = readFileSync(configFile, 'utf-8');
    fileConfig = JSON.parse(raw) as Partial<MastConfig>;
  }

  // State dir chain is resolved first and independently of the customisation
  // merge below — see the priority-order doc comment above.
  const { MAST_STATE_DIR: envStateDir } = ConfigEnvSchema.parse(process.env);
  const stateDir = options.stateDirOverride ?? envStateDir ?? fileConfig.state_dir ?? DEFAULTS.state_dir;
  const resolvedStateDir = resolve(resolvedProjectRoot, stateDir);

  const stateConfig = pickStateConfigCustomization(loadStateConfig(resolvedStateDir));

  const cliOverrides: Partial<MastConfig> = {
    ...(options.extensions !== undefined ? { file_extensions: options.extensions } : {}),
    ...(options.excludePatterns !== undefined ? { exclude_patterns: options.excludePatterns } : {}),
  };

  const merged: MastConfig = { ...DEFAULTS, ...stateConfig, ...fileConfig, ...cliOverrides };

  return {
    ...merged,
    state_dir: stateDir,
    project_root: resolvedProjectRoot,
    resolved_state_dir: resolvedStateDir,
    resolved_project_root: resolvedProjectRoot,
  };
}

/**
 * Load a previously-written config.json from the state directory.
 * Returns null if the file does not exist.
 */
export function loadStateConfig(stateDir: string): Partial<MastConfig> | null {
  const configPath = join(stateDir, 'config.json');
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<MastConfig>;
}

/** Write the resolved config to `<stateDir>/config.json`. */
export function writeStateConfig(stateDir: string, config: ResolvedConfig): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify(config, null, 2));
}
