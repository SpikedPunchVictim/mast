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
import { fileURLToPath } from 'node:url';
import { median } from './e1-schedule.mjs';

/**
 * Relative paths that together identify MAST's own source tree, wherever it sits inside
 * an indexed corpus.
 *
 * D026 — WHY A SIGNATURE AND NOT A PATH. This used to be the literal `packages/mast/`,
 * which encoded the layout of a HOST repository (kluster's monorepo) that this package
 * does not control. The 2026-08-19 eject moved the package to its own repository root;
 * the literal stopped matching anything; the path half of `isSelfReferential` went
 * silently dead, and every test stayed green because none of them asserted that the
 * literal still described the layout. Pointing the coupling at MAST's own directory
 * structure moves it to something this repo owns and a test can pin
 * (`__tests__/harvest-self-referential.test.mjs`).
 *
 * Deliberately NOT `package.json`'s `name`: the vendored copy in the pinned eval corpus
 * (`corpus-kluster` @ 07d705b) is still named `@kluster/mast`, so a name match would
 * silently miss the very corpus the harvest is most likely to be pointed at.
 */
export const MAST_SOURCE_SIGNATURE = [
  'src/indexer/index.ts',
  'src/ast/extract.ts',
  'src/graph/populate.ts',
  'src/mcp/server.ts',
  'src/store/config.ts',
];

/**
 * Locate MAST's source root within an indexed corpus, as a path prefix.
 *
 *   `''`               — MAST *is* the indexed project (dogfooding)
 *   `'packages/mast/'` — MAST is vendored at a subpath (the pinned corpus)
 *   `null`            — no MAST source in this corpus
 *
 * Requires EVERY signature path to be present and to agree on one prefix. A partial
 * match returns null rather than a guess: it is indistinguishable from a coincidence or
 * a moved layout, and "I could not locate MAST" is the honest answer to both.
 */
export function deriveMastPrefix(indexedPaths) {
  const prefixes = new Set();
  for (const sig of MAST_SOURCE_SIGNATURE) {
    const matches = indexedPaths.filter((p) => p === sig || p.endsWith(`/${sig}`));
    if (matches.length !== 1) return null;
    prefixes.add(matches[0].slice(0, matches[0].length - sig.length));
  }
  return prefixes.size === 1 ? [...prefixes][0] : null;
}

/**
 * A query is SELF-REFERENTIAL when it was issued by an agent investigating MAST itself
 * (this investigation included). Scoring such a query against MAST's own code is a new
 * flavour of the circularity that voided two earlier gold sets, so they are separated
 * out rather than silently included.
 *
 * `mastPrefix` comes from {@link deriveMastPrefix}. When it is null the corpus contains
 * no MAST source, so the path half cannot fire and only the vocabulary half applies —
 * and the caller REPORTS that, because "no MAST source here" and "the locator is stale"
 * are otherwise indistinguishable, which is the S-07 shape that produced D026.
 */
export function isSelfReferential(query, results, mastPrefix) {
  const q = (query ?? '').toLowerCase();
  if (/\bmast_|args_json|chunk_fts|identifier_fts|rrf|bm25|recordToolCall/i.test(q)) return true;
  if (mastPrefix === null || mastPrefix === undefined) return false;
  return results.length > 0 && results.every((r) => (r.file_path ?? '').startsWith(mastPrefix));
}

// Everything below runs only when this file is invoked directly (§8.3: no top-level side
// effects), so the pure classifiers above can be imported by the D026 pin.
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();

function main() {
const stateDir = process.argv[2] ?? '.mast';
const db = new Database(`${stateDir}/graph.db`, { readonly: true, fileMustExist: true });

const rows = db.prepare(`
  SELECT tool_name, call_timestamp, session_id, args_json, results_json
  FROM metrics WHERE args_json IS NOT NULL ORDER BY session_id, call_timestamp
`).all();

const searches = rows.filter((r) => r.tool_name === 'mast_search');
const follows = rows.filter((r) => r.tool_name !== 'mast_search');

const indexedPaths = db.prepare('SELECT path FROM files').all().map((r) => r.path);
const mastPrefix = deriveMastPrefix(indexedPaths);

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
    self_referential: isSelfReferential(args.query, results, mastPrefix),
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
           median_words: words.length ? median(words) : null };
};

const out = {
  harvested_at: new Date().toISOString(), state_dir: stateDir,
  totals: { metrics_rows_with_args: rows.length, searches: searches.length,
            self_referential: candidates.length - organic.length,
            organic: organic.length, organic_with_chain_label: labelled.length },
  // D026: reported, not assumed. A null prefix means the path half of the
  // self-referential filter did not run at all, which must never be silent.
  mast_locator: { prefix: mastPrefix, indexed_files: indexedPaths.length,
                  path_filter_active: mastPrefix !== null },
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
if (mastPrefix === null) {
  console.log('MAST LOCATOR: no MAST source found in this corpus — the path half of the '
    + 'self-referential filter did NOT run; only the vocabulary half applied (D026)');
} else {
  console.log(`MAST LOCATOR: mast source at '${mastPrefix || '<project root>'}' `
    + `(${indexedPaths.length} indexed files); path filter active`);
}
db.close();
}
