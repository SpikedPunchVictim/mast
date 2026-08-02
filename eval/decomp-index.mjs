// Q1 reserve arm — identifier-decomposition index builder.
//
// Builds the `decomp_fts` table the reserve arm ranks against: a unicode61
// WORD-level index in which every camelCase / acronym / snake identifier is
// additionally stored as its constituent words (`walkProject` -> `walk project`).
//
// WHY A SEPARATE DATABASE FILE. The authoritative eval state dirs hold ~45 min of
// embedding compute and are the reproduction baseline for every recorded Q1 number.
// This builder never opens them for writing — it reads `chunks` and writes to its
// own file under ~/.cache/mast-eval/decomp/.
//
// WHY BUILT FROM `chunks.content`, NOT FROM `identifier_fts`. `identifier_fts` rows
// are omitted for `doc` chunks by design (§10.1) because that index feeds
// `mast_callers` potential_matches, where a prose mention is not a call site. That
// exclusion is a call-graph concern; inheriting it here would silently shrink a
// SEARCH arm's corpus by 1,523 of 10,943 chunks for a reason unrelated to search.
//
//   node eval/decomp-index.mjs <state-dir> <out-db>

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Same token shape as `extractIdentifiers` (ast/extractors/typescript.ts:1430). */
const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Split one identifier into its constituent words, mirroring the shipped
 * `splitIdentifierTerms` (search/fts.ts:170): camelCase, acronym boundaries, and
 * snake/kebab separators, lowercased, filtered below 3 chars.
 */
export function splitTerms(token) {
  const spaced = token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const out = [];
  for (const part of spaced.split(/[^A-Za-z0-9]+/)) {
    const t = part.toLowerCase();
    if (t.length >= 3) out.push(t);
  }
  return out;
}

/**
 * The decomposed word bag for a chunk: every content token (>=3 chars) plus the
 * split parts of every token, de-duplicated.
 *
 * De-duplication flattens BM25's term-frequency component to 1 for every term, so
 * ranking here is IDF-and-coverage driven, normalised by distinct-token count. That
 * mirrors how `identifier_fts` is already built; it also means a prose chunk citing
 * many rare identifiers is a short, dense document. The harness asserts on the
 * resulting doc-chunk share rather than tuning it away.
 */
export function decomposeContent(content) {
  const seen = new Set();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(content)) !== null) {
    const tok = m[0];
    if (tok.length >= 3) seen.add(tok.toLowerCase());
    for (const part of splitTerms(tok)) seen.add(part);
  }
  return [...seen].join(' ');
}

/**
 * Turn a free-form query into the decomposed FTS5 MATCH expression: the shipped
 * `toFtsMatch` token set (>=3 chars) PLUS each token's camelCase splits, phrase
 * quoted and OR-joined. Returns null when no usable token remains.
 */
export function toDecompMatch(query) {
  const raw = query.match(/[A-Za-z0-9_]+/g) ?? [];
  const seen = new Set();
  for (const t of raw) {
    if (t.length >= 3) seen.add(t.toLowerCase());
    for (const part of splitTerms(t)) seen.add(part);
  }
  if (seen.size === 0) return null;
  return [...seen].map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** Build (or rebuild) the decomposed index for one corpus. Returns row counts. */
export function buildDecompIndex(stateDir, outDb) {
  mkdirSync(dirname(outDb), { recursive: true });
  const src = new Database(`${stateDir}/graph.db`, { readonly: true, fileMustExist: true });
  const dst = new Database(outDb);
  dst.pragma('journal_mode = WAL');
  dst.exec('DROP TABLE IF EXISTS decomp_fts');
  dst.exec(`CREATE VIRTUAL TABLE decomp_fts USING fts5(
      decomposed,
      chunk_id  UNINDEXED,
      tokenize = 'unicode61'
    )`);

  const rows = src.prepare('SELECT chunk_id, content FROM chunks').all();
  const ins = dst.prepare('INSERT INTO decomp_fts(decomposed, chunk_id) VALUES (?, ?)');
  const tx = dst.transaction((all) => {
    for (const r of all) ins.run(decomposeContent(r.content), r.chunk_id);
  });
  tx(rows);

  const chunkCount = src.prepare('SELECT count(*) AS n FROM chunks').get().n;
  const indexed = dst.prepare('SELECT count(*) AS n FROM decomp_fts').get().n;
  src.close();
  dst.close();
  return { chunkCount, indexed };
}

if (process.argv[1]?.endsWith('decomp-index.mjs')) {
  const [stateDir, outDb] = process.argv.slice(2);
  if (!stateDir || !outDb) {
    console.error('usage: node eval/decomp-index.mjs <state-dir> <out-db>');
    process.exit(1);
  }
  const r = buildDecompIndex(stateDir, outDb);
  console.log(`decomp_fts built: ${r.indexed} rows for ${r.chunkCount} chunks -> ${outDb}`);
  if (r.indexed !== r.chunkCount) {
    console.error(`FAIL: partial build (${r.indexed} != ${r.chunkCount})`);
    process.exit(1);
  }
}
