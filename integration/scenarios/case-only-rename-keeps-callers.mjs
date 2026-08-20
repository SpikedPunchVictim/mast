// The calibration scenario, and D023's class.
//
// `git mv DeepDir deepdir` on a case-insensitive filesystem while the importer still spells the
// old casing. `statSync` matches either way, so nothing fails loudly; the only thing keeping the
// resolver's path in agreement with the walker's is `realpathSync.native`, which reports the
// spelling on disk rather than echoing back the one it was handed. Revert that single word and
// `verified_callers` goes empty for a function that has a caller — with no error anywhere in the
// run. That is exactly what `--targets local-broken-d023-miscased-import` reverts, which is why
// this scenario is pinned to fail against it.
//
// ONLY MEANINGFUL ON A CASE-INSENSITIVE FILESYSTEM. On ext4 — CI's — a mis-cased import does not
// resolve at all, so the branch under test never executes. `requires` records that; a container
// run reports this scenario as skipped rather than as evidence.
export default {
  id: 'case-only-rename-keeps-callers',
  project: 'fixture',
  description: 'A case-only directory rename must not silently empty verified_callers (D023).',
  tags: ['mutation', 'calibration'],
  requires: 'case-insensitive-filesystem',
  expectFailOn: ['local-broken-d023-miscased-import'],
  steps: [
    { install: 'target' },
    { run: 'index .', expect: { exit: 0 } },
    { assert: { kind: 'callersInclude', symbol: 'deepHelper', caller: 'src/uses-deep.ts' } },

    // The directory's spelling on disk changes; the import specifier does NOT.
    { mutate: { kind: 'caseOnlyRename', from: 'src/DeepDir', to: 'src/deepdir' } },
    { run: 'index .', expect: { exit: 0 } },

    // The caller still exists and still calls it. Anything else is a phantom absence.
    { assert: { kind: 'callersInclude', symbol: 'deepHelper', caller: 'src/uses-deep.ts' } },
  ],
};
