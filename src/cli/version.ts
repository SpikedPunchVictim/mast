import { createRequire } from 'node:module';

/**
 * Package identity, read from the manifest rather than restated.
 *
 * The CLI previously carried a literal `.version('0.1.0')` next to package.json's
 * own `"version"`. Two producers of one value drift (defect shape S-05), and this
 * pair drifts silently: nothing fails when `mast --version` reports a release the
 * binary is not, which is precisely the confusion D8 cost three days to untangle.
 *
 * `createRequire` rather than a JSON import attribute: the same mechanism
 * `ast/parser.ts` already uses, and it resolves identically from `src/` under
 * vitest and from `dist/cli/` in the published package, because both sit two
 * directories below the manifest.
 */
const require = createRequire(import.meta.url);
const manifest = require('../../package.json') as { name: string; version: string };

export const PACKAGE_NAME: string = manifest.name;
export const CLI_VERSION: string = manifest.version;
