// RESERVE-2 — second-COLUMN construction. Index builder.
//
// RESERVE-1 built a second FTS *table* and fused it via RRF; that fusion diluted the
// stronger lexical ranker and produced a significant REGRESSION. The Design Reserve
// actually specified a second *column* — one joint bm25() call, no fusion. This builds
// the tables for that reading.
//
// HARD CONSTRAINT (verified): FTS5's `tokenize=` is TABLE-level, not column-level. So a
// second column cannot keep trigram on `content` while word-tokenizing `decomposed`.
// Both columns share one tokenizer. Hence three tables, which decompose the
// tokenizer-vs-decomposition confound instead of shipping it:
//
//   tri_cd   trigram,   (content, decomposed)  -> decomposition under SHIPPED tokenization
//   uni_c    unicode61, (content)              -> the tokenizer change ALONE
//   uni_cd   unicode61, (content, decomposed)  -> decomposition on top of word tokenization
//
// PRE-DECLARED CONSTRUCTION FORK. The `decomposed` column holds ONLY the split sub-terms
// that are NOT already present as whole tokens in `content` — i.e. exactly the additional
// lexical surface decomposition provides. The alternative (mirror the full decomposed bag,
// as RESERVE-1's standalone table did) would duplicate every content token across two
// columns and inflate BM25 document length, penalising the arm for redundancy rather than
// testing decomposition. Declared before the run; the alternative is not tried afterwards.
//
//   node eval/reserve2-index.mjs <state-dir> <out-db>

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { splitTerms } from './decomp-index.mjs';

const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** The sub-terms decomposition ADDS: split parts absent from content as whole tokens. */
export function decomposedAdditions(content) {
  const whole = new Set();
  const parts = new Set();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(content)) !== null) {
    const tok = m[0];
    whole.add(tok.toLowerCase());
    for (const p of splitTerms(tok)) parts.add(p);
  }
  const added = [];
  for (const p of parts) if (!whole.has(p)) added.push(p);
  return added.join(' ');
}

const TABLES = [
  { name: 'tri_cd', cols: '(content, decomposed, chunk_id UNINDEXED', tok: "'trigram'",    decomp: true },
  { name: 'uni_c',  cols: '(content, chunk_id UNINDEXED',              tok: "'unicode61'", decomp: false },
  { name: 'uni_cd', cols: '(content, decomposed, chunk_id UNINDEXED',  tok: "'unicode61'", decomp: true },
];

export function buildReserve2Index(stateDir, outDb) {
  mkdirSync(dirname(outDb), { recursive: true });
  const src = new Database(`${stateDir}/graph.db`, { readonly: true, fileMustExist: true });
  const dst = new Database(outDb);
  dst.pragma('journal_mode = WAL');

  const rows = src.prepare('SELECT chunk_id, content FROM chunks').all();
  const counts = {};

  for (const t of TABLES) {
    dst.exec(`DROP TABLE IF EXISTS ${t.name}`);
    dst.exec(`CREATE VIRTUAL TABLE ${t.name} USING fts5${t.cols}, tokenize = ${t.tok})`);
    const ins = t.decomp
      ? dst.prepare(`INSERT INTO ${t.name}(content, decomposed, chunk_id) VALUES (?, ?, ?)`)
      : dst.prepare(`INSERT INTO ${t.name}(content, chunk_id) VALUES (?, ?)`);
    const tx = dst.transaction((all) => {
      for (const r of all) {
        if (t.decomp) ins.run(r.content, decomposedAdditions(r.content), r.chunk_id);
        else ins.run(r.content, r.chunk_id);
      }
    });
    tx(rows);
    counts[t.name] = dst.prepare(`SELECT count(*) AS n FROM ${t.name}`).get().n;
  }

  const chunkCount = src.prepare('SELECT count(*) AS n FROM chunks').get().n;
  src.close();
  dst.close();
  return { chunkCount, counts };
}

if (process.argv[1]?.endsWith('reserve2-index.mjs')) {
  const [stateDir, outDb] = process.argv.slice(2);
  const r = buildReserve2Index(stateDir, outDb);
  console.log(`chunks=${r.chunkCount} ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(' ')} -> ${outDb}`);
  for (const [k, v] of Object.entries(r.counts)) {
    if (v !== r.chunkCount) { console.error(`FAIL: ${k} partial (${v} != ${r.chunkCount})`); process.exit(1); }
  }
}
