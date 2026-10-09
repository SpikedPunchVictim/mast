import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, isAbsolute } from 'node:path';
import type { Command } from 'commander';
import { CLI_VERSION, PACKAGE_NAME } from './version.js';
import { homedir } from 'node:os';
import { findInstalledArtifacts, readFileOrNull, type InstalledArtifacts } from './installed-artifacts.js';
import { resolveConfig, CURRENT_SCHEMA_VERSION } from '../store/config.js';

/**
 * `mast upgrade` — checks and instructs. It deliberately does NOT perform the upgrade.
 *
 * Two reasons, both practical rather than stylistic. A CLI cannot reliably know how it
 * was installed — global, devDependency, dlx, a monorepo catalog — and guessing wrong
 * means running the wrong command in someone's repository. And self-mutating requires
 * write access to its own install directory, which is exactly what fails in CI and
 * containers.
 *
 * What the package manager *cannot* do is the reason this command exists at all:
 * upgrading across a schema-version change makes `bootstrapState` and `runIndex` empty the
 * index and reindex from scratch (`mcp/startup.ts`, `indexer/index.ts`), and until one of
 * them has run every read refuses the old index (ADR 019). On a 150k-chunk monorepo that is minutes of
 * silence on the next `serve`, and `pnpm up` will never mention it. Telling the user
 * before they upgrade is this command's whole job.
 */

export type InstallKind = 'local' | 'global' | 'source';
export type PackageManager = 'pnpm' | 'npm' | 'yarn';

export interface UpgradeFacts {
  readonly current: string;
  /** `null` when the registry could not be reached — never conflated with "current". */
  readonly latest: string | null;
  readonly installKind: InstallKind;
  readonly packageManager: PackageManager;
  readonly currentSchema: string;
  /** Schema recorded in the user's index, or `null` if never indexed. */
  readonly indexedSchema: string | null;
  readonly chunkCount: number | null;
  /** What of mast's hooks, rules files and skill blocks is installed here and under the user's home. */
  readonly installed: InstalledArtifacts;
}

/** Semver compare, prerelease-aware. Returns <0, 0, or >0. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: readonly number[]; pre: string } => {
    const [core = '', ...rest] = v.split('-');
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: rest.join('-') };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  // Equal cores: a prerelease sorts BEFORE its release (1.0.0-rc.1 < 1.0.0).
  if (x.pre === y.pre) return 0;
  if (x.pre === '') return 1;
  if (y.pre === '') return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Classifies how this binary was installed, from the directory it is executing out of.
 * `node_modules` under the project being indexed is a dependency; `node_modules`
 * elsewhere is a global prefix; anything else is a checkout.
 */
export function detectInstallKind(moduleDir: string, projectRoot: string): InstallKind {
  if (!moduleDir.includes('node_modules')) return 'source';
  const rel = relative(projectRoot, moduleDir);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? 'local' : 'global';
}

export function upgradeCommandFor(kind: InstallKind, pm: PackageManager): string {
  if (kind === 'source') return 'git pull && pnpm install && pnpm build';
  if (kind === 'global') {
    return pm === 'npm' ? `npm install -g ${PACKAGE_NAME}@latest`
         : pm === 'yarn' ? `yarn global add ${PACKAGE_NAME}@latest`
         : `pnpm add -g ${PACKAGE_NAME}@latest`;
  }
  return pm === 'npm' ? `npm install --save-dev ${PACKAGE_NAME}@latest`
       : pm === 'yarn' ? `yarn upgrade ${PACKAGE_NAME}@latest`
       : `pnpm up ${PACKAGE_NAME}@latest`;
}

