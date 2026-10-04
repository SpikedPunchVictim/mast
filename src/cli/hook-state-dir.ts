// Imports Node built-ins and builtin-only repo modules only; see cli/hook.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_STATE_DIR } from '../store/defaults.js';

/**
 * Resolves the state directory the way `resolveConfig` does, without zod.
 *
 * This is a second producer of one fact, tolerated because the hook runs before every
 * Grep and `resolveConfig` drags in zod through `env.ts`. `hook-state-dir.test.ts`
 * runs both over the same cases; change one and that test tells you about the other.
 *
 * Precedence mirrors `resolveConfig` minus the CLI flag, which a hook never has:
 * MAST_STATE_DIR, then `state_dir` in `<root>/mast.config.json`, then the default,
 * resolved against the project root (an absolute value stays as it is).
 *
 * Throws where `resolveConfig` throws (an empty MAST_STATE_DIR, an unparseable
 * mast.config.json), so the hook reports the same broken setup the CLI would.
 */
export function resolveStateDirLight(
  projectRoot: string,
  env: Record<string, string | undefined>,
): string {
  const root = resolve(projectRoot);
  const fromEnv = env['MAST_STATE_DIR'];
  if (fromEnv === '') throw new Error('MAST_STATE_DIR is set but empty');
  const stateDir = fromEnv ?? readConfigFileStateDir(root) ?? DEFAULT_STATE_DIR;
  return resolve(root, stateDir);
}

function readConfigFileStateDir(root: string): string | undefined {
  const file = join(root, 'mast.config.json');
  if (!existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('state_dir' in parsed)) return undefined;
  const value = parsed.state_dir;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('mast.config.json: state_dir must be a string');
  return value;
}
