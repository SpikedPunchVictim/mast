import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { openDatabase } from '../../graph/db.js';
import { SCENARIOS, type Round, type Scenario } from '../../indexer/__tests__/equivalence-scenarios.js';
import {
  configFor,
  editFile,
  expectGraphEqualsFullIndex,
  indexFull,
  indexIncremental,
  makeProject,
  writeFiles,
} from '../../indexer/__tests__/graph-fixture.js';
import { jitRefreshFile } from '../tools/_helpers.js';

// ---------------------------------------------------------------------------
// T3 — the equivalence table through the query-time path (D080;
// adr/proposals/incremental-graph-correctness).
//
// A read tool that finds a file changed on disk re-writes that file before it
// answers. The re-write deletes the file's rows, and with them every edge into
// and out of it, so this path has to put edges back exactly as an incremental
// run does. Each round is applied, every edited file the index already knows
// is refreshed the way a read tool refreshes it, and the graph is compared
// with a full index; then an incremental run, and the comparison again.
//
// A read tool cannot see a file that was created or deleted, so a round with
// either is compared only after the incremental run.
// ---------------------------------------------------------------------------

function onlyEditsKnownFiles(round: Round, known: ReadonlySet<string>): boolean {
  return Object.entries(round).every(([path, content]) => content !== null && known.has(path));
}

describe('the graph after a query-time refresh equals a full index', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('query-time-equivalence');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function refreshAsAReadToolDoes(paths: readonly string[]): Promise<void> {
    const config = configFor(dir);
    const db = openDatabase(config.resolved_state_dir);
    try {
      for (const path of paths) await jitRefreshFile(db, config, path);
    } finally {
      await db.destroy();
    }
  }

  async function run(scenario: Scenario): Promise<void> {
    writeFiles(dir, scenario.files);
    await indexFull(dir);
    const known = new Set(Object.keys(scenario.files));

    for (const round of scenario.rounds) {
      for (const [relativePath, content] of Object.entries(round)) {
        if (content === null) rmSync(join(dir, relativePath));
        else editFile(dir, relativePath, content);
      }
      const edited = Object.keys(round).filter((path) => round[path] !== null);

      await refreshAsAReadToolDoes(edited);
      if (onlyEditsKnownFiles(round, known)) await expectGraphEqualsFullIndex(dir);

      await indexIncremental(dir);
      await expectGraphEqualsFullIndex(dir);

      for (const [path, content] of Object.entries(round)) {
        if (content === null) known.delete(path);
        else known.add(path);
      }
    }
  }

  it.each(SCENARIOS.filter((scenario) => scenario.openDefect === undefined))('when $name', run);
  it.fails.each(SCENARIOS.filter((scenario) => scenario.openDefect !== undefined))('not yet, $openDefect: when $name', run);
});
