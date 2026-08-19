# MAST Remediation — Implementation Plan

Tracks the fixes arising from the 2026-07-25/27 empirical investigation.
**Findings and evidence live in `eval/GITNEXUS_COMPARISON.md`** (read §13–§16 —
§1–§12 contain claims since proven wrong). This file tracks *work*, not evidence.

Convention: per global CLAUDE.md §1 — update `Status` as work progresses; archive
to `.history/` when every stage is Complete.

**Verification baseline** (every stage must hold these):
`pnpm -F mast test` · `pnpm -F mast typecheck` · `pnpm -F mast lint` ·
`npx align check` (repo-root CLI; pre-existing `verdict: red` with exactly 2
violations — `root-layout.tsx` cycle, `fold-build-record-repository.ts`
apiDomain→apiDb — neither naming `mast`; verify no NEW mast violation).
Current test count: **380 / 34 files** (re-measured 2026-08-01; the previously
recorded 366 / 30 had gone stale). `align check` on this branch: pre-existing
`verdict: red`, the same 2 violations, and `baselined debt: 324 → 327 (+3)` — the +3
is also pre-existing, confirmed by re-running with new files removed.

---

