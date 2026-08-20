// Moving a file is the mutation the unit suite has never performed: `grep -rn "renameSync"
// --include='*.test.ts' src` returns nothing. The index must follow the declaration to its new
// path and stop believing in the old one — a stale hit at a path that no longer exists is worse
// than no hit, because an agent will try to edit it.
export default {
  id: 'move-file-preserves-symbols',
  project: 'fixture',
  description: 'Moving a declaration re-homes it: found at the new path, absent from the old, callers intact.',
  tags: ['mutation', 'core'],
  steps: [
    { install: 'target' },
    { run: 'index .', expect: { exit: 0, stdoutContains: 'files:' } },
    { assert: { kind: 'searchFinds', query: 'alphaFunction', symbol: 'alphaFunction', inFile: 'src/alpha.ts' } },
    { assert: { kind: 'callersInclude', symbol: 'alphaFunction', caller: 'src/beta.ts' } },
    { snapshot: 'before-move' },

    { mutate: { kind: 'moveFile', from: 'src/alpha.ts', to: 'src/moved/alpha.ts' } },
    // The importer must follow, or this stops being a move and becomes a break.
    { mutate: { kind: 'editFile', file: 'src/beta.ts', find: "./alpha.js", replace: "./moved/alpha.js" } },
    { run: 'index . --incremental', expect: { exit: 0 } },

    { assert: { kind: 'exists', file: 'src/moved/alpha.ts' } },
    { assert: { kind: 'notExists', file: 'src/alpha.ts' } },
    { assert: { kind: 'searchFinds', query: 'alphaFunction', symbol: 'alphaFunction', inFile: 'src/moved/alpha.ts' } },
    { assert: { kind: 'callersInclude', symbol: 'alphaFunction', caller: 'src/beta.ts' } },
  ],
};
