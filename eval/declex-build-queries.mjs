// Q1/DECLEX — FRESH query-set generator (IMPLEMENTATION_PLAN.md § "Q1/DECLEX
// ... PRE-REGISTRATION" + AMENDMENT 1, F-2/F-5, commit dd10796). Mechanical
// derivation + Gate F integrity checks only — read-only against T1's tier
// state (vscode-state-t1) and its source corpus (scale-corpus-t1), plus a
// read of the COMMITTED `eval/scale-queries.json` (never written to). No
// ranked search of any kind runs here (no FTS ranking via hybridSearch, no
// vectors); ranker D itself is invoked in NEITHER generation NOR the Gate F
// anchor-rate report below — the anchor rate is a STRUCTURAL string
// comparison against `chunks.symbol_name`/`parent_symbol`, matching the
// design review's own methodology ("no search/ranking/FTS operation ran",
// `eval/results/q1-declex-design-review.md:4`), consistent with the hard
// pre-scoring constraint.
//
// PROVENANCE (task instruction: reuse `scale-build-queries.mjs`'s own
// derivation rules WITHOUT importing that file — it hardcodes SEED=153, has
// no exclusion-set support, and unconditionally overwrites
// `./scale-queries.json` on import-time side effects would not even apply
// since it has no exported functions, only top-level script execution).
// Every block below marked "PROVENANCE" is a verbatim or near-verbatim port
// of the named block in `eval/scale-build-queries.mjs`; the pool-construction
// SQL, the TSDoc-detection logic, the rare-word DF rule, the S-approx/S-prose
// derivation rules, and the STOPWORDS list are all byte-identical to that
// file's own so the "same derivation rules" registration language is
// verifiably true, not just similar-in-spirit.
//
// Registered mechanics THIS file adds (AMENDMENT 1, F-5), not present in the
// parent generator:
//   1. Filter the T1 pool to EXCLUDE the 260 previously-used targets
//      (union of `eval/scale-queries.json`'s s_ident + s_prose + probes
//      chunk_ids — s_approx reuses s_ident's chunk_ids by construction, so it
//      contributes no additional exclusions) BEFORE sampling.
//   2. Shuffle the REMAINING pool with `mulberry32(154)` (the pre-registered
//      escalation seed, verified clean for reuse — registration text, F-5).
//   3. Draw sequential slices off the shuffled remainder: [0,150) S-ident
//      (S-approx paired 1:1, no separate draw — same convention as the
//      parent), [150,250) S-prose, [250,260) probes.
//   4. Write ONLY `eval/declex-queries.json` — this file never opens
//      `eval/scale-queries.json` for writing and never touches it at all
//      beyond the one read-only load of its exclusion set.
//
// Gate F (extended, AMENDMENT 1 F-2/F-5): committed pre-measurement;
// zero-overlap verification against the 260; byte-determinism (`--verify-
// determinism` CLI mode — two independent in-process derivations, hashed and
// compared); exclusion-set verification (generator's own exclusion set
// checked === the committed 260); prose-skip count; anchor-rate report
// (mechanically computed, published before any scoring).
//
//   node eval/declex-build-queries.mjs                  # generate + write eval/declex-queries.json
//   node eval/declex-build-queries.mjs --verify-determinism   # Gate F byte-determinism check (no file written)
//   node eval/declex-build-queries.mjs --help

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { splitIdentifierTerms } from '../dist/search/fts.js';
import { isEligiblePrimaryTerm } from './declex-ranker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// PROVENANCE (scale-build-queries.mjs:51-61) — same tier/pool locations,
// same registered constants, EXCEPT SEED (154, not 153 — the fresh-set
// shuffle seed, AMENDMENT 1 F-5) and N_PROBES/N_S_PROSE_TARGET/N_S_IDENT
// (same registered values, restated here so this file has no hidden
// coupling to the parent's constants).
const SEED = 154; // mulberry32(154) — the pre-registered escalation seed, reused clean (F-5).
const ROOT = join(homedir(), '.cache', 'mast-eval');
const T1_STATE = join(ROOT, 'vscode-state-t1');
const T1_PROJECT_ROOT = join(ROOT, 'scale-corpus-t1');
const MAX_S_PROSE_WORDS = 12;
const RARE_DF_CEILING = 50;
const N_S_IDENT = 150;
const N_S_PROSE_TARGET = 100;
const N_PROBES = 10;
const FLOOR_S_PROSE = 50;
const FLOOR_S_IDENT = 40;

