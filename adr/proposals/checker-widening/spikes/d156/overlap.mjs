#!/usr/bin/env node
/**
 * Spike for D156: how often `mast_callers` lists a caller as verified and again as a
 * potential match, and what would be lost by dropping the second entry.
 *
 *   node overlap.mjs <state dir> <mast repo with dist/> <out.json> [how many symbols]
 *
 * Takes the top-level names with the most stored call edges into them (one name, one
 * declaration, so the tool's answer is about one thing), asks the real tool for each
 * (`mast query mast_callers`), and for every potential match finds its chunk in the state
 * dir and asks:
 *
 *   covered     a verified caller's call line is inside the chunk
 *   of those:   on which lines the chunk mentions the name (as a word), other than the
 *               verified call lines: none; only lines where the name is followed by `(`
 *               (a further call of it, which the one edge per caller does not list); or
 *               a line where it is not (the name as a value, a type, in a comment or a
 *               string)
 *
 * The state dir is read, not written: the tool is run with MAST_STATE_DIR on a copy.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const [stateArg, mastArg, out, limitArg] = process.argv.slice(2);
if (!stateArg || !mastArg || !out) {
  console.error('usage: overlap.mjs <state dir> <mast repo with dist/> <out.json> [how many symbols]');
  process.exit(2);
}
const mast = resolve(mastArg);
const Database = createRequire(join(mast, 'package.json'))('better-sqlite3');
const work = mkdtempSync(join(tmpdir(), 'd156-'));
const state = join(work, 'state');
cpSync(resolve(stateArg), state, { recursive: true });
const db = new Database(join(state, 'graph.db'), { readonly: true });

const names = db.prepare(`
  SELECT t.name AS name, COUNT(*) AS callers
  FROM edges e JOIN symbols t ON t.id = e.to_id
  WHERE e.edge_type = 'POTENTIAL_CALL' AND instr(t.name, '.') = 0
    AND (SELECT COUNT(*) FROM symbols d WHERE d.name = t.name AND d.kind != 'export') = 1
  GROUP BY t.id ORDER BY callers DESC, t.name LIMIT ?
`).all(Number(limitArg ?? 200));
const chunkAt = db.prepare('SELECT start_line, end_line, content, symbol_name FROM chunks WHERE file_path = ? AND start_line = ?');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const totals = {
  symbols_asked: 0, verified: 0, potential: 0, potential_truncated_symbols: 0,
  potential_covered_by_a_verified_call: 0,
  covered_no_other_mention: 0, covered_only_further_calls: 0, covered_a_mention_that_is_not_a_call: 0,
  potential_not_covered_same_file_and_symbol_as_a_verified_caller: 0,
};
const samples = { covered_only_further_calls: [], covered_a_mention_that_is_not_a_call: [], not_covered_same_symbol: [] };
const perSymbol = [];

for (const { name } of names) {
  let answer;
  try {
    answer = JSON.parse(execFileSync('node', [join(mast, 'dist/cli/index.js'), 'query', 'mast_callers', JSON.stringify({ symbol: name })], {
      env: { ...process.env, MAST_STATE_DIR: state }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch { continue; }
  const verified = answer.verified_callers ?? [];
  const potential = answer.potential_matches ?? [];
  totals.symbols_asked += 1;
  totals.verified += verified.length;
  totals.potential += potential.length;
  if (answer.summary?.potential_truncated !== undefined) totals.potential_truncated_symbols += 1;
  const word = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
  const called = new RegExp(`(?<![\\w$])${escape(name)}\\s*(<[^>()]*>)?\\(`);
  let covered = 0;
  for (const p of potential) {
    const chunk = chunkAt.all(p.file_path, p.line).find((c) => (c.symbol_name ?? '') === p.context) ?? chunkAt.get(p.file_path, p.line);
    if (chunk === undefined) continue;
    const callLines = new Set(verified.filter((v) => v.file_path === p.file_path && v.line >= chunk.start_line && v.line <= chunk.end_line).map((v) => v.line));
    if (callLines.size === 0) {
      if (verified.some((v) => v.file_path === p.file_path && v.caller_symbol === p.context)) {
        totals.potential_not_covered_same_file_and_symbol_as_a_verified_caller += 1;
        if (samples.not_covered_same_symbol.length < 8) samples.not_covered_same_symbol.push(`${name}: ${p.file_path}:${p.line} ${p.context}`);
      }
      continue;
    }
    covered += 1;
    totals.potential_covered_by_a_verified_call += 1;
    const others = chunk.content.split('\n')
      .map((text, i) => ({ line: chunk.start_line + i, text }))
      .filter(({ line, text }) => !callLines.has(line) && word.test(text));
    const notCalls = others.filter(({ text }) => !called.test(text));
    const key = others.length === 0 ? 'covered_no_other_mention' : notCalls.length === 0 ? 'covered_only_further_calls' : 'covered_a_mention_that_is_not_a_call';
    totals[key] += 1;
    if (key !== 'covered_no_other_mention' && samples[key].length < 12) {
      const shown = (notCalls[0] ?? others[0]);
      samples[key].push(`${name}: ${p.file_path}:${shown.line} ${shown.text.trim().slice(0, 100)}`);
    }
  }
  perSymbol.push({ name, verified: verified.length, potential: potential.length, covered });
}
db.close();
rmSync(work, { recursive: true, force: true });
const result = { state_dir: resolve(stateArg), symbols_with_a_duplicate: perSymbol.filter((s) => s.covered > 0).length, totals, samples, per_symbol: perSymbol };
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ symbols_with_a_duplicate: result.symbols_with_a_duplicate, totals, samples }, null, 1));
