# Plan 3 — Rebuttal to iteration-2 plan re-review

**Verdicts**: Gemini APPROVE · Codex COMMENT · Claude COMMENT.

No REQUEST_CHANGES this round — the iter-1 blockers are confirmed fixed. Three minor comments remained;
all three were cheap, correct, and are now folded in (verified against `next.config.ts` and
`CONTRIBUTING.md:26-33`).

1. **`tests/**` lint-scope contradiction** (Codex + Claude). Phase 2 said `tests/**` stays unlinted but
   only ignored `tests/e2e`; with `eslint .` all ~45 Vitest files would be linted. FIXED: `tests/**` is
   now in the flat config's global `ignores`, making config and stated intent consistent (and matching
   `tsconfig.json:31`'s exclusion of `tests/**`).

2. **`next.config.ts` build-time ESLint activation** (Claude). VERIFIED: `next.config.ts` has no
   `eslint.ignoreDuringBuilds`, so adding `eslint.config.mjs` makes `next build` run ESLint — coupling
   Phase 2's own build gate to lint. FIXED: Phase 2 now sets `eslint: { ignoreDuringBuilds: true }`; lint
   is a dedicated CI step (Phase 3), so build and lint stay decoupled.

3. **`CONTRIBUTING.md` checks contract goes stale** (Claude). VERIFIED: lines 26-33 say "CI runs exactly
   these" and list only typecheck/test/build; Phase 3 adds a CI lint step. The spec names this file as
   "the checks contract that must stay accurate." FIXED: Phase 3 now adds `npm run lint` to that block,
   co-located with the CI change. (Phase 4 still edits the same file to drop the Playwright paragraph —
   two small self-consistent edits across two area-commits.)

**Non-actionable notes acknowledged**:
- Claude: `tests/health.test.ts:2` also imports the route unmocked and asserts 200 — but Phase 5
  rewrites it in the same commit, so the gate holds. No change needed (already the plan's design).
- Claude: the share-FK concern is real only if the test's hand-written pglite DDL declares the FK;
  seeding users→threads→shares is correct either way. Kept as planned.

All comments resolved; the plan is implementation-ready.
