// Project preparation. A project is a directory of source files with a KNOWN symbol set.
//
// The default is a purpose-built fixture, not a pinned OSS clone. Every mutation assertion needs
// to know exactly which symbols exist: over a large real repository `searchMisses` breaks the
// moment a name appears anywhere else, and it appears in more places than an author expects —
// including inside the body of a surviving caller, which is how the stdout form of that
// assertion was caught being wrong before it was written.
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
