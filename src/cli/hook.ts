// Entry module for `mast hook`. Run by the harness before every Grep, so everything
// reachable through its STATIC imports must be Node built-ins or repo modules that are
// themselves built-in-only (asserted by hook-import-graph.test.ts, ADR 017 section 5).
// The session-start branch loads the heavy modules with a dynamic import() instead.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_FILE_EXTENSIONS } from '../store/defaults.js';
import { resolveStateDirLight } from './hook-state-dir.js';

export type Harness = 'claude' | 'cursor' | 'vscode';
export type HookEvent = 'session-start' | 'search';

/** What the hook needs from the outside world; injected so the shell is testable. */
export interface HookIo {
  readStdin(): Promise<string>;
  write(text: string): void;
  warn(line: string): void;
  env: Record<string, string | undefined>;
  cwd(): string;
  fileExists(path: string): boolean;
  isDirectory(path: string): boolean;
  /** Same text `mast prime` prints for this project root. May be slow. */
  prime(projectRoot: string): Promise<string>;
}

export interface HookFacts {
  readonly indexExists: boolean;
  readonly primeText: string;
  /**
   * True when the search's `path` names an existing directory. A directory called
   * `next.js` or `site.io` would otherwise read as a file with an unindexed extension
   * and silence the reminder for every search under it.
   */
  readonly searchPathIsDirectory: boolean;
}

export const SEARCH_REMINDER =
  'mast: for TypeScript, JavaScript and Markdown code, try mast_search first (use code tokens such as function and type names); ' +
  'grep is still right for other languages and for exact-text regex.';

// Ripgrep type names (what Claude Code's Grep `type` takes) mapped to the extensions
// they cover. Hand-kept and deliberately small: only types that touch an indexed
// extension are listed, so any other type name reads as "scoped away from mast".
const RG_TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  ts: ['.ts', '.tsx', '.cts', '.mts'],
  js: ['.js', '.jsx', '.cjs', '.mjs'],
  md: ['.md', '.markdown'],
  markdown: ['.md', '.markdown'],
};

const INDEXED = new Set(DEFAULT_FILE_EXTENSIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHarness(value: string): value is Harness {
  return value === 'claude' || value === 'cursor' || value === 'vscode';
}

function isHookEvent(value: string): value is HookEvent {
  return value === 'session-start' || value === 'search';
}

function anyIndexed(extensions: readonly string[]): boolean {
  return extensions.some((e) => INDEXED.has(e.toLowerCase()));
}

/** A trailing `.ext` of a path segment. All-digit suffixes (`v1.2`) are versions, not extensions. */
function trailingExtension(segment: string): string | null {
  const m = /\.([A-Za-z0-9_]*[A-Za-z_][A-Za-z0-9_]*)$/.exec(segment);
  return m?.[1] === undefined ? null : `.${m[1]}`;
}

/** Extensions a glob can match, or null when they cannot be determined (`src/**`, `*.[jt]s`). */
function globExtensions(glob: string): readonly string[] | null {
  const segment = glob.slice(glob.lastIndexOf('/') + 1);
  const braces = /\.\{([^{}]*)\}$/.exec(segment);
  if (braces?.[1] !== undefined) {
    const items = braces[1].split(',').map((s) => s.trim());
    return items.every((s) => /^[A-Za-z0-9_]+$/.test(s)) ? items.map((s) => `.${s}`) : null;
  }
  const single = trailingExtension(segment);
  return single === null ? null : [single];
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' ? value : null;
}

/**
 * True when the search's own scoping fields restrict it to files mast does not index.
 * Unrecognised fields and shapes count as "not scoped": a missed reminder is cheaper
 * than a wrong one only when we know the language, and here we do not.
 */
function isScopedAwayFromIndex(input: unknown, searchPathIsDirectory: boolean): boolean {
  if (!isRecord(input) || !isRecord(input['tool_input'])) return false;
  const toolInput = input['tool_input'];

  const type = stringField(toolInput, 'type');
  if (type !== null && !anyIndexed(RG_TYPE_EXTENSIONS[type] ?? [])) return true;

  // For the Glob tool the `pattern` IS the glob; for Grep it is a regex and says nothing.
  const glob = input['tool_name'] === 'Glob' ? stringField(toolInput, 'pattern') : stringField(toolInput, 'glob');
  const globExts = glob === null ? null : globExtensions(glob);
  if (globExts !== null && !anyIndexed(globExts)) return true;

  const path = searchPathIsDirectory ? null : stringField(toolInput, 'path');
  const pathExt = path === null ? null : trailingExtension(path.slice(path.lastIndexOf('/') + 1));
  if (pathExt !== null && !anyIndexed([pathExt])) return true;

  return false;
}

function envelope(harness: Harness, event: HookEvent, text: string): object {
  if (harness === 'cursor') return { additional_context: text };
  return {
    hookSpecificOutput: {
      hookEventName: event === 'session-start' ? 'SessionStart' : 'PreToolUse',
      additionalContext: text,
    },
  };
}

/**
 * The whole decision, pure. Returns the harness's envelope, or null for "print nothing".
 * Unknown harness or event is null rather than a throw: see `runHook` for why.
 */
export function decide(harness: string, event: string, input: unknown, facts: HookFacts): object | null {
  if (!isHarness(harness) || !isHookEvent(event)) return null;
  if (event === 'session-start') return envelope(harness, event, facts.primeText);
  if (!facts.indexExists || isScopedAwayFromIndex(input, facts.searchPathIsDirectory)) return null;
  return envelope(harness, event, SEARCH_REMINDER);
}

/** `cwd`, else the first workspace root, else null (caller falls back to process cwd). */
function projectRootOf(input: Record<string, unknown>): string | null {
  if (typeof input['cwd'] === 'string' && input['cwd'] !== '') return input['cwd'];
  const roots = input['workspace_roots'];
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0] !== '') return roots[0];
  return null;
}

