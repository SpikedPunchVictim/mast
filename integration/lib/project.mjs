// Project preparation. A project is a directory of source files with a KNOWN symbol set.
//
// The default is a purpose-built fixture, not a pinned OSS clone. Every mutation assertion needs
// to know exactly which symbols exist: over a large real repository `searchMisses` breaks the
// moment a name appears anywhere else, and it appears in more places than an author expects —
// including inside the body of a surviving caller, which is how the stdout form of that
// assertion was caught being wrong before it was written.
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, linkSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Writes a project definition's files into `dest`. */
export function materialize(project, dest) {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const [relPath, content] of Object.entries(project.files)) {
    const abs = join(dest, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dest;
}

/** Directory names never copied into a corpus working copy. `.git` is excluded on cost — the
 *  pack directory is most of the bytes and none of the source — and because the file-set oracle
 *  asks git about the CACHE, which is authoritative and unmutated, not about the working copy. */
const CORPUS_SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * Materialise a pinned corpus into `dest` as a tree of HARDLINKS at the original relative paths.
 *
 * Hardlinks copy no data, which is the only reason a 240 MB corpus per scenario is affordable —
 * the precedent is `materialiseTier` in `eval/e1-common.mjs`, which this mirrors deliberately
 * rather than reinventing.
 *
 * The safety this depends on lives in `lib/mutations.mjs`: every content-writing mutation
 * unlinks before it writes, because `writeFileSync` through a hardlink edits the SHARED inode
 * and would corrupt the cache for every later run. That was measured, not assumed, on
 * 2026-08-20. `assertCorpusUntouched` (lib/corpus.mjs) is the post-hoc check that it held.
 *
 * Falls back to a copy for any entry that cannot be linked — a cache on a different filesystem
 * from the results dir makes `linkSync` fail with EXDEV, and a slow correct run beats an ERROR.
 */
export function materializeCorpus(corpusRoot, dest) {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  let linked = 0;
  let copied = 0;
  const stack = [corpusRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        if (CORPUS_SKIP_DIRS.has(entry.name)) continue;
        stack.push(abs);
        continue;
      }
      // Symlinks are NOT followed and NOT recreated: a corpus symlink pointing outside the
      // working copy would let a mutation escape it, and the write-set guard only watches
      // inside. Recorded here because it means a symlinked-directory scenario over a corpus
      // needs its own mutation, not the corpus's own links.
      if (!entry.isFile()) continue;
      const target = join(dest, relative(corpusRoot, abs));
      mkdirSync(dirname(target), { recursive: true });
      try {
        linkSync(abs, target);
        linked++;
      } catch {
        copyFileSync(abs, target);
        copied++;
      }
    }
  }
  return { linked, copied };
}