// PROVENANCE (scale-build-queries.mjs:64-80) — byte-identical stopword list.
const STOPWORDS = [
  'this', 'that', 'these', 'those', 'with', 'from', 'when', 'then', 'into', 'only',
  'also', 'both', 'more', 'such', 'than', 'they', 'them', 'some', 'each', 'most',
  'other', 'which', 'where', 'while', 'about', 'above', 'after', 'again', 'before',
  'being', 'below', 'between', 'doing', 'during', 'further', 'having', 'itself',
  'just', 'once', 'over', 'same', 'should', 'through', 'under', 'until', 'very',
  'will', 'would', 'could', 'does', 'done', 'been', 'because', 'here', 'there',
  'what', 'whom', 'whose', 'upon', 'without', 'within', 'per', 'none', 'null',
  'undefined', 'true', 'false', 'return', 'returns', 'value', 'values', 'used',
  'uses', 'using', 'like', 'e.g', 'i.e', 'note', 'default', 'params', 'param',
  'throws', 'given', 'either', 'must', 'never', 'always', 'instead', 'rather',
  'their', 'your', 'itself', 'whether', 'called', 'calling', 'call', 'calls',
  'exist', 'exists', 'existing', 'still', 'already', 'currently', 'typically',
  'usually', 'generally', 'simply', 'directly', 'internally', 'externally',
].sort();
const stopwordSet = new Set(STOPWORDS);
const stopwordHash = createHash('sha256').update(JSON.stringify(STOPWORDS)).digest('hex');

