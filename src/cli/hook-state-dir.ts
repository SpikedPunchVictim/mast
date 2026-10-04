// Imports Node built-ins and builtin-only repo modules only; see cli/hook.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_FILE_EXTENSIONS, DEFAULT_STATE_DIR } from '../store/defaults.js';

/** The two facts the search hook needs from the project's configuration. */
export interface HookConfig {
  readonly stateDir: string;
  readonly fileExtensions: readonly string[];
}

/**
 * Resolves the state directory and the indexed extensions the way `resolveConfig`
 * does, without zod.
 *
 * This is a second producer of two facts, tolerated because the hook runs before every
 * Grep and `resolveConfig` drags in zod through `env.ts`. `hook-state-dir.test.ts`
 * runs both over the same cases; change one and that test tells you about the other.
 *
 * Precedence mirrors `resolveConfig` minus the CLI flags, which a hook never has.
 * State dir: MAST_STATE_DIR, then `state_dir` in `<root>/mast.config.json`, then the
 * default, resolved against the project root (an absolute value stays as it is).
 * Extensions: `file_extensions` in `mast.config.json`, then the one persisted in
 * `<state dir>/config.json` (what `mast init --extensions` wrote), then the default.
 *
 * Throws where `resolveConfig` throws (an empty MAST_STATE_DIR, an unparseable
 * config file), so the hook reports the same broken setup the CLI would.
 */
export function resolveHookConfigLight(
  projectRoot: string,
  env: Record<string, string | undefined>,
): HookConfig {
  const root = resolve(projectRoot);
  const fileConfig = readJsonObject(join(root, 'mast.config.json'));

  const fromEnv = env['MAST_STATE_DIR'];
  if (fromEnv === '') throw new Error('MAST_STATE_DIR is set but empty');
  const stateDir = resolve(root, fromEnv ?? stateDirOf(fileConfig) ?? DEFAULT_STATE_DIR);

  const fileExtensions =
    stringArrayOf(fileConfig, 'file_extensions') ??
    stringArrayOf(readJsonObject(join(stateDir, 'config.json')), 'file_extensions') ??
    DEFAULT_FILE_EXTENSIONS;

  return { stateDir, fileExtensions };
}

function readJsonObject(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return Object.fromEntries(Object.entries(parsed));
}

function stateDirOf(fileConfig: Record<string, unknown> | null): string | undefined {
  const value = fileConfig?.['state_dir'];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('mast.config.json: state_dir must be a string');
  return value;
}

function stringArrayOf(source: Record<string, unknown> | null, key: string): readonly string[] | undefined {
  const value = source?.[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length === value.length ? strings : undefined;
}
