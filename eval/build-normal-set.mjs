// Q1 — build gold-set-normal.json (the lexically-NORMAL query set).
//
// Selection is MECHANICAL by construction: candidates are harvested from the
// pinned tree's pre-existing task descriptions, shuffled by a fixed seed, and
// the first N whose cited ground truth resolves to a real corpus chunk are
// taken. The author does not choose which queries are in the set — the seed
// does. This is the counterweight to gold-set.json, whose 28 queries were (per
// its own provenance_note) "deliberately worded to minimize lexical overlap"
// and therefore can only kill vectors, never justify them (§14.3).
//
// Query text = the description with its `file.ts:NNN` citation stripped. An
// agent that already knows file:line has no reason to search; identifiers stay
// in, and that is precisely what makes these queries "normal".

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { BASE_STATE_DIR, PROJECT_ROOT, CORPUS_SHA } from './paths.mjs';

const SEED = 20260801;
const WANT = 15;
const SOURCES = [
  'packages/mast/IMPLEMENTATION_PLAN.md',
  'packages/mast/eval/GITNEXUS_COMPARISON.md',
];
const CITE = /`?([\w./-]+\.(?:ts|tsx|js|mjs))[`]?:(\d+)/g;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Strip the citation and markdown scaffolding; keep the prose + identifiers. */
function toQuery(raw) {
  return raw
    .replace(CITE, '')                       // drop the cited ground truth
    .replace(/^\s*[-|*]\s*/, '')             // list / table leader
    .replace(/\|/g, ' ')                     // table cells
    .replace(/\*\*|`|~~|←/g, '')             // md emphasis, code ticks, arrows
    .replace(/\((?:\s*[–—-]\s*)?\)/g, ' ')   // parens emptied by the strip
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[–—-]\s*$/, '')
    .trim();
}

// --- harvest + shuffle (identical to extract-normal-candidates.mjs) ---
// AMENDMENT 2026-08-01 (pre-scoring; logged in gold-set-normal.json > amendments):
// the harvest UNIT is a sentence or a table row, not a raw line. Splitting on
// lines produced mid-paragraph fragments ("both; neither exists. receiverString
// handles") because markdown prose wraps mid-sentence — grammatical debris that
// keeps rare identifiers but loses all conceptual content, which would have
// systematically favoured the lexical arm and biased Q1 toward killing vectors.
// Table rows are self-contained by construction; sentences are the right grain
// for prose. Mechanical, declared, applied before any arm was scored.
const candidates = [];
for (const src of SOURCES) {
  const abs = join(PROJECT_ROOT, src);
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, 'utf-8');

  const units = [];
  for (const line of text.split('\n')) {
    if (/^\s*\|/.test(line) && line.split('|').length >= 4) {
      units.push(line);                       // table row: already self-contained
    } else if (!/^\s*[#>`]/.test(line)) {
      units.push({ prose: line });            // prose: re-joined and split below
    }
  }
  // Re-join contiguous prose, then split into sentences.
  let buf = '';
  const flush = () => {
    if (!buf.trim()) return;
    for (const s of buf.split(/(?<=[.!?])\s+(?=[A-Z*`"'([])/)) units.push(s.trim());
    buf = '';
  };
  for (const u of units.splice(0, units.length)) {
    if (typeof u === 'string') { flush(); units.push(u); }
    else if (u.prose.trim() === '') flush();
    else buf += (buf ? ' ' : '') + u.prose.trim();
  }
  flush();

  for (const unit of units) {
    if (typeof unit !== 'string') continue;
    const cites = [...unit.matchAll(CITE)];
    if (cites.length !== 1) continue;
    if (unit.length < 60 || unit.length > 320) continue;
    const query = toQuery(unit);
    // Mechanical quality floor, declared up front: enough prose to be a query,
    // and it must read as a clause rather than a fragment (starts with a word
    // or an identifier, ends on sentence punctuation or a table cell).
    if (query.split(/\s+/).filter((w) => /[a-zA-Z]{3,}/.test(w)).length < 6) continue;
    if (!/^[A-Za-z*`([]/.test(query)) continue;
    candidates.push({
      source: src,
      query,
      citedFile: cites[0][1],
      citedLine: Number(cites[0][2]),
    });
  }
}

const rand = mulberry32(SEED);
for (let i = candidates.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
}

// --- resolve each citation against the pinned corpus ---
const db = openDatabase(BASE_STATE_DIR);
const chunks = await new SqliteChunkStore(db).getAllChunks();
await db.destroy();
if (chunks.length === 0) {
  console.error('FAIL: corpus empty — run build-corpus.mjs first.');
  process.exit(1);
}

const paths = [...new Set(chunks.map((c) => c.file_path))];
const byFile = new Map();
for (const c of chunks) {
  if (!byFile.has(c.file_path)) byFile.set(c.file_path, []);
  byFile.get(c.file_path).push(c);
}

const picked = [];
const rejected = [];
const takenTargets = new Set();
for (const cand of candidates) {
  if (picked.length >= WANT) break;
  const matches = paths.filter((p) => p === cand.citedFile || p.endsWith('/' + cand.citedFile));
  if (matches.length === 0) { rejected.push({ ...cand, reason: 'cited file not in corpus' }); continue; }
  if (matches.length > 1) { rejected.push({ ...cand, reason: `ambiguous path (${matches.length} matches)` }); continue; }
  const filePath = matches[0];
  const hit = byFile.get(filePath).find((c) => cand.citedLine >= c.start_line && cand.citedLine <= c.end_line);
  if (!hit) { rejected.push({ ...cand, reason: 'cited line falls in no chunk' }); continue; }
  // Dedup by TARGET CHUNK: several task rows cite the same location (three
  // separate rows point at `parseCallee`), and keeping them would silently
  // triple-weight whatever the arms do on that one chunk.
  if (takenTargets.has(hit.chunk_id)) { rejected.push({ ...cand, reason: 'duplicate target chunk' }); continue; }
  takenTargets.add(hit.chunk_id);
  picked.push({
    id: `n${String(picked.length + 1).padStart(2, '0')}`,
    query: cand.query,
    provenance: cand.source,
    cited: `${cand.citedFile}:${cand.citedLine}`,
    resolved_symbol: hit.symbol_name ?? `L${hit.start_line}-${hit.end_line}`,
    relevant: [{ file_path: filePath, line: cand.citedLine }],
  });
}

const out = {
  version: '1.0.0',
  created: '2026-08-01',
  purpose:
    'The lexically-NORMAL counterweight to gold-set.json for Q1 (is the vector store justified at all?). gold-set.json is anti-lexical by design and can only kill vectors, never justify them (GITNEXUS_COMPARISON.md §14.3); this set is the two-directional half.',
  corpus: { corpus_sha: CORPUS_SHA, chunks: chunks.length },
  provenance_note:
    'NOT hand-authored for this experiment. Queries are pre-existing task descriptions written by a human, for tracking work, before Q1 was designed — harvested from the PINNED tree so nothing written during the Q1 design can leak in. Each cites its own ground truth as file:NNN, which becomes the target; the citation is stripped from the query text because an agent that already knows file:line has no reason to search. Selection is mechanical: seeded shuffle, first N that resolve to a real corpus chunk. The author chose the SOURCES and the seed, not the individual queries.',
  match_rule:
    'A returned chunk is relevant iff some target has the same file_path AND target.line falls within [chunk.start_line, chunk.end_line]. Same rule as gold-set.json.',
  selection: { seed: SEED, candidates: candidates.length, picked: picked.length, rejected: rejected.length },
  amendments: [
    {
      date: '2026-08-01',
      change: 'Harvest unit changed from raw LINE to sentence-or-table-row.',
      why: 'Markdown prose wraps mid-sentence, so line-splitting produced grammatical debris ("both; neither exists. receiverString handles") that retains rare identifiers but loses all conceptual content. That would have systematically favoured the LEXICAL arm and biased Q1 toward killing vectors — i.e. the amendment corrects a bias AGAINST the incumbent subsystem, not for it.',
      made_before_any_arm_was_scored: true,
    },
    {
      date: '2026-08-01',
      change: 'Dedup by target chunk.',
      why: 'Three separate task rows cite `parseCallee`, two cite `walkProject`. Keeping them would silently multiply-weight whatever the arms do on those chunks. Affects all arms identically, but distorts the per-query average.',
      made_before_any_arm_was_scored: true,
    },
    {
      date: '2026-08-01',
      change: 'Stopping rule declared: no further instrument changes. Whatever this configuration yields is the set that gets scored.',
      why: 'Iterating on a query set until it "looks right" is how an author launders taste into an instrument. Three changes were made, all mechanical, all pre-scoring, all logged here; the rule closes the loop before any result can influence it.',
      made_before_any_arm_was_scored: true,
    },
  ],
  known_limitations: [
    'Sources are this repo\'s own mast docs, so targets skew toward packages/mast/src. Other plan docs in the tree carry no cited table rows (checked). This is home-field bias in the TARGET distribution, not in the query wording.',
    'n=15 separates tiers, not near-ties — same caveat gold-set.json carries at n=28.',
    'Cited line numbers reflect the doc author\'s tree, which may differ slightly from corpus_sha; each target was resolved to a real chunk, and resolved_symbol is recorded so a mismatch is auditable.',
  ],
  queries: picked,
};

writeFileSync(new URL('./gold-set-normal.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`picked ${picked.length}/${WANT} from ${candidates.length} candidates (seed ${SEED})\n`);
for (const p of picked) {
  console.log(`${p.id}  -> ${p.relevant[0].file_path}:${p.relevant[0].line}  [${p.resolved_symbol}]`);
  console.log(`     "${p.query}"\n`);
}
console.log(`rejected ${rejected.length}:`);
for (const r of rejected.slice(0, 12)) console.log(`  ${r.reason.padEnd(32)} ${r.citedFile}:${r.citedLine}`);
