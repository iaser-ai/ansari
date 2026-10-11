# air-52 thread — issue #52 (typecheck/build race guard)

## implement

- Fix: `apps/api/tsconfig.typecheck.json` + `typecheck` script uses `tsc --noEmit -p tsconfig.typecheck.json`.
- Surprise: excluding `.next/types/**/*.ts` from `include` alone does NOT close the race. The
  committed `apps/api/next-env.d.ts` has `/// <reference path="./.next/types/routes.d.ts" />`, so
  tsc still reads `.next`. The typecheck config therefore also excludes `next-env.d.ts`.
  Reported to architect; approved as the correct completion of the fix (still AIR-sized).
- Trade-off (architect accepted): `typecheck` no longer checks Next's generated route validator
  (`.next/types/validator.ts` etc.). `next build` still does, via tsconfig.json.
- Verified: with a deliberately corrupted `.next/types`, base config exits 2, typecheck config
  exits 0 and lists 0 files under `.next`; source file set otherwise identical (75 files).
  `turbo run typecheck build --filter ansari-api... --force` green 3/3 from a clean `.next`.
- Guard test `apps/api/tests/tsconfig-typecheck.test.ts` mutation-tested 4 ways (drop next-env
  exclude, re-include .next/types, drop a base exclude, revert script) — each fails it.

## porch checks — environment notes

- Worktree has no `apps/api/.env`; porch's `build` check needs env. Ran porch with the committed
  dummy `apps/api/.env.ci` loaded.
- Porch's `tests` check (`npm test -- --exclude='**/e2e/**'`, all packages concurrently) failed
  intermittently on PRE-EXISTING timeout-sensitive tests while the machine was loaded (load avg
  17-22): `tests/eslint-env-guard.test.ts` (5s test timeout), `@ansari/auth` pglite `beforeAll`
  (10s hook timeout), and on one run pglite/gemini suites. Same command passes on a quieter
  machine; none involve this change. No tests were skipped or edited.
