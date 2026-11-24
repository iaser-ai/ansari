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

## 346 dotenv 17 → 18 — merged 1e83ce5b (owner's word)

- No code change. 18 still honours DOTENV_CONFIG_PATH, loads nothing without a file, never overrides
  a shell value. New: it also reads the short DOTENV_{PATH,QUIET,OVERRIDE,DEBUG,ENCODING,FAST} names.
  No .env ships in the auth image. Findings recorded on #346.

## 356 vitest → PR #434; 215 react-dom → PR #435 (api half)

- #356 failed on "Running mixed versions": @vitest/coverage-v8 stayed on 4. Both now 5.1.1 (they pin
  each other's exact patch).
- #215's api half as filed was unsound (react-dom 19.3.1 peers react ^19.3.1; @types likewise).
  #435 moves the four together; apps/frontend untouched (Expo SDK pins, #428).
- Slip, caught before commit: a two-dot `git diff develop <stale dependabot branch>` drags in the
  reverse of everything develop gained since (dotenv back to 17). Apply bump hunks by targeted edit,
  or use the three-dot diff.

## 427/430 eslint 10 + 355 eslint-config-next 16 — NOT pursued (owner decision 2026-11-24, option B)

Local branch `builder/task-15S3-eslint10` (commit 037fa87c, unpushed, on develop 1e83ce5b) holds the
working change, for when the plugins support ESLint 10:
- catalog `eslint: ^10.15.0`.
- apps/api: eslint-config-next ^16.4.6 flat configs (`core-web-vitals`, `typescript`) replace the
  FlatCompat bridge, whose @rushstack/eslint-patch cannot load under ESLint 10; @eslint/eslintrc
  dropped. No shim needed there.
- apps/frontend: `...fixupConfigRules(expoConfig)` from @eslint/compat ^2.1.1 (new devDep).
  eslint-plugin-react 7.37.5 (latest, Apr 2025, peer eslint ≤^9.7) calls context.getFilename,
  which ESLint 10 removed ("Error while loading rule 'react/display-name'"); eslint-plugin-import
  2.32 / jsx-a11y 6.10 also stop at ^9. eslint-config-expo 58 (#428) does not change that: tested on
  builder/pir-428 a18dda24 + eslint 10, same crash; with the wrapper, 0 errors / 64 warnings.
Evidence on develop + this branch:
- frontend findings identical (64 warnings, same file:line:col and rule); active rule sets identical
  (only no-unused-vars printing its defaults explicitly).
- api: same 5 warnings; active rule set identical except one new Next 16 rule,
  @next/next/no-location-assign-relative-destination (warn).
- seeded violations fire the same rules as develop (react/jsx-key, react/no-unescaped-entities,
  react/jsx-no-duplicate-props, import/no-duplicates, import/no-anonymous-default-export,
  jsx-a11y/alt-text, react-hooks/*); without the frontend wrapper, lint crashes.
- whole workspace: lint 7/7, api build, tests (api 1464, apps/auth 635, packages/auth 290,
  eval 145, frontend 809) green.
To pick up: rebase on develop, regenerate the lockfile, recheck whether the plugins now declare
eslint 10 (then drop the wrapper), and rerun the comparisons above.
