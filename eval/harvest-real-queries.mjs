// Q1-v2 — real-query harvest from `metrics.args_json` / `metrics.results_json`.
//
// The synthetic gold sets have carried every Q1 verdict so far, and three reviews have
// shown each of them encodes its own answer (in-corpus leakage, then TSDoc self-retrieval,
// then a query-derivation function identical to the index under test). Real agent queries
// are the only source with provenance that predates the experiment. §14.3 wired
// `args_json` + `results_json` precisely so this could be measured.
//
// GROUND TRUTH WITHOUT HAND-LABELLING — the "chain" signal. A `mast_search` row records
// what it returned; a LATER row in the SAME session for `mast_signature` / `mast_exports`
// / `mast_callers` records what the agent then went and looked at. When the agent follows
// up on a file/symbol that the search returned, that is the agent itself judging the
// result relevant — a behavioural relevance label, not an author's opinion.
//
// ⚠ READ MODE MATTERS. `graph.db` runs in WAL, and a live `mast serve` may hold uncommitted
// pages in `graph.db-wal`. Opening with `immutable=1` IGNORES the WAL and silently reports
// an EMPTY metrics table — which is exactly how this harness's own operator concluded the
// write path was broken on 2026-08-02 when it was working. Always open plainly.
//
//   node eval/harvest-real-queries.mjs [state-dir] [--min-chain 1]

import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';

const stateDir = process.argv[2] ?? '.mast';
const db = new Database(`${stateDir}/graph.db`, { readonly: true, fileMustExist: true });

const rows = db.prepare(`
  SELECT tool_name, call_timestamp, session_id, args_json, results_json
  FROM metrics WHERE args_json IS NOT NULL ORDER BY session_id, call_timestamp
`).all();

const searches = rows.filter((r) => r.tool_name === 'mast_search');
const follows = rows.filter((r) => r.tool_name !== 'mast_search');

/**
 * A query is SELF-REFERENTIAL when it was issued by an agent investigating MAST itself
 * (this investigation included). Scoring such a query against MAST's own code is a new
 * flavour of the circularity that voided two earlier gold sets, so they are separated
 * out rather than silently included.
 */
function isSelfReferential(query, results) {
  const q = (query ?? '').toLowerCase();
  if (/\bmast_|args_json|chunk_fts|identifier_fts|rrf|bm25|recordToolCall/i.test(q)) return true;
  return results.length > 0 && results.every((r) => (r.file_path ?? '').includes('packages/mast/'));
}

const candidates = [];
for (const s of searches) {
  const args = JSON.parse(s.args_json);
  const results = JSON.parse(s.results_json ?? '[]');
  // Chain: same session, strictly later, targeting something this search returned.
  const chain = follows.filter((f) => {
    if (f.session_id !== s.session_id || f.call_timestamp <= s.call_timestamp) return false;
    const fa = JSON.parse(f.args_json);
    return results.some((r) =>
      (fa.symbol != null && fa.symbol === r.symbol_name) ||
      (fa.file_path != null && fa.file_path === r.file_path));
  });
  candidates.push({
    query: args.query,
    filters: { limit: args.limit ?? null, only_exported: args.only_exported ?? null,
               chunk_type: args.chunk_type ?? null, language: args.language ?? null },
    session_id: s.session_id,
    at: new Date(s.call_timestamp * 1000).toISOString(),
    returned: results,
    // Behavioural relevance labels — what the agent actually followed up on.
    relevant: chain.map((c) => { const a = JSON.parse(c.args_json);
      return { tool: c.tool_name, symbol: a.symbol ?? null, file_path: a.file_path ?? null }; }),
    chain_len: chain.length,
    self_referential: isSelfReferential(args.query, results),
  });
}

const organic = candidates.filter((c) => !c.self_referential);
const labelled = organic.filter((c) => c.chain_len >= Number(process.argv.includes('--min-chain') ? process.argv[process.argv.indexOf('--min-chain') + 1] : 1));

// Query shape — the one thing measurable at ANY n, and directly relevant to Q1: the
// synthetic sets are TSDoc-prose-derived, but §12's prompt tells agents to use code tokens.
const shape = (set) => {
  const ident = set.filter((c) => /[a-z][A-Z]|_[a-z]|\b[a-z]+[A-Z]\w*/.test(c.query)).length;
  const words = set.map((c) => (c.query.match(/\S+/g) ?? []).length);
  return { n: set.length, with_identifier_token: ident,
           median_words: words.length ? words.sort((a, b) => a - b)[Math.floor(words.length / 2)] : null };
};

const out = {
  harvested_at: new Date().toISOString(), state_dir: stateDir,
  totals: { metrics_rows_with_args: rows.length, searches: searches.length,
            self_referential: candidates.length - organic.length,
            organic: organic.length, organic_with_chain_label: labelled.length },
  power: { needed_for_80pct_at_observed_variance: 67, have: labelled.length,
           sufficient: labelled.length >= 67 },
  query_shape_all: shape(candidates),
  query_shape_organic: shape(organic),
  candidates,
};

const f = 'eval/real-query-harvest.json';
writeFileSync(f, JSON.stringify(out, null, 2));
console.log(`rows_with_args=${rows.length} searches=${searches.length} self_ref=${out.totals.self_referential} organic=${organic.length} chain_labelled=${labelled.length}`);
console.log(`POWER: have ${labelled.length} / need ~67 -> ${out.totals.organic_with_chain_label >= 67 ? 'SUFFICIENT' : 'INSUFFICIENT — Q1 cannot be resolved from this source yet'}`);
console.log(`query shape (all n=${out.query_shape_all.n}): identifier-bearing=${out.query_shape_all.with_identifier_token} median_words=${out.query_shape_all.median_words}`);
console.log(`wrote ${f}`);
db.close();
