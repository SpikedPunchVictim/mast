// Q1/SCALE — query generator (IMPLEMENTATION_PLAN.md § "Q1/SCALE ... PRE-REGISTRATION",
// "Query strata" section, including AMENDMENT 1 F6/F7/F12). Mechanical derivation only —
// read-only against T1's tier state (vscode-state-t1) and its source corpus
// (scale-corpus-t1). No search of any kind (no FTS ranking, no vectors) beyond DF
// counting, consistent with the pre-scoring hard constraint.
//
// Pool: T1's TSDoc-rich exported chunks — exported function/method/class_shell/
// interface/type chunks with a leading TSDoc block >= 80 chars, detected with the SAME
// logic as eval/vscode-tsdoc-density.mjs (leadingTsdocText, reused verbatim below).
//
// Sampling: ONE seeded shuffle (seed=153, same value as the tier seed — reused
// intentionally, documented here rather than silently coupled) of the pool, sliced
// sequentially and disjointly: [0,150) S-ident targets, [150,250) S-prose targets,
// [250,260) probe targets. Disjointness falls out of non-overlapping slices of one
// shuffle, not a separate exclusion step.
//
// Floor rule (registered): if the realized pool < 260, reduce S-prose first (floor
// 50); further reduction below that floor hits S-ident and MUST be logged as an
// amendment (this script logs it; it does not auto-amend the registration text).
//
// "Rare" content word (F7): alphabetic tokens >= 4 chars from the target's TSDoc,
// minus a fixed stopword list (below), qualifying at T1 DF <= 50 — DF computed via
// T1's OWN chunk_fts (trigram FTS5, the SAME index and MATCH mechanics hybridSearch
// uses), NOT a LIKE scan: `SELECT COUNT(*) FROM chunk_fts WHERE chunk_fts MATCH
// '"<word>"'`. This is deliberately not a crude substring LIKE — it reuses the exact
// tokenizer/matching semantics the shipped lexical arm ranks with, so "rare" means
// "rare as the production index would see it". Selection: up to 3 qualifying words,
// lowest DF first, ties broken by earliest occurrence in the TSDoc text. No qualifying
// word -> symbol name alone, logged.
//
// S-approx (F6): S-ident query with the exact symbol name replaced by
// `splitIdentifierTerms` (imported from the SHIPPED dist/search/fts.js — it IS
// exported, no replication needed), same rare-word suffix. Paired to S-ident targets;
// draws no separate pool cost.
//
// S-prose (F12): build-normal-set-r2.mjs's DERIVATION RULE only (not verbatim — that
// script hardcodes kluster targets/paths) — camelCaseSplit(symbol) + first TSDoc
// sentence, deduped, capped at 12 words, dropped if < 3 words — applied to the 100
// fresh S-prose targets sourced from T1's own corpus root.
//
//   node eval/scale-build-queries.mjs

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { splitIdentifierTerms } from '../dist/search/fts.js';

const SEED = 153; // reused from tier construction — documented, not coincidental.
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

// Fixed stopword list (F7) — committed with the generator, hashed below for provenance.
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

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- TSDoc detection: verbatim port of vscode-tsdoc-density.mjs's leadingTsdocText ---
const fileLinesCache = new Map();
function linesFor(filePath) {
  let ls = fileLinesCache.get(filePath);
  if (ls === undefined) {
    try {
      ls = readFileSync(join(T1_PROJECT_ROOT, filePath), 'utf-8').split('\n');
    } catch {
      ls = null;
    }
    fileLinesCache.set(filePath, ls);
  }
  return ls;
}

function leadingTsdocText(filePath, startLine) {
  const lines = linesFor(filePath);
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

/** First sentence of a de-commented TSDoc text block (build-normal-set-r2.mjs rule). */
function firstSentence(text) {
  const m = text.match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1] : text).trim();
}

