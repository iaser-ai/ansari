# air-397 thread: move the model evaluation harness to apps/eval

## 2026-11-15 — Implement

Issue #397, AIR, strict mode. No Baked Decisions section in the issue.

**What moved.** `apps/api/eval/` → `apps/eval/` and `apps/api/tests/model-eval/` →
`apps/eval/tests/`, with `git mv`, so history follows. New package `ansari-eval`
(`package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `turbo.json`).

**Decisions.**

- `@/` in apps/eval means what it means in apps/api: the same three mappings, pointed at
  `../api`. tsx takes them from `apps/eval/tsconfig.json` because the run command starts
  in that directory (`pnpm --filter ansari-eval exec`); vitest repeats them. Checked that
  the same import fails when tsx starts in a directory without that tsconfig.
- No workspace dependency on `ansari-api`. It would add nothing the alias needs, it would
  make `--filter ansari-eval...` rerun the whole api suite in CI, and a `workspace:*`
  dependency does not put file contents in a task hash anyway. Instead
  `apps/eval/turbo.json` lists `apps/api/{src,lib,db}/**` as inputs of `typecheck` and
  `test`. Proven both ways with `turbo --dry=json`: with the inputs an edit to
  `apps/api/lib/config.ts` moves both hashes (lint stays); without them neither moves.
- No `globalEnv` or `globalDependencies` change. The harness reads no `process.env`
  itself (0 static, 0 dynamic reads under apps/eval), it has no Zod env schema, and every
  variable its README documents is already in `globalEnv` through apps/api.
- `tsx`, `vitest`, `zod` and `@types/node` are pinned to the exact versions apps/api
  resolves. With the api's caret ranges pnpm picked other versions already in the lockfile
  (tsx 4.22.0 against the api's 4.23.11, zod 4.6.7 against 4.4.3, @types/node 25.9.8
  against 25.9.5), which would put two copies of the node types in one tsc program and
  run the harness on an older tsx than before.
- Lockfile: a plain `pnpm install` also re-resolved unrelated transitive entries (zod
  under `@better-auth/expo`, `@types/node` under jest and chrome-launcher). The committed
  lockfile is HEAD's plus the `apps/eval` importer block only (31 lines), and
  `pnpm install --frozen-lockfile` accepts it.
- CI: a separate `eval (lint, typecheck, test)` job, as the issue asks. It is NOT a
  required check; making it one is a branch-protection change for a repo admin.

**Surprises.**

- The harness tests were never typechecked or linted in apps/api (`tests/**` is excluded
  from both there). In apps/eval they are. They typecheck clean; lint found one unused
  `eslint-disable` directive, removed.
- The existing harness tests could not have caught a broken `@/` alias: everything they
  import through it is a type, erased before resolution. `tests/run-command.test.ts` now
  starts the run command under tsx and loads the api modules a real run needs, under tsx
  and under vitest. Breaking either alias fails exactly one test; restoring passes.
- `contributor-docs.test.ts` pins the number of CI jobs at 5 and requires CONTRIBUTING.md
  to name each. Now 6, with the doc saying `eval` is not required.

**Noticed, not changed (outside this issue).**

- CONTRIBUTING.md says `develop` requires five checks including
  `whatsapp (lint, format, test)`. The branch protection API lists four: gitleaks, api,
  auth, frontend.
- RELEASE.md's "Deployment model" still names `backend (lint, typecheck, test, build)`,
  which the workflow no longer emits.
- CONTRIBUTING.md's Checks block still says "both apps" and "api only".

**Flaky under load.** The first full `test:coverage` run of apps/api failed two tests
that this change does not touch (`tests/contract/legacy-users-contract.test.ts` reset
password; `tests/migration/window-migration.test.ts` scaffold cleanup, at the 30 s
timeout). Machine load average was about 30 (other builders). Both files pass alone
(73 tests), and the full suite passes with the root script's `--maxWorkers=4` (94 files).
Nothing skipped.
