// Feasibility-spike fact-gathering: for every EXPORTED function/method/class_shell/
// interface/type chunk in vscode-state-full, detect whether it has a leading
// TSDoc/JSDoc block (a `/** ... */` comment immediately above the declaration,
// skipping blank lines) and measure its de-commented text length. Reports how
// many meet a >= 80 char threshold — the density signal the pre-registration
// needs to know whether >= 75 prose-derived queries can be mechanically sourced
// per the build-normal-set-r2.mjs protocol (query = camelCaseSplit(symbol_name)
// + first TSDoc sentence).
//
// Read-only counting against the indexed chunk metadata + raw source files.
// No search of any kind (no FTS, no vectors) — pure SQL aggregation + fs reads,
// consistent with the spike's hard constraint.
//
//   node eval/vscode-tsdoc-density.mjs <state-dir> <project-root>

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , stateDir, projectRoot] = process.argv;
if (!stateDir || !projectRoot) {
  console.error('usage: node eval/vscode-tsdoc-density.mjs <state-dir> <project-root>');
  process.exit(1);
}

const db = new Database(join(stateDir, 'graph.db'), { readonly: true });
const rows = db
  .prepare(
    `SELECT chunk_id, file_path, start_line, symbol_name, chunk_type
     FROM chunks
     WHERE is_exported = 1 AND chunk_type IN ('function','method','class_shell','interface','type')`,
  )
  .all();
db.close();

const fileLinesCache = new Map();
function linesFor(filePath) {
  let ls = fileLinesCache.get(filePath);
  if (ls === undefined) {
    try {
      ls = readFileSync(join(projectRoot, filePath), 'utf-8').split('\n');
    } catch {
      ls = null;
    }
    fileLinesCache.set(filePath, ls);
  }
  return ls;
}

/** Mirrors build-normal-set-r2.mjs's tsdocFirstSentence block detection, but
 * returns the FULL de-commented text (not just the first sentence) so we can
 * measure total length for the density threshold. */
function leadingTsdocText(filePath, startLine) {
  const lines = linesFor(filePath);
  if (!lines) return null;
  let i = startLine - 2; // 0-indexed line above the declaration
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0 || !lines[i].trim().endsWith('*/')) return '';
  const block = [];
  let sawOpen = false;
  while (i >= 0) {
    block.unshift(lines[i]);
    if (lines[i].trim().startsWith('/**')) {
      sawOpen = true;
      break;
    }
    i--;
  }
  if (!sawOpen) return ''; // ran off the top of the file without finding /**
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

let withTsdoc = 0;
let meetsThreshold = 0;
const byType = {};
const byTypeThreshold = {};
const dirWithThreshold = new Map(); // top-level dir -> count meeting threshold, for tier planning (task 7)

function topDir(filePath) {
  if (filePath.startsWith('src/vs/')) {
    const rest = filePath.slice('src/vs/'.length);
    const seg = rest.split('/')[0];
    return `src/vs/${seg}`;
  }
  return filePath.split('/')[0];
}

for (const r of rows) {
  byType[r.chunk_type] = (byType[r.chunk_type] ?? 0) + 1;
  const text = leadingTsdocText(r.file_path, r.start_line);
  if (text === null) continue; // file unreadable
  if (text.length > 0) withTsdoc++;
  if (text.length >= 80) {
    meetsThreshold++;
    byTypeThreshold[r.chunk_type] = (byTypeThreshold[r.chunk_type] ?? 0) + 1;
    const d = topDir(r.file_path);
    dirWithThreshold.set(d, (dirWithThreshold.get(d) ?? 0) + 1);
  }
}

console.log(`[tsdoc-density] candidates=${rows.length}`);
console.log(`[tsdoc-density] by_type=${JSON.stringify(byType)}`);
console.log(`[tsdoc-density] with_any_tsdoc=${withTsdoc}`);
console.log(`[tsdoc-density] meets_>=80char_threshold=${meetsThreshold}`);
console.log(`[tsdoc-density] meets_threshold_by_type=${JSON.stringify(byTypeThreshold)}`);
console.log('[tsdoc-density] meets_threshold_by_top_dir:');
for (const [d, n] of [...dirWithThreshold.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${d}: ${n}`);
}
