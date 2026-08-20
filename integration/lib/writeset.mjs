// Declared write-sets — the discipline ADR 015 §1 said was "carried over unchanged" from align
// and which, until now, was carried over in name only: `writeSet` was accepted by
// `spec-validate.mjs`'s key allowlist and read by nothing (LEDGER D041).
//
// WHY THIS IS NOT BOOKKEEPING. `docs/defects/LEDGER.md` states this package's severity zero on
// the premise that "`mast` never writes to the user's source; its state lives in its own
// `graph.db`". That is a claim about behaviour, and this repo's standing rule is that a comment
// asserting a property is a claim to verify, not evidence that it holds. Nothing verified it.
// A write-set turns it into a universal, always-on assertion: every scenario declares the paths
// it will disturb, and ANY other change under the working copy is caught. The most likely author
// of an undeclared change is mast itself.
//
// FAIL vs ERROR, which this module deliberately does not decide. An undeclared change after a
// `mutate` step means the SCENARIO mis-declared its own writes — a statement about the harness,
// so ERROR. An undeclared change after a `run` or `mcpCall` step means MAST wrote into the
// indexed project — a statement about mast, so FAIL. The caller knows which step it just ran;
// this module only reports what moved.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Directory names never walked. `.mast` is the state dir — mast rewrites it on every command by
 * design, so including it would make every step report thousands of changes and the guard would
 * be turned off within a day. `node_modules` and `.git` are excluded for cost: a clone-family
 * corpus carries ~26k tracked files plus a pack directory, and neither is source the scenarios
 * reason about.
 *
 * This is the guard's boundary, stated rather than buried: writes INTO the state dir are not
 * checked here, and never will be by this mechanism.
 */
const UNWALKED_DIRS = new Set(['.mast', '.git', 'node_modules']);

/**
 * A cheap per-file signature: size and mtime in milliseconds. NOT a content hash — hashing 26k
 * files on every step would cost more than the scenarios do, and the failure this guards is a
 * write, which moves mtime. A write that restores byte-identical content AND replays the
 * original mtime would evade it; that is a deliberate, named limit, not an oversight.
 *
 * `mtimeMs` is a float on some filesystems, so it is stringified rather than compared numerically.
 */
function signature(st) {
  return `${st.size}:${st.mtimeMs}`;
}

/** Walk `dir` and return `Map<relativePath, signature>`. Symlinks are recorded, never followed —
 *  a symlinked directory is a scenario subject (the PLAN's `symlinked-directory` family), and
 *  following one would double-count its target or loop. */
export function snapshotTree(dir) {
  const out = new Map();
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // A directory that vanished between readdir and here is itself a change; the diff sees it
      // as a removal of everything under it, which is the right answer.
      continue;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        if (UNWALKED_DIRS.has(entry.name)) continue;
        stack.push(abs);
        continue;
      }
      try {
        // lstat, not stat: a symlink's own identity is what changed if it was repointed.
        out.set(relative(dir, abs), signature(statSync(abs, { throwIfNoEntry: true, bigint: false })));
      } catch {
        // Broken symlink or a race with a delete — record it as present-but-unstattable so it
        // still participates in the diff rather than silently dropping out of both snapshots.
        out.set(relative(dir, abs), 'unstattable');
      }
    }
  }
  return out;
}

/** Added / modified / removed, as sorted relative paths. */
export function diffSnapshots(before, after) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const [path, sig] of after) {
    const prior = before.get(path);
    if (prior === undefined) added.push(path);
    else if (prior !== sig) modified.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}

/**
 * Does `declared` cover `path`?
 *
 * Two forms only, and no glob engine: an exact relative path, or a subtree written `dir/**`.
 * A closed, boring vocabulary is deliberate — `globToLike` and `globToRegex` between them
 * produced three S0s in one day (D031-D033) by making a pattern mean something other than it
 * read, and a write-set that quietly matches more than its author intended fails open, which is
 * the one direction this guard must never fail.
 */
export function isDeclared(path, declared) {
  for (const entry of declared) {
    if (entry === path) return true;
    if (entry.endsWith('/**')) {
      const prefix = entry.slice(0, -2); // keep the trailing '/'
      if (path.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Every changed path not covered by the declaration, tagged with how it changed. Returns `[]`
 * when the declaration covers everything — including when nothing changed at all.
 */
export function undeclaredWrites(diff, declared) {
  const out = [];
  for (const [kind, paths] of [['added', diff.added], ['modified', diff.modified], ['removed', diff.removed]]) {
    for (const path of paths) {
      if (!isDeclared(path, declared)) out.push(`${kind}: ${path}`);
    }
  }
  return out;
}

/** Reject a declaration that cannot mean what it looks like, at load time rather than mid-run. */
export function validateWriteSetEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0) return `must be a non-empty string`;
  if (entry.startsWith('/')) return `'${entry}' is absolute — write-set paths are relative to the working copy`;
  if (entry.split('/').includes('..')) return `'${entry}' escapes the working copy via '..'`;
  if (entry.includes('\\')) return `'${entry}' uses a backslash — write-set paths always use '/'`;
  if (entry.includes('*') && !entry.endsWith('/**')) {
    return `'${entry}' uses '*' somewhere other than a trailing '/**' — the only two forms are an exact path and a 'dir/**' subtree`;
  }
  if (entry.startsWith('.mast/') || entry === '.mast') {
    return `'${entry}' names the state dir, which this guard never walks — declaring it asserts nothing`;
  }
  return null;
}

/** Relative paths in this module always use '/', so a Windows `sep` would silently break
 *  `isDeclared`. Named here so the assumption is visible if the harness ever runs there. */
export const PATH_SEPARATOR_ASSUMPTION = sep;
