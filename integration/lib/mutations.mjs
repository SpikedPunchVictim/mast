// Filesystem mutations — the axis this harness exists for.
//
// Every mutation is a plain filesystem edit against a working copy. None of them touches the
// index: the point is always "the world changed, now what does mast believe".
import { renameSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Write to `abs` WITHOUT writing through a hardlink.
 *
 * `writeFileSync` opens the existing inode and truncates it. When the working copy was
 * materialised by hardlink — which is how a large pinned corpus is made cheap
 * (`eval/e1-common.mjs`'s `materialiseTier`: "hardlinks copy no data") — every content-writing
 * mutation would then edit the SHARED file, corrupting the cached corpus for every later run and
 * for every other scenario. The corruption outlives the process and changes nothing about the
 * exit code, which is S-01 pointed at the harness itself.
 *
 * Unlinking first breaks the link before the new content is written, so the working copy gets a
 * fresh inode and the cache keeps its own. On a copied fixture this is a no-op costing one
 * `unlink`.
 *
 * Measured both ways on 2026-08-20 rather than reasoned about: through a hardlink,
 * `writeFileSync` left the *cache* file reading `MUTATED` — the corruption is real, not
 * theoretical. Through `writeUnlinked`, `nlink` on the shared inode went 2 -> 1, the two paths
 * stopped sharing an inode, the cache kept `original`, and the working copy got `MUTATED`.
 */
function writeUnlinked(abs, content) {
  rmSync(abs, { force: true });
  writeFileSync(abs, content);
}

const MUTATIONS = {
  /** Delete a file outright. */
  deleteFile: ({ dir, spec }) => {
    const abs = join(dir, req(spec, 'file'));
    if (!existsSync(abs)) throw new Error(`deleteFile: ${spec.file} does not exist`);
    rmSync(abs);
  },

  /** Move a file. The mutation the unit suite has never performed — no test calls renameSync. */
  moveFile: ({ dir, spec }) => {
    const from = join(dir, req(spec, 'from'));
    const to = join(dir, req(spec, 'to'));
    if (!existsSync(from)) throw new Error(`moveFile: ${spec.from} does not exist`);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  },

  /**
   * Rename a file by CASE ONLY. On a case-insensitive filesystem (APFS, NTFS) a direct rename is
   * a no-op or an error, so it goes through a temporary name. This is D023's class: the importer
   * still spells the old casing, `statSync` still matches, and only the resolver's choice of
   * `realpathSync.native` keeps the resolved path agreeing with the walker's.
   */
  caseOnlyRename: ({ dir, spec }) => {
    const from = join(dir, req(spec, 'from'));
    const to = join(dir, req(spec, 'to'));
    if (!existsSync(from)) throw new Error(`caseOnlyRename: ${spec.from} does not exist`);
    if (from.toLowerCase() !== to.toLowerCase()) throw new Error(`caseOnlyRename: ${spec.from} -> ${spec.to} differs by more than case`);
    const tmp = `${from}.case-rename-tmp`;
    renameSync(from, tmp);
    renameSync(tmp, to);
  },

  /** Replace every occurrence of a symbol name across the given files. */
  renameSymbol: ({ dir, spec }) => {
    const from = req(spec, 'from');
    const to = req(spec, 'to');
    const files = req(spec, 'files');
    for (const rel of files) {
      const abs = join(dir, rel);
      const before = readFileSync(abs, 'utf8');
      const after = before.split(from).join(to);
      if (after === before) throw new Error(`renameSymbol: '${from}' does not appear in ${rel} — the mutation would assert nothing`);
      writeUnlinked(abs, after);
    }
  },

  /** Edit a file in place without touching the index. */
  editFile: ({ dir, spec }) => {
    const abs = join(dir, req(spec, 'file'));
    const before = readFileSync(abs, 'utf8');
    const after = before.split(req(spec, 'find')).join(req(spec, 'replace'));
    if (after === before) throw new Error(`editFile: '${spec.find}' does not appear in ${spec.file}`);
    writeUnlinked(abs, after);
  },

  /** Add a new file. */
  addFile: ({ dir, spec }) => {
    const abs = join(dir, req(spec, 'file'));
    mkdirSync(dirname(abs), { recursive: true });
    writeUnlinked(abs, req(spec, 'content'));
  },

  /** Restore a file from a copy taken earlier in the scenario. */
  restoreFile: ({ dir, spec, saved }) => {
    const key = req(spec, 'file');
    if (!saved.has(key)) throw new Error(`restoreFile: nothing saved for ${key} — use saveFile first`);
    const abs = join(dir, key);
    mkdirSync(dirname(abs), { recursive: true });
    writeUnlinked(abs, saved.get(key));
  },

  /** Remember a file's contents so a later restore can put it back byte for byte. */
  saveFile: ({ dir, spec, saved }) => {
    const key = req(spec, 'file');
    saved.set(key, readFileSync(join(dir, key), 'utf8'));
  },

  /** Change a file's extension so it leaves (or enters) the indexed set. */
  changeExtension: ({ dir, spec }) => {
    const from = join(dir, req(spec, 'from'));
    const to = join(dir, req(spec, 'to'));
    renameSync(from, to);
  },

  /** Move a directory aside and symlink to it — the walker skips symlinks, the resolver
   *  realpaths through them, and the two producers of a path can disagree. */
  symlinkDir: ({ dir, spec }) => {
    const real = join(dir, req(spec, 'realPath'));
    const link = join(dir, req(spec, 'linkPath'));
    cpSync(join(dir, req(spec, 'from')), real, { recursive: true });
    rmSync(join(dir, spec.from), { recursive: true, force: true });
    symlinkSync(real, link, 'dir');
  },
};

function req(spec, key) {
  const v = spec[key];
  if (v === undefined) throw new Error(`mutation '${spec.kind}' requires '${key}'`);
  return v;
}

export function knownMutations() {
  return Object.keys(MUTATIONS).sort();
}

export function applyMutation(spec, ctx) {
  const fn = MUTATIONS[spec.kind];
  if (fn === undefined) throw new Error(`unknown mutation '${spec.kind}' — known: ${knownMutations().join(', ')}`);
  fn({ ...ctx, spec });
}
