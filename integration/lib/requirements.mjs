// Environment requirements a scenario can declare.
//
// A scenario that cannot run here must be SKIPPED, loudly and by name — never silently passed.
// This exists because of D023: the defect only reproduces on a case-insensitive filesystem, so
// on CI's ext4 the branch under test never executes. A green there would be evidence about
// nothing, and would read as evidence about something.
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REQUIREMENTS = {
  'case-insensitive-filesystem': () => {
    const dir = mkdtempSync(join(tmpdir(), 'mast-fs-probe-'));
    try {
      writeFileSync(join(dir, 'Probe.txt'), 'x');
      return existsSync(join(dir, 'probe.txt'))
        ? null
        : 'this filesystem is case-SENSITIVE; the behaviour under test (D023) cannot occur here';
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/** Returns null when the requirement holds (or none was declared), else a reason to skip. */
export function checkRequirement(name) {
  if (name === undefined) return null;
  const probe = REQUIREMENTS[name];
  if (probe === undefined) throw new Error(`unknown requirement '${name}' — known: ${Object.keys(REQUIREMENTS).join(', ')}`);
  return probe();
}
