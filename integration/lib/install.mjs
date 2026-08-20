// Installing the artifact under test, and PROVING that is what got installed.
//
// The whole harness rests on one claim: every command it runs is the packaged binary, not the
// working tree's `dist/`. That claim is cheap to make and easy to get wrong, so it is checked
// rather than asserted — see ADR 015 §3a. Two things make it fragile here specifically:
// `dist/` is gitignored (ADR 014), and `pnpm build` can exit 0 without emitting (LEDGER D022).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec.mjs';

const PKG = '@spikedpunch/mast';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The D023 revert, applied to the INSTALLED artifact — `realpathSync.native` back to the JS
 * `realpathSync`, the exact one-word change the ledger records as making five unit tests fail.
 *
 * This exists so the harness can be shown going red. A scenario that has never been observed
 * failing is not evidence of anything, and mast has no second published version to pin against
 * (align's `expectFailOn` uses real buggy releases). Patching the installed file rather than
 * rebuilding from patched source keeps the calibration target cheap; the authenticity check
 * above runs FIRST, so what gets broken is provably our own build.
 */
const BREAKAGES = {
  // A CONSTRUCTED fault, not a ledger revert, and the run record must keep saying so: it proves
  // the harness can see THIS fault, not that any real defect of the class was ever caught. It
  // exists to calibrate the declared write-set (D041), whose FAIL branch asserts the premise
  // LEDGER.md's severity zero rests on — "mast never writes to the user's source". No shipped
  // defect has ever made mast write into an indexed project, so there is no revert to pin it
  // with; without a constructed one the branch would be enforced and never observed firing.
  'writes-into-source': {
    file: 'dist/cli/index-cmd.js',
    from: '        process.stdout.write(`files: ${result.filesIndexed} indexed',
    to: '        (await import(\'node:fs\')).writeFileSync(\'mast-stray-write.txt\', \'written into the indexed project\');\n'
      + '        process.stdout.write(`files: ${result.filesIndexed} indexed',
    why: 'CONSTRUCTED — makes `mast index` drop a file into the project root, so the declared '
       + 'write-set has an observable red. Pins: any scenario whose writeSet omits it.',
  },
  'd023-miscased-import': {
    file: 'dist/indexer/import-resolver.js',
    from: 'return realpathSync.native(path);',
    to: 'return realpathSync(path);',
    why: 'LEDGER D023 — the JS realpathSync echoes back the casing it was handed, so a mis-cased '
       + 'specifier yields a resolved_path that matches no walked file and verified_callers goes empty.',
  },
};

export function knownBreakages() {
  return Object.keys(BREAKAGES);
}

/**
 * Packs the working tree and installs the tarball into `installRoot`.
 *
 * ONE install per target per run, shared by every scenario — deliberately unlike align, which
 * installs per working copy. mast's dependency tree contains two native addons
 * (`better-sqlite3`, `tree-sitter`) whose rebuild dominates wall clock; a per-scenario install
 * would make the suite unrunnable. Scenarios still get their own project directory and their own
 * state dir, so nothing is shared that a scenario can mutate.
 */
export function installLocal(repoRoot, installRoot, { breakage, log = () => {} } = {}) {
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(join(installRoot, 'package.json'), JSON.stringify({ name: 'mast-integration-install-root', private: true, version: '0.0.0' }, null, 2));

  log('[install] pnpm build (the tarball must not carry a stale dist — D022)');
  const build = run('pnpm', ['build'], { cwd: repoRoot });
  if (build.exitCode !== 0) throw new Error(`pnpm build failed:\n${build.stdout}\n${build.stderr}`);

  log('[install] npm pack');
  const pack = run('npm', ['pack', '--pack-destination', installRoot], { cwd: repoRoot });
  if (pack.exitCode !== 0) throw new Error(`npm pack failed:\n${pack.stdout}\n${pack.stderr}`);
  const tarball = pack.stdout.trim().split('\n').pop().trim();
  const tarballPath = join(installRoot, tarball);
  if (!existsSync(tarballPath)) throw new Error(`npm pack reported '${tarball}' but ${tarballPath} does not exist`);

  log(`[install] npm install ${tarball} (native modules build here — this is the slow step)`);
  const install = run('npm', ['install', '--no-audit', '--no-fund', tarballPath], { cwd: installRoot, timeoutMs: 15 * 60 * 1000 });
  if (install.exitCode !== 0) throw new Error(`npm install of the tarball failed:\n${install.stdout}\n${install.stderr}`);

  const installedEntry = join(installRoot, 'node_modules', PKG, 'dist', 'cli', 'index.js');
  if (!existsSync(installedEntry)) {
    // The failure a missing `files` entry produces: install succeeds, binary absent.
    throw new Error(`install succeeded but ${installedEntry} is absent — check package.json "files"`);
  }

  // --- Authenticity, checked three ways. A version-string comparison is NOT sufficient: between
  // a publish and the next bump, the registry and the working tree report the same number.
  const lock = JSON.parse(readFileSync(join(installRoot, 'package-lock.json'), 'utf8'));
  // The package's OWN entry, not everything nested beneath its path. The first version of this
  // check used `includes(PKG)` and fired on
  // `node_modules/@spikedpunch/mast/node_modules/tree-sitter`, a registry-resolved TRANSITIVE
  // dependency — which is correct and expected. A guard whose condition is right for the case it
  // was written for and wrong one directory down is S-02, caught on this harness's first run.
  const entries = Object.entries(lock.packages ?? {}).filter(([k]) => k.endsWith(`node_modules/${PKG}`));
  if (entries.length === 0) throw new Error(`no ${PKG} entry in package-lock.json — cannot prove what was installed`);
  for (const [key, meta] of entries) {
    if (meta.resolved !== undefined && !meta.resolved.startsWith('file:')) {
      throw new Error(`'${key}' resolved to ${meta.resolved} — 'local' may silently be testing a REGISTRY package instead of the working tree under review`);
    }
  }
  const builtEntry = join(repoRoot, 'dist', 'cli', 'index.js');
  const installedHash = sha256(installedEntry);
  const builtHash = sha256(builtEntry);
  if (installedHash !== builtHash) {
    throw new Error(`installed dist/cli/index.js (${installedHash.slice(0, 12)}) != working tree's (${builtHash.slice(0, 12)}) — 'local' is not testing the code under review`);
  }
  log(`[install] verified: installed binary is the working tree's build (sha256 ${installedHash.slice(0, 12)})`);

  const record = { target: breakage === undefined ? 'local' : `local-broken-${breakage}`, tarball, installRoot, sha256: installedHash, breakage: null };

  if (breakage !== undefined) {
    const spec = BREAKAGES[breakage];
    if (spec === undefined) throw new Error(`unknown breakage '${breakage}' — known: ${knownBreakages().join(', ')}`);
    const target = join(installRoot, 'node_modules', PKG, spec.file);
    const before = readFileSync(target, 'utf8');
    if (!before.includes(spec.from)) {
      // The breakage no longer applies — the code it reverts has moved or been rewritten. That is
      // a calibration failure, not a scenario failure: the harness can no longer produce the red
      // it needs, and saying nothing here would leave a pinned scenario passing for the wrong
      // reason.
      throw new Error(`breakage '${breakage}' cannot be applied: '${spec.from}' not found in ${spec.file}. The code it reverts has changed — re-derive the breakage before trusting any pinned scenario.`);
    }
    writeFileSync(target, before.replace(spec.from, spec.to));
    log(`[install] DELIBERATELY BROKEN with '${breakage}': ${spec.why}`);
    record.breakage = { name: breakage, ...spec };
  }
  return record;
}

/** Every file the install root holds, for the run record. */
export function installedFileCount(installRoot) {
  let n = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).isFile()) n++;
    }
  };
  walk(join(installRoot, 'node_modules', PKG));
  return n;
}
