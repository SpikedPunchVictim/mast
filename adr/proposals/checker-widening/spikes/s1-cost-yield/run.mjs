#!/usr/bin/env node
/**
 * Spike s1 for the widened `--checker` proposal: what a pass over every tsconfig project
 * costs, and how many call pairs it has that the stored graph lacks.
 *
 *   node run.mjs <corpus root> <graph.db> <work dir> <out.json> [--workspace-src] [--skip <project dir>]
 *
 * The projects are the ones `mast index --checker` would visit (`discoverTsConfigProjects`
 * of the built `dist/`). For each, `eval-suite/graph-scorecard.mjs run` is started as its
 * own process with the project's directory as the prefix, one after another. The scorecard
 * builds one `ts.Program` and scores everything mast stores, so its time is an upper bound
 * for a pass that only resolves calls; its peak memory is the program's. The cards are
 * written under the work dir and are not kept; the summary is.
 *
 * A file under two project directories is scored twice, so the totals are counted over
 * the union of keys and not summed.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..', '..');
const { discoverTsConfigProjects } = await import(join(REPO, 'dist', 'graph', 'checker-resolver.js'));

const [root, db, work, out, ...rest] = process.argv.slice(2);
if (!root || !db || !work || !out) {
  console.error('usage: run.mjs <corpus root> <graph.db> <work dir> <out.json> [--workspace-src] [--skip <project dir>]');
  process.exit(2);
}
const workspaceSrc = rest.includes('--workspace-src');
/** `--skip <dir>`: a project not to run, for a second run over a project already seen to fail. */
const skip = rest.includes('--skip') ? rest[rest.indexOf('--skip') + 1] : null;
mkdirSync(work, { recursive: true });

const found = discoverTsConfigProjects(resolve(root));
const CALLS = 'edge: POTENTIAL_CALL';
const BUCKETS = ['agree', 'wrong', 'lacks', 'extra', 'unjudged'];
const union = Object.fromEntries(BUCKETS.map((b) => [b, new Set()]));
const written = {};
const stored = {};
const filesInAProgram = new Set();
const projects = [];

for (const project of found.projects) {
  if (project.configDir === skip) {
    projects.push({ project: project.configDir, tsconfig_file_names: project.fileNames.length, exit: 'skipped', process_ms: 0 });
    continue;
  }
  const slug = project.configDir.replace(/[^A-Za-z0-9]+/g, '_') || 'root';
  const card = join(work, `${slug}.json`);
  const prefix = project.configDir === '' || project.configDir === '.' ? '' : `${project.configDir}/`;
  const args = [
    join(REPO, 'eval-suite', 'graph-scorecard.mjs'), 'run',
    '--root', resolve(root), '--tsconfig', join(project.configDir, 'tsconfig.json'),
    '--db', resolve(db), '--label', `checker-widening s1, ${project.configDir}`, '--out', card,
    ...(prefix === '' ? [] : ['--prefix', prefix]),
    ...(workspaceSrc ? ['--workspace-src'] : []),
  ];
  const started = Date.now();
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  const row = { project: project.configDir, tsconfig_file_names: project.fileNames.length, exit: run.status, process_ms: Date.now() - started };
  if (run.status !== 0 || !existsSync(card)) {
    row.error = (run.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
    projects.push(row);
    console.error(`${project.configDir}: exit ${run.status}`);
    continue;
  }
  const scored = JSON.parse(readFileSync(card, 'utf8'));
  row.scored_typescript_files = scored.meta.scored_typescript_files;
  row.program_source_files = scored.meta.program_source_files;
  row.wall_ms = scored.meta.wall_ms;
  row.peak_rss_mb = scored.meta.peak_rss_mb;
  row.config_errors = scored.meta.config_errors.length;
  const calls = scored.items[CALLS] ?? {};
  for (const bucket of BUCKETS) {
    row[bucket] = (calls[bucket] ?? []).length;
    for (const key of calls[bucket] ?? []) union[bucket].add(key);
  }
  for (const [name, buckets] of Object.entries(scored.breakdowns ?? {})) {
    if (name.startsWith('call edge, stored as')) {
      const mine = (stored[name] ??= { agree: new Set(), wrong: new Set(), unjudged: new Set() });
      for (const bucket of ['agree', 'wrong', 'unjudged']) for (const key of buckets[bucket] ?? []) mine[bucket].add(key);
    }
    if (!name.startsWith('call written as')) continue;
    const mine = (written[name] ??= { agree: new Set(), lacks: new Set() });
    for (const key of buckets.agree ?? []) mine.agree.add(key);
    for (const key of buckets.lacks ?? []) mine.lacks.add(key);
  }
  for (const key of scored.items['file: indexed']?.agree ?? []) filesInAProgram.add(key);
  projects.push(row);
  console.error(`${project.configDir}: ${row.wall_ms} ms, ${row.peak_rss_mb} MB, lacks ${row.lacks}, agree ${row.agree}, wrong ${row.wrong}`);
}

// A pair one project lacks and another has is not lacking.
for (const key of union.agree) union.lacks.delete(key);
const ok = projects.filter((p) => p.exit === 0);
const summary = {
  spike: 'checker-widening s1-cost-yield',
  ran_at: new Date().toISOString(),
  root: resolve(root),
  workspace_src: workspaceSrc,
  projects_found: found.projects.length,
  projects_skipped_by_discovery: found.skipped,
  projects_scored: ok.length,
  projects_failed: projects.filter((p) => p.exit !== 0 && p.exit !== 'skipped').length,
  sum_wall_ms: ok.reduce((n, p) => n + p.wall_ms, 0),
  sum_process_ms: projects.reduce((n, p) => n + p.process_ms, 0),
  max_peak_rss_mb: Math.max(0, ...ok.map((p) => p.peak_rss_mb)),
  call_pairs_union: Object.fromEntries(BUCKETS.map((b) => [b, union[b].size])),
  indexed_typescript_files_in_a_program: filesInAProgram.size,
  lacks_and_agree_by_how_the_call_is_written: Object.fromEntries(
    Object.entries(written).sort().map(([name, v]) => [name, { agree: v.agree.size, lacks: [...v.lacks].filter((k) => !union.agree.has(k)).length }]),
  ),
  call_edges_by_the_rule_that_stored_them: Object.fromEntries(
    Object.entries(stored).sort().map(([name, v]) => [name, { agree: v.agree.size, wrong: v.wrong.size, unjudged: v.unjudged.size }]),
  ),
  wrong_keys: [...union.wrong].sort(),
  projects,
};
writeFileSync(out, `${JSON.stringify(summary, null, 1)}\n`);
console.log(JSON.stringify({ ...summary, projects: undefined, projects_skipped_by_discovery: found.skipped.length }, null, 1));