function searchPathOf(input: Record<string, unknown>): string | null {
  const toolInput = input['tool_input'];
  return isRecord(toolInput) ? stringField(toolInput, 'path') : null;
}

/**
 * I/O shell around `decide`.
 *
 * Never throws and never sets a failing exit code. A hook that fails breaks the user's
 * session, and anything on stdout that is not the envelope is a malformed hook response,
 * so every problem here ends as empty stdout plus one stderr line. Ordinary quiet cases
 * (no index, a search scoped to another language) say nothing at all.
 */
export async function runHook(harness: string, event: string, io: HookIo): Promise<void> {
  if (!isHarness(harness) || !isHookEvent(event)) {
    io.warn(`mast hook: unknown harness "${harness}" or event "${event}"; expected claude|cursor|vscode and session-start|search`);
    return;
  }
  try {
    const raw = await io.readStdin();
    if (raw.trim() === '') {
      io.warn('mast hook: empty stdin, expected the harness hook JSON');
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      io.warn('mast hook: stdin is not valid JSON');
      return;
    }
    if (!isRecord(input)) {
      io.warn('mast hook: stdin JSON is not an object');
      return;
    }

    const projectRoot = projectRootOf(input) ?? io.cwd();
    const searchPath = searchPathOf(input);
    const facts: HookFacts =
      event === 'session-start'
        ? { indexExists: false, primeText: await io.prime(projectRoot), searchPathIsDirectory: false }
        : {
            indexExists: io.fileExists(join(resolveStateDirLight(projectRoot, io.env), 'index.json')),
            primeText: '',
            searchPathIsDirectory: searchPath !== null && io.isDirectory(resolve(projectRoot, searchPath)),
          };

    const out = decide(harness, event, input, facts);
    if (out !== null) io.write(JSON.stringify(out));
  } catch (error) {
    io.warn(`mast hook ${harness} ${event}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readProcessStdin(): Promise<string> {
  // A TTY means someone ran the command by hand; waiting for EOF would just hang.
  if (process.stdin.isTTY) return '';
  // Streamed rather than readFileSync(0): that throws EAGAIN on some non-blocking pipes.
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

/** Production wiring, called from `cli/index.ts` and from the commander registration. */
export async function runHookFromProcess(harness: string, event: string): Promise<void> {
  await runHook(harness, event, {
    readStdin: readProcessStdin,
    write: (text) => { process.stdout.write(text); },
    warn: (line) => { process.stderr.write(`${line}\n`); },
    env: process.env,
    cwd: () => process.cwd(),
    fileExists: existsSync,
    isDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
    prime: async (projectRoot) => {
      // Dynamic so the search path never pays for them (ADR 017 section 5).
      const { buildStatus } = await import('./status.js');
      const { renderPrime, PRIME_ASSET_PATH } = await import('./prime-cmd.js');
      const status = await buildStatus({ path: projectRoot });
      return renderPrime(status, readFileSync(PRIME_ASSET_PATH, 'utf8'), new Date());
    },
  });
}
