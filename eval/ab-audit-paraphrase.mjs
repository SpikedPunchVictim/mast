// Q1/OUTCOME — mandatory token-overlap audit of the S-concept paraphrases.
//
// AMENDMENT 1 #8: my original claim that S-concept authoring bias "runs toward
// vectors, so a null is conservative" was RETRACTED. `chunk_fts` uses the trigram
// tokenizer, which matches prose as readily as identifiers — so a paraphrase can
// be formally identifier-free and still lexically hot, biasing the stratum toward
// LEXICAL. The registered asymmetric reading ("no hybrid advantage even in
// S-concept is strong evidence against vectors") is CONDITIONAL on this audit.
//
// The audit does not trust the paraphraser's self-report. It recomputes overlap
// against the target chunk's FULL indexed content (not merely its identifiers)
// and weights each shared token by corpus document frequency: a shared token that
// appears in 3 chunks is a lexical handhold, one that appears in 9,000 is English.
//
//   node eval/ab-audit-paraphrase.mjs

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE = process.env.MAST_AB_STATE ?? join(homedir(), '.cache', 'mast-eval', 'ab-state');
const PARA = process.argv[2];
const RARE_DF_FRACTION = 0.01; // a token in <1% of chunks is "rare" -> a real handhold

const db = new Database(join(STATE, 'graph.db'), { readonly: true });
const tasksDoc = JSON.parse(readFileSync('./eval/ab-tasks.json', 'utf8'));
const paras = JSON.parse(readFileSync(PARA, 'utf8'));
const paraById = new Map(paras.map((p) => [p.id, p.paraphrase]));

const totalChunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
const dfStmt = db.prepare("SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH ?");
const dfCache = new Map();
function df(tok) {
  if (dfCache.has(tok)) return dfCache.get(tok);
  let n;
  try { n = dfStmt.get(`"${tok.replace(/"/g, '""')}"`).n; } catch { n = -1; }
  dfCache.set(tok, n);
  return n;
}

const tok = (s) => [...new Set((s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []))];

const report = [];
for (const t of tasksDoc.tasks.filter((x) => x.stratum === 'S-concept')) {
  const p = paraById.get(t.id);
  if (p === undefined) { console.error(`FATAL: no paraphrase for ${t.id}`); process.exit(1); }
  const ch = db.prepare('SELECT content FROM chunks WHERE file_path=? AND start_line<=? AND end_line>=? LIMIT 1')
    .get(t.target.file_path, t.target.line, t.target.line);

  const pTokens = tok(p);
  const cTokens = new Set(tok(ch.content));
  const shared = pTokens.filter((x) => cTokens.has(x));
  const scored = shared.map((x) => ({ token: x, df: df(x), frac: df(x) / totalChunks }))
    .sort((a, b) => a.df - b.df);
  const rare = scored.filter((s) => s.df >= 0 && s.frac < RARE_DF_FRACTION);

  report.push({ id: t.id, paraphrase: p, shared_count: shared.length, rare_shared: rare, all_shared: scored });
}

const flagged = report.filter((r) => r.rare_shared.length > 0);

console.log(`\n=== S-concept paraphrase overlap audit (corpus ${totalChunks} chunks) ===\n`);
for (const r of report) {
  const mark = r.rare_shared.length > 0 ? 'FLAG' : 'ok  ';
  console.log(`${mark} ${r.id}  shared=${r.shared_count}  rare=${r.rare_shared.length}`);
  console.log(`      "${r.paraphrase}"`);
  if (r.rare_shared.length > 0) {
    console.log(`      RARE SHARED: ${r.rare_shared.map((s) => `${s.token}(df=${s.df})`).join(', ')}`);
  }
}
console.log(`\nflagged: ${flagged.length}/${report.length}`);
console.log(flagged.length === 0
  ? 'AUDIT PASS — no paraphrase shares a rare token with its target chunk.\n  The registered asymmetric S-concept reading remains available.'
  : 'AUDIT FLAG — rewrite the flagged paraphrases, or the asymmetric S-concept reading is VOID.');

writeFileSync('./eval/ab-paraphrase-audit.json', JSON.stringify({
  ran_at: new Date().toISOString(), corpus_chunks: totalChunks,
  rare_df_fraction: RARE_DF_FRACTION, flagged: flagged.length, report,
}, null, 2));
console.log('wrote ./eval/ab-paraphrase-audit.json');
