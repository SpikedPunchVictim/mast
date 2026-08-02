// Q1/SCALE — tier constructor (IMPLEMENTATION_PLAN.md § "Q1/SCALE ... PRE-REGISTRATION").
//
// Builds the FROZEN tier manifest (`eval/scale-tiers.json`) that Gate 0 checks every
// tier build against. Read-only against vscode-state-full's graph.db — no search of
// any kind, pure SQL aggregation, consistent with the pre-scoring hard constraint.
//
// Construction (registered): seeded shuffle (seed=153) of the file list, prefix cuts
// at cumulative chunk counts nearest 15,000 (T1) / 50,000 (T2) / 90,000 (T3); T4 = all
// files. Cumulative chunk counts are monotonically increasing in shuffle order, so a
// larger target's cut index is always >= a smaller target's — nesting (T1 ⊂ T2 ⊂ T3 ⊂
// T4) falls out of the construction, it is not separately enforced.
//
// DEVIATION FROM THE TASK BRIEF (logged, does not affect the registration): the brief
// asserted "files with >= 1 chunk" should number exactly 8,651 (8,653 indexed − the 2
// known whale-fixture write failures). Measured directly against vscode-state-full's
// graph.db: the `files` table has 8,651 rows (consistent with the whale-failure
// accounting), but only 8,527 of those have >= 1 row in `chunks` — 124 files, not 2,
// have zero chunks. The other 122 are files that legitimately produced no extractable
// chunk (e.g. barrel `index.ts` re-exports, `.d.ts`-only files, config files) — not a
// second write-failure class. The registration's own text never claimed every indexed
// file has >= 1 chunk; it only accounted for the 14,529-chunk gap via the two whale
// files. This script uses the literal instruction — "the file list: files that have >=
// 1 chunk" — so the tier-construction population is 8,527, reported here rather than
// silently reconciled to 8,651.
//
//   node eval/scale-build-tiers.mjs

import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SEED = 153;
const VSCODE_COMMIT = '5ebbe53282bd1d5d3453405d9e6a34ee2eb7f42d';
const SOURCE_STATE_DIR = join(homedir(), '.cache', 'mast-eval', 'vscode-state-full');
const TARGETS = { T1: 15000, T2: 50000, T3: 90000 };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const db = new Database(join(SOURCE_STATE_DIR, 'graph.db'), { readonly: true });

const filesTableTotal = db.prepare('SELECT COUNT(*) c FROM files').get().c;
const totalChunks = db.prepare('SELECT COUNT(*) c FROM chunks').get().c;

// Files that have >= 1 chunk (literal task instruction), with their chunk counts.
const rows = db.prepare(`
  SELECT file_path, COUNT(*) AS chunk_count
  FROM chunks
  GROUP BY file_path
`).all();
db.close();

const distinctChunkBearingFiles = rows.length;
const chunkSum = rows.reduce((s, r) => s + r.chunk_count, 0);
if (chunkSum !== totalChunks) {
  console.error(`FATAL: chunk sum over files (${chunkSum}) != chunks table total (${totalChunks})`);
  process.exit(1);
}

console.log(`[scale-tiers] files table total          : ${filesTableTotal}`);
console.log(`[scale-tiers] files with >= 1 chunk       : ${distinctChunkBearingFiles} (expected-by-brief 8651; see logged deviation in this file's header)`);
console.log(`[scale-tiers] total chunks                : ${totalChunks}`);

// --- seeded shuffle ---
const rng = mulberry32(SEED);
const shuffled = rows
  .map((r) => ({ r, k: rng() }))
  .sort((a, b) => a.k - b.k)
  .map((x) => x.r);

// --- prefix cumulative sums ---
const prefixChunks = new Array(shuffled.length);
let running = 0;
for (let i = 0; i < shuffled.length; i++) {
  running += shuffled[i].chunk_count;
  prefixChunks[i] = running;
}
if (running !== totalChunks) {
  console.error(`FATAL: final cumulative sum (${running}) != total chunks (${totalChunks})`);
  process.exit(1);
}

/**
 * Prefix length (1-indexed file count) whose cumulative chunk count is nearest
 * `target`. Tie-break: earliest (smallest) index — i.e. prefer not overshooting on
 * an exact tie. Deterministic given `prefixChunks`.
 */
function nearestCutIndex(target) {
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < prefixChunks.length; i++) {
    const diff = Math.abs(prefixChunks[i] - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx; // 0-indexed; prefix is shuffled[0..bestIdx] inclusive
}

const cutT1 = nearestCutIndex(TARGETS.T1);
const cutT2 = nearestCutIndex(TARGETS.T2);
const cutT3 = nearestCutIndex(TARGETS.T3);

if (!(cutT1 <= cutT2 && cutT2 <= cutT3 && cutT3 < shuffled.length)) {
  console.error('FATAL: nearest-cut indices are not monotonically nested — nesting invariant violated.');
  console.error(`  cutT1=${cutT1} cutT2=${cutT2} cutT3=${cutT3} n=${shuffled.length}`);
  process.exit(1);
}

function tierManifest(cutIdx) {
  const files = shuffled.slice(0, cutIdx + 1).map((r) => r.file_path);
  return {
    file_count: files.length,
    chunk_count: prefixChunks[cutIdx],
    files,
  };
}

const tiers = {
  T1: tierManifest(cutT1),
  T2: tierManifest(cutT2),
  T3: tierManifest(cutT3),
  T4: {
    file_count: shuffled.length,
    chunk_count: totalChunks,
    files: shuffled.map((r) => r.file_path),
  },
};

for (const [name, t] of Object.entries(tiers)) {
  const target = TARGETS[name] ?? totalChunks;
  console.log(`[scale-tiers] ${name}: files=${t.file_count} chunks=${t.chunk_count} (target ${target}, diff ${t.chunk_count - target})`);
}

// Nesting sanity: every smaller tier's file set must be a subset of every larger one.
for (const [smaller, larger] of [['T1', 'T2'], ['T2', 'T3'], ['T3', 'T4']]) {
  const bigSet = new Set(tiers[larger].files);
  const missing = tiers[smaller].files.filter((f) => !bigSet.has(f));
  if (missing.length > 0) {
    console.error(`FATAL: ${smaller} is not a subset of ${larger}; ${missing.length} files missing.`);
    process.exit(1);
  }
}

const manifest = {
  created: new Date().toISOString(),
  seed: SEED,
  vscode_commit: VSCODE_COMMIT,
  source_state_dir: SOURCE_STATE_DIR,
  targets: TARGETS,
  population: {
    files_table_total: filesTableTotal,
    files_with_ge1_chunk: distinctChunkBearingFiles,
    total_chunks: totalChunks,
    note:
      'Tier construction uses files with >= 1 chunk (8,527 measured), not the files-table ' +
      'total (8,651) — see the logged deviation in this script\'s header comment. The 124-file ' +
      'gap is 122 legitimately chunkless files plus the 2 known whale-fixture write failures.',
  },
  cut_rule: 'prefix length minimizing |cumulative_chunk_count - target|, ties broken toward the smaller (earlier) index',
  tiers,
};

writeFileSync(new URL('./scale-tiers.json', import.meta.url), JSON.stringify(manifest, null, 2));
console.log('\nwrote eval/scale-tiers.json');
