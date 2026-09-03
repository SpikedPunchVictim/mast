// `mast serve` flag semantics.
//
// These pin a *default*, which is the part that has no other guard: nothing in
// the type system distinguishes "watch defaults on" from "watch defaults off",
// and commander's boolean-pair defaulting depends on the order the two options
// are declared in (`--no-watch` first makes the default true; `--watch` first
// leaves it undefined). A reordering during an unrelated edit would silently
// return the server to the opt-in behaviour these tests exist to replace.
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import type { ServeOptions } from '../../mcp/server.js';
import { registerServeCommand } from '../serve.js';

/** Parse `mast serve <argv>` and return the ServeOptions the command would run. */
async function parseServe(argv: readonly string[]): Promise<ServeOptions> {
  let captured: ServeOptions | null = null;
  const program = new Command();
  program.exitOverride();
  registerServeCommand(program, async (options) => { captured = options; });

  await program.parseAsync(['node', 'mast', 'serve', ...argv]);

  if (captured === null) throw new Error('serve action did not run');
  return captured;
}

describe('mast serve — watch', () => {
  it('watches by default, so an index cannot silently fall behind an editing session', async () => {
    const options = await parseServe([]);

    expect(options.watch).toBe(true);
  });

  it('accepts --no-watch to opt out', async () => {
    const options = await parseServe(['--no-watch']);

    expect(options.watch).toBe(false);
  });

  it('still accepts an explicit --watch, which existing MCP client configs pass', async () => {
    const options = await parseServe(['--watch']);

    expect(options.watch).toBe(true);
  });
});

describe('mast serve — startup reindex', () => {
  it('reindexes at startup by default', async () => {
    const options = await parseServe([]);

    expect(options.noStartupReindex).toBe(false);
  });

  it('accepts --no-startup-reindex', async () => {
    const options = await parseServe(['--no-startup-reindex']);

    expect(options.noStartupReindex).toBe(true);
  });
});
