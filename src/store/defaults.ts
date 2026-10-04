// Builtin-free on purpose: `cli/hook.ts` runs before every Grep and may not import
// `config.ts` (which pulls in zod). The two facts below are the ones the hook needs,
// so they live here once and `config.ts` imports them rather than restating them.

/** State directory used when neither a flag, MAST_STATE_DIR nor mast.config.json names one. */
export const DEFAULT_STATE_DIR = '.mast';

/**
 * Extensions indexed when the project does not customise `file_extensions`.
 * `.md` rides the existing exclude_patterns for vendored noise — dependency
 * READMEs live under node_modules/** which is already excluded.
 */
export const DEFAULT_FILE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.md'];