// PROVENANCE (scale-build-queries.mjs:82-89) — identical mulberry32.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// PROVENANCE (scale-build-queries.mjs:91-129) — verbatim TSDoc-block detector.
function leadingTsdocText(fileLinesCache, filePath, startLine) {
  let lines = fileLinesCache.get(filePath);
  if (lines === undefined) {
    try {
      lines = readFileSync(join(T1_PROJECT_ROOT, filePath), 'utf-8').split('\n');
    } catch {
      lines = null;
    }
    fileLinesCache.set(filePath, lines);
  }
  if (!lines) return null;
  let i = startLine - 2;
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0 || !lines[i].trim().endsWith('*/')) return '';
  const block = [];
  let sawOpen = false;
  while (i >= 0) {
    block.unshift(lines[i]);
    if (lines[i].trim().startsWith('/**')) { sawOpen = true; break; }
    i--;
  }
  if (!sawOpen) return '';
  return block
    .join(' ')
    .replace(/\/\*\*|\*\//g, ' ')
    .replace(/^\s*\*\s?/gm, ' ')
    .replace(/\s*\*\s/g, ' ')
    .replace(/`|\{@\w+\s*|\}/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// PROVENANCE (scale-build-queries.mjs:131-146) — verbatim.
function firstSentence(text) {
  const m = text.match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1] : text).trim();
}

function splitIdent(name) {
  return name
    .replace(/[._]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function targetMeta(c) {
  return {
    file_path: c.file_path, start_line: c.start_line, end_line: c.end_line,
    chunk_id: c.chunk_id, chunk_type: c.chunk_type,
    symbol_name: c.symbol_name, parent_symbol: c.parent_symbol,
  };
}

// ---------------------------------------------------------------------------
// Anchor-rate computation (Gate F, AMENDMENT 1 F-2) — STRUCTURAL, no search.
// Reuses ranker D's own pure term-derivation + eligibility gate
// (`declex-ranker.mjs`, imported — the same source of truth the live ranker
// uses, so the anchor rate cannot silently drift from what D actually does)
// but performs the match check directly against chunk metadata already in
// hand, plus one direct existence lookup for the shell-counterpart channel
// (better-sqlite3, synchronous, the SAME connection already open on T1) —
// never by invoking searchRankerD (which would issue its own SQL against a
// live async Kysely connection; this generator is synchronous/better-sqlite3
// throughout, matching the parent's own style).
// ---------------------------------------------------------------------------

function finalDotSegment(symbolName) {
  const idx = symbolName.lastIndexOf('.');
  return idx === -1 ? symbolName : symbolName.slice(idx + 1);
}

function makeShellExistsChecker(db) {
  const stmt = db.prepare(`SELECT 1 FROM chunks WHERE chunk_type = 'class_shell' AND LOWER(symbol_name) = LOWER(?) LIMIT 1`);
  const cache = new Map();
  return (className) => {
    if (cache.has(className)) return cache.get(className);
    const exists = stmt.get(className) !== undefined;
    cache.set(className, exists);
    return exists;
  };
}

/** For one S-ident (target, query) pair: which channels (full-name, segment,
 * shell-counterpart) ranker D's PRIMARY-arm eligibility gate can reach the
 * target through. Mirrors `classifyTargetReach` (declex-ranker.mjs) in
 * spirit but computed WITHOUT running the ranker (Gate F's own "mechanically,
 * before any search" requirement). */
function computeAnchorInfo(target, query, shellExists) {
  const rawTerms = query.match(/[A-Za-z0-9_$]+/g) ?? [];
  const eligibleLower = new Set(rawTerms.filter(isEligiblePrimaryTerm).map((t) => t.toLowerCase()));

  const ownSymbol = target.symbol_name ?? '';
  const hasDot = ownSymbol.includes('.');
  const ownSegment = finalDotSegment(ownSymbol);

  const fullName = !hasDot && ownSymbol !== '' && eligibleLower.has(ownSymbol.toLowerCase());
  const segment = hasDot && eligibleLower.has(ownSegment.toLowerCase());

  let shellCounterpart = false;
  if (target.chunk_type === 'method' && target.parent_symbol) {
    shellCounterpart = eligibleLower.has(target.parent_symbol.toLowerCase()) && shellExists(target.parent_symbol);
  }

  return { full_name: fullName, segment, shell_counterpart: shellCounterpart, any: fullName || segment || shellCounterpart };
}

// ---------------------------------------------------------------------------
// Core derivation — pure w.r.t. its inputs (db handle, exclusion set, seed).
// Called twice by --verify-determinism; called once by the default (write) path.
// ---------------------------------------------------------------------------

function loadExclusionSet() {
  const scaleQueriesPath = join(__dirname, 'scale-queries.json');
  const scaleQueries = JSON.parse(readFileSync(scaleQueriesPath, 'utf8'));
  const excluded = new Set();
  for (const key of ['s_ident', 's_prose', 'probes']) {
    for (const item of scaleQueries.strata[key].queries) excluded.add(item.target.chunk_id);
  }
  return { excluded, scaleQueriesPoolSize: scaleQueries.pool_size };
}

function derive() {
  const { excluded, scaleQueriesPoolSize } = loadExclusionSet();

  const db = new Database(join(T1_STATE, 'graph.db'), { readonly: true });
  const shellExists = makeShellExistsChecker(db);

  // PROVENANCE (scale-build-queries.mjs:148-163) — identical pool query.
  const candidates = db
    .prepare(
      `SELECT chunk_id, file_path, start_line, end_line, symbol_name, parent_symbol, chunk_type
       FROM chunks
       WHERE is_exported = 1 AND chunk_type IN ('function','method','class_shell','interface','type')`,
    )
    .all();

  const fileLinesCache = new Map();
  const fullPool = [];
  for (const c of candidates) {
    const text = leadingTsdocText(fileLinesCache, c.file_path, c.start_line);
    if (text !== null && text.length >= 80) fullPool.push({ ...c, tsdoc: text });
  }

  // AMENDMENT 1, F-5 (1): filter to exclude the 260 previously-used targets.
  const remainderPool = fullPool.filter((c) => !excluded.has(c.chunk_id));
  const excludedFromPoolCount = fullPool.length - remainderPool.length;

  // PROVENANCE (scale-build-queries.mjs:165-193) — identical DF-based rare-word rule.
  const dfCache = new Map();
  function dfOf(word) {
    if (dfCache.has(word)) return dfCache.get(word);
    const expr = `"${word.replace(/"/g, '""')}"`;
    const row = db.prepare(`SELECT COUNT(*) c FROM chunk_fts WHERE chunk_fts MATCH ?`).get(expr);
    dfCache.set(word, row.c);
    return row.c;
  }
  function rareWordsFor(target) {
    const tokens = target.tsdoc.match(/[A-Za-z]{4,}/g) ?? [];
    const firstIndex = new Map();
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i].toLowerCase();
      if (stopwordSet.has(w)) continue;
      if (!firstIndex.has(w)) firstIndex.set(w, i);
    }
    const qualifying = [];
    for (const [word, idx] of firstIndex) {
      const df = dfOf(word);
      if (df <= RARE_DF_CEILING) qualifying.push({ word, df, idx });
    }
    qualifying.sort((a, b) => (a.df - b.df) || (a.idx - b.idx));
    const words = qualifying.slice(0, 3).map((q) => q.word);
    return { words, df: qualifying.slice(0, 3).map((q) => q.df), fallbackToSymbolOnly: words.length === 0 };
  }

  // AMENDMENT 1, F-5 (2)+(3): mulberry32(154) shuffle of the REMAINDER, sequential slices.
  const rng = mulberry32(SEED);
  const shuffled = remainderPool.map((c) => ({ c, k: rng() })).sort((a, b) => a.k - b.k).map((x) => x.c);

  let wantIdent = N_S_IDENT;
  let wantProse = N_S_PROSE_TARGET;
  const wantProbes = N_PROBES;
  const floorTriggers = [];

  // PROVENANCE (scale-build-queries.mjs:204-215) — identical floor rule.
  if (shuffled.length < wantIdent + wantProse + wantProbes) {
    const deficit = (wantIdent + wantProse + wantProbes) - shuffled.length;
    const proseReduction = Math.min(deficit, wantProse - FLOOR_S_PROSE);
    wantProse -= Math.max(0, proseReduction);
    floorTriggers.push(`reduced S-prose by ${proseReduction} (floor ${FLOOR_S_PROSE})`);
    const stillShort = (wantIdent + wantProse + wantProbes) - shuffled.length;
    if (stillShort > 0) {
      wantIdent = Math.max(FLOOR_S_IDENT, wantIdent - stillShort);
      floorTriggers.push(`ALSO reduced S-ident to ${wantIdent} (floor ${FLOOR_S_IDENT}) — MUST be logged as a registration amendment before scoring`);
    }
  }

  const identTargets = shuffled.slice(0, wantIdent);
  const proseTargets = shuffled.slice(wantIdent, wantIdent + wantProse);
  const probeTargets = shuffled.slice(wantIdent + wantProse, wantIdent + wantProse + wantProbes);

  // PROVENANCE (scale-build-queries.mjs:229-245) — identical S-ident/S-approx construction.
  const sIdent = [];
  const sApprox = [];
  const identSymbolOnlyFallbacks = [];
  const anchorInfos = [];
  for (const t of identTargets) {
    const { words, df, fallbackToSymbolOnly } = rareWordsFor(t);
    if (fallbackToSymbolOnly) identSymbolOnlyFallbacks.push(t.chunk_id);
    const symbol = t.symbol_name ?? '';
    const identQuery = [symbol, ...words].filter(Boolean).join(' ');
    const meta = targetMeta(t);
    sIdent.push({ target: meta, query: identQuery, rare_words: words, rare_words_df: df, symbol_only_fallback: fallbackToSymbolOnly });
    anchorInfos.push({ chunk_id: t.chunk_id, ...computeAnchorInfo(meta, identQuery, shellExists) });

    let splitWords = splitIdentifierTerms(symbol);
    let splitFallback = false;
    if (splitWords.length === 0) { splitWords = [symbol.toLowerCase()]; splitFallback = true; }
    const approxQuery = [...splitWords, ...words].filter(Boolean).join(' ');
    sApprox.push({ target: meta, query: approxQuery, rare_words: words, rare_words_df: df, split_terms: splitWords, split_fallback: splitFallback });
  }

  // PROVENANCE (scale-build-queries.mjs:248-267) — identical S-prose construction.
  const sProse = [];
  const proseSkipped = [];
  for (const t of proseTargets) {
    const symWords = splitIdent(t.symbol_name ?? '');
    const docWords = firstSentence(t.tsdoc)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const seen = new Set();
    const words = [];
    for (const w of [...symWords, ...docWords]) {
      if (w.length < 2 || seen.has(w)) continue;
      seen.add(w);
      words.push(w);
      if (words.length >= MAX_S_PROSE_WORDS) break;
    }
    if (words.length < 3) { proseSkipped.push(t.chunk_id); continue; }
    sProse.push({ target: targetMeta(t), query: words.join(' '), derived_from: t.symbol_name ?? `L${t.start_line}` });
  }

  // PROVENANCE (scale-build-queries.mjs:270-278) — identical probe construction.
  const probes = [];
  const probeSymbolOnlyFallbacks = [];
  for (const t of probeTargets) {
    const { words, df, fallbackToSymbolOnly } = rareWordsFor(t);
    if (fallbackToSymbolOnly) probeSymbolOnlyFallbacks.push(t.chunk_id);
    const symbol = t.symbol_name ?? '';
    const query = [symbol, ...words].filter(Boolean).join(' ');
    probes.push({ target: targetMeta(t), query, rare_words: words, rare_words_df: df, symbol_only_fallback: fallbackToSymbolOnly });
  }

  db.close();

  // --- Gate F: exclusion-set verification ---
  const exclusionSetVerification = {
    committed_260_size: excluded.size,
    matches_expected_260: excluded.size === 260,
    excluded_from_pool_count: excludedFromPoolCount,
    all_260_were_in_pool: excludedFromPoolCount === excluded.size,
  };

  // --- Gate F: anchor-rate report (S-ident, primary arm, mechanical) ---
  const anchorAny = anchorInfos.filter((a) => a.any).length;
  const anchorRate = {
    n: anchorInfos.length,
    any_channel_count: anchorAny,
    any_channel_rate: anchorInfos.length > 0 ? anchorAny / anchorInfos.length : null,
    full_name_count: anchorInfos.filter((a) => a.full_name).length,
    segment_count: anchorInfos.filter((a) => a.segment).length,
    shell_counterpart_count: anchorInfos.filter((a) => a.shell_counterpart).length,
    silent_chunk_ids: anchorInfos.filter((a) => !a.any).map((a) => a.chunk_id),
    expected_approx: 0.96,
    note: 'channels overlap (a target can be reachable via more than one) — per-channel counts may sum to more than any_channel_count.',
  };

  return {
    seed: SEED,
    pool_size: fullPool.length,
    scale_queries_pool_size: scaleQueriesPoolSize,
    remainder_pool_size: remainderPool.length,
    floor_rule: {
      triggered: floorTriggers.length > 0,
      notes: floorTriggers,
      realized_n: { s_ident: identTargets.length, s_prose_attempted: proseTargets.length, probes: probeTargets.length },
    },
    strata: {
      s_ident: { n: sIdent.length, queries: sIdent },
      s_approx: { n: sApprox.length, queries: sApprox, note: 'paired 1:1 to s_ident by array index; draws no separate pool' },
      s_prose: { n: sProse.length, queries: sProse, skipped: proseSkipped, skip_reason: '<3 words after derivation (build-normal-set-r2.mjs rule)' },
      probes: { n: probes.length, queries: probes, note: 'instrument self-check only (Gate A); excluded from scoring' },
    },
    rare_word_rule: {
      content_word_pattern: '[A-Za-z]{4,}',
      stopword_count: STOPWORDS.length,
      stopword_list_sha256: stopwordHash,
      df_ceiling: RARE_DF_CEILING,
      df_query: `SELECT COUNT(*) FROM chunk_fts WHERE chunk_fts MATCH '"<word>"' -- against T1's own chunk_fts (trigram FTS5)`,
      tie_break: 'lowest DF first, then earliest occurrence in the TSDoc text',
      symbol_only_fallbacks: { s_ident: identSymbolOnlyFallbacks, probes: probeSymbolOnlyFallbacks },
    },
    gate_f: {
      exclusion_set_verification: exclusionSetVerification,
      prose_skip_count: proseSkipped.length,
      anchor_rate: anchorRate,
    },
    generator_provenance: {
      script: 'eval/declex-build-queries.mjs',
      derivation_reused_from: 'eval/scale-build-queries.mjs (replicated, not imported — that file hardcodes SEED=153, has no exclusion support, unconditionally overwrites scale-queries.json)',
      excluded_target_source: 'eval/scale-queries.json (read-only; s_ident + s_prose + probes chunk_ids, s_approx reuses s_ident chunk_ids by construction)',
    },
    source: { t1_state_dir: T1_STATE, t1_project_root: T1_PROJECT_ROOT },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log('Usage:');
  console.log('  node eval/declex-build-queries.mjs                    # generate + write eval/declex-queries.json (real run, touches ~/.cache/mast-eval T1 assets)');
  console.log('  node eval/declex-build-queries.mjs --verify-determinism  # Gate F: two independent in-process derivations, hashed and compared (no file written)');
  console.log('  node eval/declex-build-queries.mjs --help');
}

