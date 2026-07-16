// Shared tsconfig-project parsing + lazy Program cache, used by Q3 and Q4.
// Factored out of q2-worker.mjs (kept separate there so Q2's timing isn't
// perturbed by this module's lazy-cache bookkeeping).

import ts from 'typescript';
import { join, resolve, sep } from 'node:path';
import { PROJECTS } from './projects.mjs';
import { PROJECT_ROOT } from './paths.mjs';

const parseConfigHost = {
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  useCaseSensitiveFileNames: true,
};

/** Longest-prefix match of `repoRelativePath` against the 25 in-scope project dirs. */
export function findOwningProject(repoRelativePath) {
  let best = null;
  for (const relDir of PROJECTS) {
    const prefix = relDir + '/';
    if ((repoRelativePath + '/').startsWith(prefix) || repoRelativePath === relDir) {
      if (best === null || relDir.length > best.length) best = relDir;
    }
  }
  return best;
}

const programCache = new Map();

/** Parse + createProgram (with full checker) for `relDir`, cached across calls. */
export function getProgramForProject(relDir) {
  if (programCache.has(relDir)) return programCache.get(relDir);
  const configPath = join(PROJECT_ROOT, relDir, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    const entry = { error: ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n') };
    programCache.set(relDir, entry);
    return entry;
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, parseConfigHost, join(PROJECT_ROOT, relDir));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const entry = { program, checker };
  programCache.set(relDir, entry);
  return entry;
}

/** Resolve a repo-relative path to the exact ts.SourceFile the project's Program parsed. */
export function getSourceFile(program, repoRelativePath) {
  const abs = resolve(PROJECT_ROOT, repoRelativePath);
  // ts normalizes to forward slashes internally regardless of platform.
  const normalized = abs.split(sep).join('/');
  return program.getSourceFile(normalized) ?? program.getSourceFileByPath?.(normalized);
}
