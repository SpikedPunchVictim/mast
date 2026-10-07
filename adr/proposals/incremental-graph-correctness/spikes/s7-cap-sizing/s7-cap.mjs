// S7 — decision 2: how often would a cap on re-resolution be hit, and where?
//
// Throwaway. Usage: node s7-cap.mjs <s2 steps.json> <s3 importers json> <out.json>
// No index is opened: this joins two earlier spikes' raw output.
//
// For each replayed commit (S2), estimate the files an incremental run would
// have to resolve again:
//   M3a  for every changed file, the files holding a stored edge into it (S3 `edge`)
//   M3b  for a changed file whose names or re-exports changed, or that was added
//        or deleted, the files importing a name from it, through barrels (S3 `via_name`)
// Per-file sets are summed, so a commit's figure is an upper bound on the union.
// S3 was measured at the final commit, so a file deleted during the replay counts 0.
import { readFileSync, writeFileSync } from 'node:fs';
const [stepsPath, s3Path, outPath] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(stepsPath, 'utf8'));
const s3 = JSON.parse(readFileSync(s3Path, 'utf8'));
const per = new Map(s3.per_file.map((f) => [f.path, f]));
const changesNames = (kind) => /names|reexports|added|deleted/.test(kind);
const runs = [];
for (const st of steps) {
  const files = st.graph_files ?? [];
  if (files.length === 0) continue;
  let m3a = 0, m3b = 0, biggest = { n: 0, path: null };
  for (const f of files) {
    const p = per.get(f.path);
    if (p === undefined) continue;
    m3a += p.edge;
    if (changesNames(f.kind)) {
      m3b += p.via_name;
      if (p.via_name > biggest.n) biggest = { n: p.via_name, path: f.path, kind: f.kind };
    }
  }
  runs.push({ step: st.step, commit: st.commit.slice(0, 10), files_written: files.length, m3a, m3b, total: m3a + m3b, biggest });
}
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const dist = (xs) => ({ zero: xs.filter((x) => x === 0).length, p50: q(xs, 0.5), p75: q(xs, 0.75), p90: q(xs, 0.9), p95: q(xs, 0.95), max: Math.max(...xs) });
const totals = runs.map((r) => r.total);
const over = (n) => runs.filter((r) => r.total > n).length;
const out = {
  runs: runs.length,
  files_to_resolve_again: { m3a: dist(runs.map((r) => r.m3a)), m3b: dist(runs.map((r) => r.m3b)), total: dist(totals) },
  runs_over: Object.fromEntries([25, 50, 100, 250, 500, 1000, 2500, 5000].map((n) => [n, over(n)])),
  top_runs: [...runs].sort((a, b) => b.total - a.total).slice(0, 12),
  per_run: runs,
};
writeFileSync(outPath, JSON.stringify(out, null, 1));
const { per_run, ...summary } = out;
console.log(JSON.stringify(summary, null, 1));