function gitProvenance() {
  let gitHead = null;
  try { gitHead = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim(); } catch { /* no commit yet */ }
  let gitBranch = null;
  try { gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: process.cwd() }).toString().trim(); } catch { /* n/a */ }
  return { git_head_at_generation: gitHead, git_branch_at_generation: gitBranch };
}

function runGenerate() {
  const out = derive();
  out.generator_provenance = { ...out.generator_provenance, ...gitProvenance() };
  // NOTE: deliberately no wall-clock `created` timestamp — Gate F requires
  // two independent runs to be BYTE-IDENTICAL, which a `new Date().toISOString()`
  // field (the parent generator's own convention) would break by construction.
  const text = JSON.stringify(out, null, 2);
  writeFileSync(join(__dirname, 'declex-queries.json'), text);
  console.log(`[declex-queries] pool_size=${out.pool_size} remainder_pool_size=${out.remainder_pool_size} s_ident=${out.strata.s_ident.n} s_approx=${out.strata.s_approx.n} s_prose=${out.strata.s_prose.n} (skipped ${out.gate_f.prose_skip_count}) probes=${out.strata.probes.n}`);
  console.log(`[declex-queries] exclusion-set verification: ${JSON.stringify(out.gate_f.exclusion_set_verification)}`);
  console.log(`[declex-queries] anchor rate (S-ident, primary arm): ${(out.gate_f.anchor_rate.any_channel_rate * 100).toFixed(1)}% (${out.gate_f.anchor_rate.any_channel_count}/${out.gate_f.anchor_rate.n}), expected ~96%`);
  console.log('wrote eval/declex-queries.json');
}

function runVerifyDeterminism() {
  const run1 = derive();
  const run2 = derive();
  const text1 = JSON.stringify(run1);
  const text2 = JSON.stringify(run2);
  const hash1 = createHash('sha256').update(text1).digest('hex');
  const hash2 = createHash('sha256').update(text2).digest('hex');
  const identical = hash1 === hash2;
  console.log(`[declex-queries] run1 sha256=${hash1}`);
  console.log(`[declex-queries] run2 sha256=${hash2}`);
  console.log(`[declex-queries] GATE F byte-determinism -> ${identical ? 'PASS' : 'FAIL'}`);
  process.exit(identical ? 0 : 1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { printHelp(); process.exit(0); }
  if (args.includes('--verify-determinism')) { runVerifyDeterminism(); return; }
  runGenerate();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
