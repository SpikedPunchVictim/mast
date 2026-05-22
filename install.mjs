#!/usr/bin/env node
/**
 * MAST install script — works on macOS, Linux, and Windows.
 *
 * Usage:
 *   node install.mjs          # detect package manager automatically
 *   npm run setup             # same, via package.json script
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const MIN_NODE   = 22;

// ── Colours (disabled when stdout is not a TTY) ───────────────────────────────
const tty = process.stdout.isTTY ?? false;
const c = {
  red:    (s) => tty ? `\x1b[31m${s}\x1b[0m` : s,
  green:  (s) => tty ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: (s) => tty ? `\x1b[33m${s}\x1b[0m` : s,
  bold:   (s) => tty ? `\x1b[1m${s}\x1b[0m`  : s,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const info    = (msg) => console.log(`  ${c.bold(msg)}`);
const success = (msg) => console.log(`  ${c.green('✓')} ${msg}`);
const warn    = (msg) => console.log(`  ${c.yellow('!')} ${msg}`);
const die     = (msg) => { console.error(`\n  ${c.red('✗')} ${msg}\n`); process.exit(1); };

/**
 * Run a shell command, inheriting stdio so output is visible in real time.
 * `shell: true` is intentional — it resolves package manager shims on Windows
 * (.cmd wrappers) without us having to detect them explicitly.
 */
function run(cmd, label) {
  const result = spawnSync(cmd, { stdio: 'inherit', shell: true, cwd: SCRIPT_DIR });
  if (result.error) die(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) die(`${label} failed (exit code ${String(result.status)})`);
}

/** Probe whether a CLI tool is reachable without printing anything. */
function probe(cmd) {
  // Embed --version in the string to avoid passing a separate args array with
  // shell: true, which triggers a Node.js deprecation warning.
  return spawnSync(`${cmd} --version`, { stdio: 'ignore', shell: true }).status === 0;
}

// ── Prerequisite checks ───────────────────────────────────────────────────────
function checkNode() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE) {
    die(
      `Node.js v${MIN_NODE}+ required (found v${process.versions.node}).\n` +
      `  Update at https://nodejs.org`,
    );
  }
  success(`Node.js v${process.versions.node}`);
}

function detectPm() {
  if (probe('pnpm')) return 'pnpm';
  if (probe('npm'))  return 'npm';
  die('No package manager found. Install npm (https://nodejs.org) or pnpm (https://pnpm.io)');
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('');
console.log(`  ${c.bold('MAST — Monorepo AST Search Tool')}`);
console.log('');

checkNode();

// tree-sitter ships prebuilt addons for common platforms; node-gyp is only
// invoked as a fallback if the prebuilt doesn't match the local Node ABI.
if (!probe('python3') && !probe('cc') && !probe('cl')) {
  warn('tree-sitter may need a C++ build toolchain if no prebuilt addon matches your');
  warn('Node.js version. If the install step fails:');
  warn('  macOS: xcode-select --install');
  warn('  Linux: sudo apt-get install build-essential');
  warn('  Windows: npm install -g windows-build-tools');
  console.log('');
}

const pm = detectPm();
success(`Package manager: ${pm}`);

info('Installing dependencies...');
run(`${pm} install`, 'install');
success('Dependencies installed');

info('Building...');
run(`${pm} run build`, 'build');
success('Build complete');

info('Linking mast to global PATH...');
// npm link is used unconditionally here: it reads the `bin` field from
// package.json and creates the global shim reliably in both standalone and
// pnpm-workspace contexts. pnpm link --global skips bin entries when the
// package is already resolved as a workspace dependency.
run('npm link', 'link');
success('mast linked globally');

console.log('');
console.log(`  ${c.bold(c.green('Installation complete!'))}`);
console.log('');
console.log('  Verify:  mast --version');
console.log('');
console.log('  Next steps');
console.log('  ──────────');
console.log('  1. Initialise an index for your project:');
console.log('');
console.log('       mast init /path/to/project');
console.log('');
console.log('  2. Install git hooks to keep the index fresh on commit/checkout:');
console.log('');
console.log('       mast install-hooks /path/to/project');
console.log('');
console.log('  3. Register mast as an MCP server (e.g. Claude Desktop):');
console.log('');
console.log(`       "mcpServers": {`);
console.log(`         "mast": {`);
console.log(`           "command": "mast",`);
console.log(`           "args": ["serve"],`);
console.log(`           "env": { "MAST_STATE_DIR": "/path/to/project/.mast" }`);
console.log(`         }`);
console.log(`       }`);
console.log('');
console.log('  4. Add the following to your agent system prompt:');
console.log('');
console.log(`  ${c.yellow('┌─ copy from here ──────────────────────────────────────────────────────────┐')}`);
console.log(`  │                                                                             │`);
console.log(`  │  You have access to MAST tools for navigating this codebase. Rules:        │`);
console.log(`  │                                                                             │`);
console.log(`  │  - Call mast_status at session start to confirm the index is fresh.        │`);
console.log(`  │  - Search before opening any file. No file path without a mast result.     │`);
console.log(`  │  - Use code tokens in queries — function names, type names, column names.  │`);
console.log(`  │    "createTable uuid primaryKey" beats "migration pattern".                │`);
console.log(`  │  - Pick the right tool:                                                    │`);
console.log(`  │      mast_search           semantic + keyword discovery                    │`);
console.log(`  │      mast_signature        symbol declaration + resolved parameter types   │`);
console.log(`  │      mast_callers          who calls a function (before any refactor)      │`);
console.log(`  │      mast_implementors     which classes implement an interface            │`);
console.log(`  │      mast_exports          a module's public API without reading the file  │`);
console.log(`  │      mast_project_skeleton directory map of all exported symbols           │`);
console.log(`  │  - Call mast_reindex after writing files to keep the index current.        │`);
console.log(`  │  - When a query returns nothing, change vocabulary — don't repeat it.      │`);
console.log(`  │                                                                             │`);
console.log(`  ${c.yellow('└─────────────────────────────────────────────────────────────────────────────┘')}`);
console.log('');
