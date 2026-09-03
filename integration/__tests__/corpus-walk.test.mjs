// The corpus file-set walk, and the drift it is here to stop.
//
// `materializeCorpus` and `prewarmCorpus` must agree on WHICH files a corpus contains. They are
// two consumers of one answer, which is S-05 territory: if prewarm walks a wider or narrower set
// than materialize, it warms the wrong files and its only symptom is that the timing confound it
// exists to remove is still there — a silent no-op that looks exactly like a working prewarm.
// So the walk is a single exported function and this file pins the two against each other.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { walkCorpusFiles, materializeCorpus, prewarmCorpus } from '../lib/project.mjs';

let root;
let dest;

/** Every file under `dir`, as relative POSIX paths, sorted. The oracle for both assertions. */
function listFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(relative(dir, abs).split(sep).join('/'));
    }
  }
  return out.sort();
}

function write(rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  root = join(tmpdir(), `mast-corpus-walk-${String(process.hrtime.bigint())}`);
  dest = `${root}-dest`;
  write('a.ts', 'export const a = 1;\n');
  write('pkg/nested/b.ts', 'export const b = 2;\n');
  write('node_modules/dep/index.js', 'module.exports = 3;\n');
  write('.git/objects/ab/cdef', 'binary-ish\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});

describe('walkCorpusFiles', () => {
  it('returns the source files and omits .git and node_modules', () => {
    const walked = walkCorpusFiles(root)
      .map((abs) => relative(root, abs).split(sep).join('/'))
      .sort();

    expect(walked).toEqual(['a.ts', 'pkg/nested/b.ts']);
  });

  it('omits symlinks, which materializeCorpus also refuses to recreate', () => {
    symlinkSync(join(root, 'a.ts'), join(root, 'link.ts'));

    const walked = walkCorpusFiles(root).map((abs) => relative(root, abs).split(sep).join('/'));

    expect(walked).not.toContain('link.ts');
  });

  it('names exactly the files materializeCorpus puts in the working copy', () => {
    symlinkSync(join(root, 'a.ts'), join(root, 'link.ts'));
    const walked = walkCorpusFiles(root)
      .map((abs) => relative(root, abs).split(sep).join('/'))
      .sort();

    materializeCorpus(root, dest);

    expect(listFiles(dest)).toEqual(walked);
  });
});

describe('prewarmCorpus', () => {
  it('reads every file the walk names', () => {
    const expected = walkCorpusFiles(root);

    const stats = prewarmCorpus(root);

    expect(stats.files).toBe(expected.length);
  });

  it('reports the bytes it actually read, so a no-op prewarm is visible in the log', () => {
    const stats = prewarmCorpus(root);

    expect(stats.bytes).toBe('export const a = 1;\n'.length + 'export const b = 2;\n'.length);
  });

  it('survives a file deleted between the walk and the read', () => {
    // A corpus is only ever read, but the cache is shared with eval and could be pruned
    // mid-run. Prewarm is an optimisation: it must never turn a runnable suite into an ERROR.
    const stats = prewarmCorpus(root, {
      onWalked: () => { rmSync(join(root, 'a.ts'), { force: true }); },
    });

    expect(stats.files).toBe(1);
  });
});

describe('the corpus fixture itself', () => {
  it('is built with the skipped directories actually present', () => {
    // Guards the tests above from passing vacuously if the fixture stops creating them.
    expect(existsSync(join(root, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(root, '.git', 'objects', 'ab', 'cdef'))).toBe(true);
  });
});