export function buildUpgradeReport(f: UpgradeFacts): string {
  const out: string[] = [`${PACKAGE_NAME} ${f.current}`, ''];

  if (f.latest === null) {
    out.push('Could not reach the npm registry, so the latest version is unknown.',
             `When you do upgrade:  ${upgradeCommandFor(f.installKind, f.packageManager)}`, '');
  } else if (compareVersions(f.current, f.latest) >= 0) {
    out.push(`Up to date — ${f.latest} is the latest release.`, '');
  } else {
    out.push(`${f.current} → ${f.latest} available`, '',
             `  installed as:  ${f.installKind === 'local' ? 'project dependency' : f.installKind === 'global' ? 'global install' : 'source checkout'} (${f.packageManager})`,
             `  run:           ${upgradeCommandFor(f.installKind, f.packageManager)}`, '');
  }

  // The half npm cannot tell them. Only warn when there is an index to lose.
  if (f.indexedSchema !== null && f.indexedSchema !== f.currentSchema) {
    const size = f.chunkCount === null ? 'your whole project' : `${f.chunkCount.toLocaleString('en-US')} chunks`;
    out.push(
      `Your index was built under schema ${f.indexedSchema}; this build expects ${f.currentSchema}.`,
      `The next \`mast serve\` or \`mast index\` will empty it and reindex ${size} from scratch.`,
      'Until one of them has run, `mast search` and `mast query` stop with an error naming both versions.',
      'Nothing is lost that cannot be rebuilt (the index is derived state, and usage metrics are kept), but budget the time.', '');
  }
  out.push(...afterUpgradingLines(f.installed));
  return out.join('\n').trimEnd();
}

const SETUP_ORDER: readonly string[] = ['claude', 'cursor', 'vscode', 'windsurf', 'zed'];

/**
 * Hooks and rules files are written by a specific version, and this binary cannot tell what
 * the next one would write. So the report names the commands that can: `--check` exits 1 on
 * a file that differs from what the installed version would write.
 */
function afterUpgradingLines(i: InstalledArtifacts): string[] {
  const projectHarnesses = new Set<string>([...i.projectHooks, ...i.rulesHarnesses, ...(i.zedOnlyBlockFiles.length > 0 ? ['zed'] : [])]);
  const commands: string[] = [
    ...SETUP_ORDER.filter((h) => projectHarnesses.has(h)).map((h) => `  mast setup ${h} --check`),
    ...SETUP_ORDER.filter((h) => i.globalHooks.some((g) => g === h)).map((h) => `  mast setup ${h} --global --check`),
    ...(i.skillBlockFiles.length > 0 ? [`  mast skill --install        # refreshes the block in ${i.skillBlockFiles.join(', ')}`] : []),
  ];
  if (commands.length === 0) return [];
  return [
    'After upgrading, from the project root, re-check what mast installed earlier:',
    ...commands,
    'A --check that exits 1 means that file no longer matches; run the same command without --check to update it.', '',
  ];
}

/** Registry lookup, injected so tests never depend on the network. */
export type LatestVersionLookup = () => Promise<string | null>;

export const fetchLatestFromNpm: LatestVersionLookup = async () => {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json() as { version?: string }).version ?? null;
  } catch {
    // Offline, proxied, or unpublished. The report handles null honestly; a thrown
    // error here would make `mast upgrade` useless exactly when it is most wanted.
    return null;
  }
};

function detectPackageManager(): PackageManager {
  const ua = process.env['npm_config_user_agent'] ?? '';
  if (ua.startsWith('npm')) return 'npm';
  if (ua.startsWith('yarn')) return 'yarn';
  return 'pnpm';
}

export async function gatherUpgradeFacts(
  options: { path?: string; stateDir?: string; home: string },
  lookup: LatestVersionLookup = fetchLatestFromNpm,
): Promise<UpgradeFacts> {
  const config = resolveConfig({ projectRoot: options.path, stateDirOverride: options.stateDir });
  let indexedSchema: string | null = null;
  let chunkCount: number | null = null;
  try {
    const meta = JSON.parse(readFileSync(join(config.resolved_state_dir, 'index.json'), 'utf8')) as
      { schema_version?: string; chunk_count?: number };
    indexedSchema = meta.schema_version ?? null;
    chunkCount = meta.chunk_count ?? null;
  } catch {
    // No index yet — then there is nothing to warn about losing.
  }
  return {
    current: CLI_VERSION,
    latest: await lookup(),
    installKind: detectInstallKind(dirname(fileURLToPath(import.meta.url)), config.resolved_project_root),
    packageManager: detectPackageManager(),
    currentSchema: CURRENT_SCHEMA_VERSION,
    indexedSchema,
    chunkCount,
    installed: findInstalledArtifacts(config.resolved_project_root, options.home, readFileOrNull),
  };
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade [path]')
    .description('Check for a newer release and print how to install it, including any reindex it will cost and any installed hooks to re-check')
    .option('--state-dir <dir>', 'State directory')
    .action(async (path: string | undefined, opts: { stateDir?: string }) => {
      try {
        process.stdout.write(buildUpgradeReport(await gatherUpgradeFacts({ path, stateDir: opts.stateDir, home: homedir() })) + '\n');
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}
