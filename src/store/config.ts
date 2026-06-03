import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MastConfig } from '../ast/types.js';
import { ConfigEnvSchema } from '../env.js';

// 1.1.0: vectors.lance gained a `content_hash` column so re-embedding is keyed
// on chunk content, not just chunk_id (H1). A bump forces the §7.4 Step 2 wipe
// so an old vectors table (without the column) is rebuilt rather than read.
export const CURRENT_SCHEMA_VERSION = '1.1.0';

const DEFAULTS: MastConfig = {
  state_dir: '.mast',
  project_root: '.',
  file_extensions: ['.ts', '.tsx', '.js', '.jsx'],
  exclude_patterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '.kluster/**',
    '**/*.test.ts',
    '**/*.spec.ts',
  ],
  embedding_model: 'jinaai/jina-embeddings-v2-base-code',
  similarity_threshold: 0.70,
  rrf_k: 60,
  chunk_split_threshold: 100,
  context_lines: 3,
};

export interface ResolvedConfig extends MastConfig {
  /** Absolute path to the state directory. */
  readonly resolved_state_dir: string;
  /** Absolute path to the project root. */
  readonly resolved_project_root: string;
  /** Resolved absolute path for the Transformers.js model weight cache. */
  readonly resolved_transformers_cache_dir: string;
}

/**
 * Resolve the Transformers.js model weight cache directory.
 *
 * Priority:
 * 1. Explicit `transformers_cache_dir` from config.
 * 2. `/opt/transformers-cache` if it exists and is writable (Docker pre-warmed).
 * 3. `~/.cache/mast/transformers` as the local-dev fallback.
 */
export function resolveTransformersCacheDir(configured?: string): string {
  if (configured) return resolve(configured);
  const dockerPath = '/opt/transformers-cache';
  try {
    accessSync(dockerPath, constants.W_OK);
    return dockerPath;
  } catch {
    // Not writable — fall through to local path.
  }
  return join(homedir(), '.cache', 'mast', 'transformers');
}

export interface ResolveConfigOptions {
  /** Absolute or relative path to project root (default: cwd). */
  projectRoot?: string;
  /**
   * Overrides state_dir from config file.
   * Falls back to MAST_STATE_DIR env var, then mast.config.json, then default.
   */
  stateDirOverride?: string;
}

/**
 * Resolve the active MAST configuration.
 *
 * Priority order (highest to lowest):
 * 1. `stateDirOverride` (CLI `--state-dir` flag) for the state directory
 * 2. `MAST_STATE_DIR` environment variable for the state directory
 * 3. `mast.config.json` in `projectRoot`
 * 4. Built-in defaults
 */
export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
  const resolvedProjectRoot = resolve(options.projectRoot ?? process.cwd());
  const configFile = join(resolvedProjectRoot, 'mast.config.json');

  let fileConfig: Partial<MastConfig> = {};
  if (existsSync(configFile)) {
    const raw = readFileSync(configFile, 'utf-8');
    fileConfig = JSON.parse(raw) as Partial<MastConfig>;
  }

  const merged: MastConfig = { ...DEFAULTS, ...fileConfig };

  const { MAST_STATE_DIR: envStateDir } = ConfigEnvSchema.parse(process.env);
  const stateDir = options.stateDirOverride ?? envStateDir ?? merged.state_dir;

  return {
    ...merged,
    state_dir: stateDir,
    project_root: resolvedProjectRoot,
    resolved_state_dir: resolve(resolvedProjectRoot, stateDir),
    resolved_project_root: resolvedProjectRoot,
    resolved_transformers_cache_dir: resolveTransformersCacheDir(merged.transformers_cache_dir),
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
