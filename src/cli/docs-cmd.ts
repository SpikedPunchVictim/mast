import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { CLI_VERSION, PACKAGE_NAME } from './version.js';

/**
 * `mast docs` and `mast skill` — documentation that is version-matched by construction.
 *
 * Both read files shipped inside the installed package rather than pointing at a
 * website, so what a user (or an agent) reads is what their binary does. Looking up
 * "which release am I on, and which docs go with it" is exactly the step this removes,
 * and it is the step where a reader silently ends up on docs for a different version.
 */
export class DocsError extends Error {}

// `dist/cli/` and `src/cli/` both sit two levels below the package root, so this
// resolves identically under vitest and in the published tarball.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface DocTopic {
  readonly name: string;
  readonly file: string;
  readonly summary: string;
}

export const DOC_TOPICS: readonly DocTopic[] = [
  { name: 'readme', file: 'README.md',     summary: 'Install, quick start, CLI and MCP tool reference' },
  { name: 'spec',   file: 'MAST_SPEC.md',  summary: 'Full behavioural specification — schemas, tool contracts, invariants' },
  { name: 'skill',  file: 'assets/skill.md', summary: 'The instructions to paste into an agent prompt or skill file' },
];

export function readDoc(name: string): string {
  const topic = DOC_TOPICS.find((t) => t.name === name);
  if (topic === undefined) {
    throw new DocsError(
      `unknown docs topic "${name}"; available topics: ${DOC_TOPICS.map((t) => t.name).join(', ')}`,
    );
  }
  try {
    return readFileSync(join(PACKAGE_ROOT, topic.file), 'utf8');
  } catch {
    throw new DocsError(
      `${topic.file} is missing from this installation of ${PACKAGE_NAME}@${CLI_VERSION}`,
    );
  }
}

export function listDocs(): string {
  const width = Math.max(...DOC_TOPICS.map((t) => t.name.length));
  return [
    `${PACKAGE_NAME} ${CLI_VERSION} — documentation shipped with this build`,
    '',
    ...DOC_TOPICS.map((t) => `  ${t.name.padEnd(width)}  ${t.summary}`),
    '',
    'Read one with `mast docs <topic>`.',
  ].join('\n');
}

export function registerDocsCommand(program: Command): void {
  program
    .command('docs [topic]')
    .description('Print the documentation shipped with this build — no version lookup needed')
    .action((topic: string | undefined) => {
      try {
        process.stdout.write((topic === undefined ? listDocs() : readDoc(topic)) + '\n');
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}

export function registerSkillCommand(program: Command): void {
  program
    .command('skill')
    .description('Print the MAST instructions to copy into an agent prompt or skill file')
    .action(() => {
      try {
        process.stdout.write(readDoc('skill') + '\n');
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}
