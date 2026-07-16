// Q2 worker — does the actual TypeScript compilation work. Spawned as a child
// process by q2-run.mjs, which samples this process's RSS from outside (ps)
// while it runs, then reads WORKER_OUT_FILE for the timing/diagnostic numbers.
//
// Approach: ts.createProgram (NOT a ts.LanguageService/project-service) per
// workspace tsconfig project, sequential in one process. Justification (one
// sentence, per the plan): createProgram is the batch, non-editor-oriented API
// — a background enrichment pass (Stage 1.2's design) walks the workspace once
// per indexing run, which is exactly createProgram's use case, not the
// incremental single-file-edit use case LanguageService is built for.
//
// "Cold" = first createProgram + full getSemanticDiagnostics per project, in
// process arrival order. "Warm" = a second createProgram per project passing
// `oldProgram` (the cold pass's Program, no files changed) + diagnostics again
// — measures the incremental-reuse path the real API supports, per Q2's ask.

import ts from 'typescript';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECTS } from './projects.mjs';
import { PROJECT_ROOT } from './paths.mjs';

const outFile = process.env.WORKER_OUT_FILE;
if (!outFile) throw new Error('WORKER_OUT_FILE env var required');

const parseConfigHost = {
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  useCaseSensitiveFileNames: true,
};

function parseProject(relDir) {
  const configPath = join(PROJECT_ROOT, relDir, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    return { relDir, error: ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n') };
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    parseConfigHost,
    join(PROJECT_ROOT, relDir),
  );
  return { relDir, fileNames: parsed.fileNames, options: parsed.options, errors: parsed.errors };
}

const perProject = [];
const oldPrograms = new Map();

console.log(`[q2-worker] parsing ${PROJECTS.length} tsconfig projects...`);
const parsed = PROJECTS.map(parseProject);
for (const p of parsed) {
  if (p.error) console.log(`[q2-worker] SKIP ${p.relDir}: config error: ${p.error}`);
  else console.log(`[q2-worker] ${p.relDir}: ${p.fileNames.length} files`);
}

// --- Cold pass ---
const coldStart = performance.now();
for (const p of parsed) {
  if (p.error) {
    perProject.push({ relDir: p.relDir, skipped: true, reason: `config error: ${p.error}` });
    continue;
  }
  const t0 = performance.now();
  let program;
  try {
    program = ts.createProgram({ rootNames: p.fileNames, options: p.options });
  } catch (err) {
    perProject.push({ relDir: p.relDir, skipped: true, reason: `createProgram threw: ${String(err)}` });
    continue;
  }
  const createMs = performance.now() - t0;
  const t1 = performance.now();
  let diagCount = 0;
  let diagError = null;
  try {
    const diags = program.getSemanticDiagnostics();
    diagCount = diags.length;
  } catch (err) {
    diagError = String(err);
  }
  const checkMs = performance.now() - t1;
  oldPrograms.set(p.relDir, program);
  perProject.push({
    relDir: p.relDir,
    fileCount: p.fileNames.length,
    cold_create_ms: +createMs.toFixed(1),
    cold_check_ms: +checkMs.toFixed(1),
    cold_total_ms: +(createMs + checkMs).toFixed(1),
    semantic_diagnostic_count: diagCount,
    diag_error: diagError,
  });
  console.log(`[q2-worker] cold ${p.relDir}: create=${createMs.toFixed(0)}ms check=${checkMs.toFixed(0)}ms diags=${diagCount}`);
}
const coldTotalMs = performance.now() - coldStart;
console.log(`[q2-worker] COLD total: ${coldTotalMs.toFixed(0)}ms`);

// --- Warm pass: reuse oldProgram per project (no source changes) ---
const warmStart = performance.now();
for (const p of parsed) {
  if (p.error || !oldPrograms.has(p.relDir)) continue;
  const t0 = performance.now();
  let program;
  try {
    program = ts.createProgram({
      rootNames: p.fileNames,
      options: p.options,
      oldProgram: oldPrograms.get(p.relDir),
    });
  } catch (err) {
    const entry = perProject.find((e) => e.relDir === p.relDir);
    if (entry) entry.warm_error = `createProgram(oldProgram) threw: ${String(err)}`;
    continue;
  }
  const createMs = performance.now() - t0;
  const t1 = performance.now();
  const diags = program.getSemanticDiagnostics();
  const checkMs = performance.now() - t1;
  const entry = perProject.find((e) => e.relDir === p.relDir);
  if (entry) {
    entry.warm_create_ms = +createMs.toFixed(1);
    entry.warm_check_ms = +checkMs.toFixed(1);
    entry.warm_total_ms = +(createMs + checkMs).toFixed(1);
    entry.warm_semantic_diagnostic_count = diags.length;
  }
}
const warmTotalMs = performance.now() - warmStart;
console.log(`[q2-worker] WARM total: ${warmTotalMs.toFixed(0)}ms`);

const totalFiles = perProject.reduce((s, p) => s + (p.fileCount ?? 0), 0);

const result = {
  typescript_version: ts.version,
  project_count: PROJECTS.length,
  total_files_across_projects: totalFiles,
  cold_total_ms: +coldTotalMs.toFixed(1),
  warm_total_ms: +warmTotalMs.toFixed(1),
  per_project: perProject,
  self_reported_rss_at_end_bytes: process.memoryUsage().rss,
};

writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(`[q2-worker] wrote ${outFile}`);
