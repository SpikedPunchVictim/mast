// Project preparation. A project is a directory of source files with a KNOWN symbol set.
//
// The default is a purpose-built fixture, not a pinned OSS clone. Every mutation assertion needs
// to know exactly which symbols exist: over a large real repository `searchMisses` breaks the
// moment a name appears anywhere else, and it appears in more places than an author expects —
// including inside the body of a surviving caller, which is how the stdout form of that
// assertion was caught being wrong before it was written.
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, linkSync, copyFileSync, readFileSync } from 'node:fs';
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
  for (const abs of walkCorpusFiles(corpusRoot)) {
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
  return { linked, copied };
}

/**
 * Every file a corpus working copy will contain, as absolute paths under `corpusRoot`.
 *
 * Extracted so `materializeCorpus` and `prewarmCorpus` cannot disagree about what a corpus
 * contains. They are two consumers of one answer (S-05), and a prewarm that walked a different
 * set than materialize would still log a plausible file count while warming the wrong inodes —
 * a no-op indistinguishable from success. `__tests__/corpus-walk.test.mjs` pins them together.
 *
 * Symlinks are NOT followed and NOT recreated: a corpus symlink pointing outside the working
 * copy would let a mutation escape it, and the write-set guard only watches inside. Recorded
 * here because it means a symlinked-directory scenario over a corpus needs its own mutation,
 * not the corpus's own links.
 */
export function walkCorpusFiles(corpusRoot) {
  const files = [];
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
      if (!entry.isFile()) continue;
      files.push(abs);
    }
  }
  return files;
}

/**
 * Read every file of a corpus once, so the OS page cache is warm before any timed step runs.
 *
 * This exists because of D051. The corpus is hardlinked into each working copy, so all targets
 * share the cache's inodes — and the FIRST target therefore pays the whole cost of faulting a
 * 26321-file corpus in from disk inside a step governed by `exec.mjs`'s timeout, while every
 * later target reads it warm. Measured: >300s (timeout, ERROR) in position one against 83s in
 * position three, same scenario, same code. Arm order became part of what the gate measured,
 * which is S-08.
 *
 * It is deliberately NOT `mast index`: the point is to warm the page cache, and running the
 * artifact under test as a setup step would make the harness's own preparation depend on the
 * thing it is trying to judge. Reading the bytes is what populates the cache; parser and JIT
 * warmth do not survive across the fresh process each step spawns anyway.
 *
 * @param onWalked test seam — invoked after the walk, before the reads.
 * @returns `{ files, bytes, ms }` — `files` counts what was actually READ, not what was walked,
 *   so a prewarm that silently read nothing is visible in the run log rather than inferred.
 */
export function prewarmCorpus(corpusRoot, { onWalked } = {}) {
  const started = Date.now();
  const walked = walkCorpusFiles(corpusRoot);
  if (onWalked !== undefined) onWalked();
  let files = 0;
  let bytes = 0;
  for (const abs of walked) {
    try {
      bytes += readFileSync(abs).byteLength;
      files++;
    } catch {
      // Prewarm is an optimisation and must never be the reason a runnable suite ERRORs. The
      // cache is shared with eval and can be pruned mid-run; a file that vanished between the
      // walk and the read is simply one this run does not get warmed.
    }
  }
  return { files, bytes, ms: Date.now() - started };
}
