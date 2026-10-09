import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { IndexMeta } from '../ast/types.js';
import { UserError } from '../user-error.js';
import { CURRENT_SCHEMA_VERSION } from './config.js';

/**
 * What `index.json` says about the index beside it, compared with the schema
 * version this binary writes.
 *
 * - `absent`: no file. Either nothing was ever indexed, or a first index run
 *   did not finish; the stamp is the last thing a run writes.
 * - `current`: built by this schema version.
 * - `older`, `newer`: built by another one.
 * - `unreadable`: the file is there and is not a stamp (empty, cut short, or
 *   naming a version that is not three numbers).
 */
export type IndexStamp =
  | { readonly kind: 'absent' }
  | { readonly kind: 'current'; readonly meta: IndexMeta }
  | { readonly kind: 'older'; readonly meta: IndexMeta }
  | { readonly kind: 'newer'; readonly meta: IndexMeta }
  | { readonly kind: 'unreadable' };

/**
 * Thrown by an index run, and by `mast serve` at startup, over an index a
 * newer mast built. Rebuilding it would take from that mast an index this one
 * cannot replace with anything it could read (D129).
 */
export class NewerIndexError extends UserError {
  constructor(stateDir: string, indexVersion: string) {
    super(
      `the index in ${stateDir} was built by a newer mast (schema ${indexVersion}; this mast writes ` +
        `schema ${CURRENT_SCHEMA_VERSION}). Upgrade mast, or delete ${stateDir} to index again with this version.`,
    );
    this.name = 'NewerIndexError';
  }
}

/**
 * Thrown by a read (`mast query`, `mast search`, a read tool of a server) over
 * an index an older mast built. Its rows may lack what this version reads, and
 * an answer drawn from them would look like any other answer (D138).
 */
export class OlderIndexError extends UserError {
  constructor(stateDir: string, indexVersion: string) {
    super(
      `the index in ${stateDir} was built by schema ${indexVersion} and this mast reads ` +
        `schema ${CURRENT_SCHEMA_VERSION}. Run \`mast index\`, or call mast_reindex from a server, to rebuild it.`,
    );
    this.name = 'OlderIndexError';
  }
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

// Loose: a stamp written before Stage 7.2 still carries a `model` key, and a
// later version may add keys this one does not know.
const StampSchema = z.looseObject({
  schema_version: z.string().regex(VERSION),
  last_indexed: z.string().nullable().default(null),
  file_count: z.number().default(0),
  chunk_count: z.number().default(0),
  parse_errors: z.number().optional(),
  write_errors: z.number().optional(),
  seed_commit: z.string().optional(),
});

function versionParts(version: string): readonly number[] {
  const match = VERSION.exec(version);
  return match === null ? [] : match.slice(1).map(Number);
}

/** Negative when `a` is the older version, 0 when they are the same. */
function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Read and classify `index.json`. Never throws for what the file holds: a
 * crash while the stamp was being written leaves an empty or half-written
 * file, and that is a state every command has to get past (D128).
 */
export function readIndexStamp(stateDir: string): IndexStamp {
  const path = join(stateDir, 'index.json');
  if (!existsSync(path)) return { kind: 'absent' };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { kind: 'unreadable' };
  }
  const parsed = StampSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'unreadable' };

  const { schema_version, last_indexed, file_count, chunk_count, parse_errors, write_errors, seed_commit } = parsed.data;
  const meta: IndexMeta = {
    schema_version,
    last_indexed,
    file_count,
    chunk_count,
    ...(parse_errors !== undefined ? { parse_errors } : {}),
    ...(write_errors !== undefined ? { write_errors } : {}),
    ...(seed_commit !== undefined ? { seed_commit } : {}),
  };
  const order = compareVersions(schema_version, CURRENT_SCHEMA_VERSION);
  if (order === 0) return { kind: 'current', meta };
  return { kind: order < 0 ? 'older' : 'newer', meta };
}

/**
 * The one line an index run prints when it reads every file although it was
 * not asked to, or null when the stamp gives it no reason to (D129).
 *
 * @param hasFileRows whether the database already holds file rows; an absent
 * stamp over an empty database is a first index and needs no explanation.
 */
export function rebuildNotice(stamp: IndexStamp, hasFileRows: boolean): string | null {
  switch (stamp.kind) {
    case 'older':
      return (
        `the index was built by schema ${stamp.meta.schema_version} and this mast writes ` +
        `${CURRENT_SCHEMA_VERSION}: emptying it and reading every file`
      );
    case 'unreadable':
      return 'index.json could not be read: emptying the index and reading every file';
    case 'absent':
      return hasFileRows ? 'the last index run did not finish: reading every file' : null;
    case 'current':
    case 'newer':
      return null;
  }
}

/**
 * True for the stamp `markIndexCleared` leaves: another version's name over an
 * index with nothing in it. No row of that version is left to answer from.
 */
function isEmptiedForRebuild(meta: IndexMeta): boolean {
  return meta.last_indexed === null && meta.file_count === 0 && meta.chunk_count === 0;
}

/**
 * The guard every read runs before it answers from stored rows.
 *
 * An absent or unreadable stamp passes: neither names another version, and an
 * unreadable one may be a stamp caught between truncation and write by a
 * reader beside a running index. An emptied index passes too, so a server
 * that is rebuilding at startup answers with `index_empty`.
 *
 * @throws OlderIndexError over rows an older schema version wrote.
 * @throws NewerIndexError over rows a newer one wrote.
 */
export function assertIndexOfThisVersion(stateDir: string): void {
  const stamp = readIndexStamp(stateDir);
  if (stamp.kind === 'newer') throw new NewerIndexError(stateDir, stamp.meta.schema_version);
  if (stamp.kind === 'older' && !isEmptiedForRebuild(stamp.meta)) {
    throw new OlderIndexError(stateDir, stamp.meta.schema_version);
  }
}

/** The schema version that built the index, or null when the stamp does not say. */
export function stampedVersion(stamp: IndexStamp): string | null {
  return stamp.kind === 'absent' || stamp.kind === 'unreadable' ? null : stamp.meta.schema_version;
}

/**
 * Why an index is not fresh whatever its files look like, or null when the
 * stamp gives no such reason.
 */
export function stampFreshnessCause(stamp: IndexStamp): 'index_version' | 'stamp_unreadable' | null {
  if (stamp.kind === 'older' || stamp.kind === 'newer') return 'index_version';
  return stamp.kind === 'unreadable' ? 'stamp_unreadable' : null;
}
