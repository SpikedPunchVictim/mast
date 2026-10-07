// Which paths are in scope for indexing, as far as dot directories go.
//
// fast-glob skips every dot-leading entry unless a pattern names it, so a dot
// directory is walked only when `include_dot_dirs` lists it (ADR 018). The walker
// expresses that as patterns; watch mode has to answer the same question about one
// path at a time, with no glob library in hand. Both read this module so the rule
// has one statement, and `__tests__/dot-dirs.test.ts` checks the predicates against
// fast-glob's own answer on a real tree.

/** Thrown for an `include_dot_dirs` entry that cannot name a directory inside the project. */
export class InvalidDotDirError extends Error {
  constructor(entry: string, reason: string, source?: string) {
    super(
      `${source === undefined ? '' : `${source}: `}include_dot_dirs: ${JSON.stringify(entry)} ${reason}. ` +
        'Each entry is a directory path relative to the project root, such as ".agents" or "packages/app/.storybook".',
    );
    this.name = 'InvalidDotDirError';
  }
}

// The backslash is fast-glob's escape character: `.b\c` would be walked as `.bc`.
// A pipe is alternation: `.a|b` matches no directory of that name, while the
// predicates below, which compare strings, would say its files are in scope.
const GLOB_CHARACTERS = /[*?[\]{}!()|\\]/;

function isDotSegment(segment: string): boolean {
  return segment.startsWith('.');
}

/**
 * Validates and normalises `include_dot_dirs`: strips a leading `./` and trailing
 * slashes, and drops repeats. The result is what every other function here expects.
 *
 * Entries are literal paths, not globs. A glob would have to be expanded by the
 * walker and re-implemented by the watcher, and the point of an opt-in list is that
 * reading it tells you exactly which dot directories are indexed.
 *
 * @throws InvalidDotDirError for an entry that is empty, absolute, padded with
 * whitespace, leaves the project root, contains a glob character, a pipe or a backslash,
 * or has no dot-leading segment (such a directory is walked already, so listing
 * it would silently do nothing). A directory whose real name contains one of
 * those characters cannot be listed. `source`, the file the entries were read
 * from, leads the message when given.
 */
export function normalizeDotDirs(entries: readonly string[], source?: string): readonly string[] {
  const reject = (entry: string, reason: string): never => {
    throw new InvalidDotDirError(entry, reason, source);
  };
  const normalized: string[] = [];
  for (const entry of entries) {
    if (entry !== entry.trim()) reject(entry, 'has leading or trailing whitespace');
    if (entry.startsWith('/')) reject(entry, 'is an absolute path');
    if (GLOB_CHARACTERS.test(entry)) reject(entry, 'contains a glob character, a pipe or a backslash');

    const segments = entry.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0) reject(entry, 'names no directory');
    if (segments.includes('..')) reject(entry, 'leaves the project root');
    if (!segments.some(isDotSegment)) reject(entry, 'has no dot-leading segment, so it is walked already');

    const dir = segments.join('/');
    if (!normalized.includes(dir)) normalized.push(dir);
  }
  return normalized;
}

/**
 * The fast-glob patterns for a walk. Naming a dot directory in a pattern is what
 * makes fast-glob enter it; `**` after it still skips dot entries further down.
 */
export function walkPatterns(extensions: readonly string[], dotDirs: readonly string[]): string[] {
  const patterns = extensions.map((ext) => `**/*${ext}`);
  for (const dir of dotDirs) {
    for (const ext of extensions) patterns.push(`${dir}/**/*${ext}`);
  }
  return patterns;
}

function hasDotSegment(segments: readonly string[]): boolean {
  return segments.some(isDotSegment);
}

/** The part of `relativePath` below `dir`, or null when it is not below it. */
function segmentsBelow(relativePath: string, dir: string): readonly string[] | null {
  if (!relativePath.startsWith(`${dir}/`)) return null;
  return relativePath.slice(dir.length + 1).split('/');
}

/**
 * True when the dot-directory rule allows the file at `relativePath` (project-relative,
 * `/`-separated): either no segment is dot-leading, or the file sits below a named
 * dot directory with nothing dot-leading in between. Extensions and `exclude_patterns`
 * are the caller's to apply.
 */
export function isFileInDotScope(relativePath: string, dotDirs: readonly string[]): boolean {
  if (!hasDotSegment(relativePath.split('/'))) return true;
  return dotDirs.some((dir) => {
    const below = segmentsBelow(relativePath, dir);
    return below !== null && !hasDotSegment(below);
  });
}

/**
 * True when a watcher should descend into the directory at `relativePath`. Wider
 * than the file rule by one case: a parent of a named directory (`.github` for
 * `.github/workflows`) holds no in-scope file itself but is the only way down.
 */
export function isDirectoryInDotScope(relativePath: string, dotDirs: readonly string[]): boolean {
  if (isFileInDotScope(relativePath, dotDirs)) return true;
  return dotDirs.some((dir) => dir === relativePath || dir.startsWith(`${relativePath}/`));
}
