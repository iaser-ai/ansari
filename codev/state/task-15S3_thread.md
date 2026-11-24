# task-15S3 — six Dependabot major bumps onto develop

Brief from the security architect (2026-11-24): land 344 zod, 346 dotenv, 357→427 eslint, 356 vitest,
355 eslint-config-next, 215 react-dom, one at a time, each truly green on current develop.

## 344 zod 3.25.76 → 4.6.7 (superseded by a builder PR)

- The 3→4 major is in apps/frontend only. apps/api, packages/auth and apps/eval already ran zod 4
  (4.4.3 resolved), so for them it is a 4.x minor; better-call (better-auth) moves with them.
- Dependabot's rebased head 83333f61 failed api in CI and locally: one test,
  `tests/openai-compat.test.ts` "#403 … no default messages". Cause: zod 4.6 re-registers the
  English locale on the first schema construction whenever none is set (upstream fix for bundlers
  tree-shaking it, zod #5953/#5725, the bug #403 met on staging). `z.config({ localeError: undefined })`
  no longer simulates a locale-less bundle. Fix (test only): `localeError: () => undefined`.
  Mutation-checked: dropping the route's explicit `{ error: VALIDATION_MESSAGES }` fails the test.
- Survey: 14 `.issues` hits in server code; en-locale text diff 4.4.3→4.6.7 touches only NaN/Infinity,
  exact sizes and z.xor; 0 code uses of those. No client-visible or contract-pinned text changes.
- zod-validation-error ^3.5.4 in apps/frontend (imported nowhere) becomes an unmet peer (zod ^3.24.4).
  A WARN only on a resolving install; CI's `--frozen-lockfile` skips peer resolution, so CI stays
  clean (even mcp.yml's `--strict-peer-dependencies`). Removal left to the owner (security architect).
- Production-shaped boot probe (NODE_ENV=production, cold build, CI placeholder env): develop 19/19,
  PR head 19/19. Gotcha: `next start` loads apps/api/.env, which in a builder worktree is a symlink to
  the main checkout's real env; it silently refilled the "absent" cases until moved aside for the run.
- Flake seen once: apps/auth `tests/limits.test.ts`, 4 tests, "sign-up failed: 404", in the first
  full run after a cold rebuild; 0 failures in 5 reruns.