/** `walkProject` -> "walk project"; `Foo.barBaz` -> "foo bar baz" (build-normal-set-r2.mjs rule). */
function splitIdent(name) {
  return name
    .replace(/[._]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// --- Pool: T1's TSDoc-rich exported chunks ---
const db = new Database(join(T1_STATE, 'graph.db'), { readonly: true });
const candidates = db
  .prepare(
    `SELECT chunk_id, file_path, start_line, end_line, symbol_name, parent_symbol, chunk_type
     FROM chunks
     WHERE is_exported = 1 AND chunk_type IN ('function','method','class_shell','interface','type')`,
  )
  .all();

const pool = [];
for (const c of candidates) {
  const text = leadingTsdocText(c.file_path, c.start_line);
  if (text !== null && text.length >= 80) pool.push({ ...c, tsdoc: text });
}
console.log(`[scale-queries] T1 candidates=${candidates.length} pool(tsdoc>=80char)=${pool.length} (registration expects ~472)`);

// --- DF over T1's own chunk_fts (deterministic, cached) ---
const dfCache = new Map();
function dfOf(word) {
  if (dfCache.has(word)) return dfCache.get(word);
  const expr = `"${word.replace(/"/g, '""')}"`;
  const row = db.prepare(`SELECT COUNT(*) c FROM chunk_fts WHERE chunk_fts MATCH ?`).get(expr);
  dfCache.set(word, row.c);
  return row.c;
}

/** Up to 3 rare content words from a target's TSDoc: DF <= 50, lowest DF first,
 * ties broken by earliest occurrence. Returns { words, fallbackToSymbolOnly }. */
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

// --- seeded disjoint sampling: one shuffle, sequential slices ---
const rng = mulberry32(SEED);
const shuffled = pool.map((c) => ({ c, k: rng() })).sort((a, b) => a.k - b.k).map((x) => x.c);

let wantIdent = N_S_IDENT;
let wantProse = N_S_PROSE_TARGET;
const wantProbes = N_PROBES;
const floorTriggers = [];

if (shuffled.length < wantIdent + wantProse + wantProbes) {
  console.warn(`[scale-queries] FLOOR RULE TRIGGERED: pool ${shuffled.length} < required ${wantIdent + wantProse + wantProbes}`);
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

function targetMeta(c) {
  return {
    file_path: c.file_path, start_line: c.start_line, end_line: c.end_line,
    chunk_id: c.chunk_id, chunk_type: c.chunk_type,
    symbol_name: c.symbol_name, parent_symbol: c.parent_symbol,
  };
}

// --- S-ident (+ paired S-approx) ---
const sIdent = [];
const sApprox = [];
const identSymbolOnlyFallbacks = [];
for (const t of identTargets) {
  const { words, df, fallbackToSymbolOnly } = rareWordsFor(t);
  if (fallbackToSymbolOnly) identSymbolOnlyFallbacks.push(t.chunk_id);
  const symbol = t.symbol_name ?? '';
  const identQuery = [symbol, ...words].filter(Boolean).join(' ');
  sIdent.push({ target: targetMeta(t), query: identQuery, rare_words: words, rare_words_df: df, symbol_only_fallback: fallbackToSymbolOnly });

  let splitWords = splitIdentifierTerms(symbol);
  let splitFallback = false;
  if (splitWords.length === 0) { splitWords = [symbol.toLowerCase()]; splitFallback = true; }
  const approxQuery = [...splitWords, ...words].filter(Boolean).join(' ');
  sApprox.push({ target: targetMeta(t), query: approxQuery, rare_words: words, rare_words_df: df, split_terms: splitWords, split_fallback: splitFallback });
}

// --- S-prose ---
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

// --- Probes (same construction as S-ident) ---
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

let gitHead = null;
try { gitHead = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim(); } catch { /* no commit yet */ }
let gitBranch = null;
try { gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: process.cwd() }).toString().trim(); } catch { /* n/a */ }

const out = {
  created: new Date().toISOString(),
  seed: SEED,
  pool_size: pool.length,
  pool_expected_approx: 472,
  floor_rule: {
    triggered: floorTriggers.length > 0,
    notes: floorTriggers,
    realized_n: { s_ident: identTargets.length, s_prose_attempted: proseTargets.length, probes: probeTargets.length },
  },
  strata: {
    s_ident: { n: sIdent.length, queries: sIdent },
    s_approx: { n: sApprox.length, queries: sApprox, note: 'paired 1:1 to s_ident by array index; draws no separate pool' },
    s_prose: { n: sProse.length, queries: sProse, skipped: proseSkipped, skip_reason: '<3 words after derivation (build-normal-set-r2.mjs rule)' },
    probes: { n: probes.length, queries: probes, note: 'instrument self-check only (Gate 2); excluded from scoring' },
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
  generator_provenance: {
    script: 'eval/scale-build-queries.mjs',
    git_head_at_generation: gitHead,
    git_branch_at_generation: gitBranch,
    note: 'script and this output file are committed together in the same commit',
  },
  source: { t1_state_dir: T1_STATE, t1_project_root: T1_PROJECT_ROOT },
};

writeFileSync(new URL('./scale-queries.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`[scale-queries] S-ident=${sIdent.length} S-approx=${sApprox.length} S-prose=${sProse.length} (skipped ${proseSkipped.length}) probes=${probes.length}`);
console.log(`[scale-queries] symbol-only fallbacks: s_ident=${identSymbolOnlyFallbacks.length} probes=${probeSymbolOnlyFallbacks.length}`);
console.log('wrote eval/scale-queries.json');
