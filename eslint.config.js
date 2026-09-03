// ESLint flat config for @kluster/mast.
//
// ESLint 10 uses flat config exclusively; the legacy root `.eslintrc.json` is
// ignored. This config encodes the constitution §2/§3 baseline — the
// `@typescript-eslint` recommended-type-checked ruleset plus the §3 syntactic
// gates (no `any`, no `@ts-ignore`, no stray `console`).
//
// It deliberately does NOT enable `consistent-type-assertions: 'never'`
// (unlike application/api): the existing mast sources were written against the
// root `.eslintrc.json`, which permits `as`. Tightening the assertion policy is
// a separate cleanup, not part of restoring a runnable lint.

import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const recommendedTypeChecked =
  tsPlugin.configs['recommended-type-checked']?.rules ?? {};
const recommendedNonTypeAware = tsPlugin.configs['recommended']?.rules ?? {};

const syntacticGates = {
  // §3.1 — no `any`.
  '@typescript-eslint/no-explicit-any': 'error',
  // §3.1 — `@ts-ignore`/`@ts-nocheck` banned; `@ts-expect-error` needs a reason.
  '@typescript-eslint/ban-ts-comment': [
    'error',
    {
      'ts-ignore': true,
      'ts-nocheck': true,
      'ts-check': false,
      'ts-expect-error': 'allow-with-description',
      minimumDescriptionLength: 10,
    },
  ],
  // Honour the repo-wide `_`-prefix opt-out for intentionally unused bindings.
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  // CLI tools legitimately write to stdout/stderr; allow warn/error elsewhere.
  'no-console': ['warn', { allow: ['warn', 'error'] }],
};

export default [
  // Flat config does not inherit `.eslintignore`.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.mast/**',
      // Fixtures are sample source files (intentionally unconventional, with
      // deliberately unused/non-exported declarations) — they are test data, not
      // code to lint.
      'src/**/__tests__/fixtures/**',
      // Not merely generated: this holds installed node_modules and materialised OSS corpora
      // (26321 files for n8n alone). Linting it would be slow and would report on third-party
      // source the harness only ever reads.
      'integration/results/**',
    ],
  },

  // Production source: full type-checked ruleset. Test files are excluded from
  // tsconfig's `include`, so the type-aware parser cannot resolve them — they
  // are handled by the non-type-aware block below.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/__tests__/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...recommendedTypeChecked,
      ...syntacticGates,
      // Fastify-style plugins are absent here, but several worker/CLI entry
      // points are `async` for interface conformance without awaiting — the
      // floating-promise rule (kept on via recommended-type-checked) is what
      // actually guards forgotten awaits.
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Tests: type-aware lint is intentionally not applied (tsconfig excludes
  // them). The §3 syntactic gates do not need type info and remain enforced.
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/__tests__/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...recommendedNonTypeAware,
      ...syntacticGates,
      // Test carve-out (§3.1): non-null assertions are allowed where the
      // invariant is obvious from setup.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // The eval and integration harnesses: plain ESM JavaScript, outside tsconfig's `include`, so
  // no type-aware rule can reach them. Before this block they matched no configuration at all —
  // `eslint eval` ran with an EMPTY rule set and was a parse check wearing a lint's name, which
  // is the S-04 shape aimed at our own tooling. These directories decide what the release gate
  // asserts and what an experiment measures, so "unlinted" was the wrong default for them.
  //
  // `js.configs.recommended` is the likely-bug set and is maintained upstream rather than
  // hand-listed here; the two rules below are the local policy on top of it.
  {
    files: ['eval/**/*.mjs', 'integration/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      // stdout IS the interface for both harnesses — the run log is the artifact a reader
      // reviews. `no-console` would fire on every line of it.
      'no-console': 'off',
      // The repo-wide `_`-prefix opt-out, matching `syntacticGates` above.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
