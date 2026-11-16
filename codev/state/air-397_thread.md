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

**Verified on the built image.** `docker build -f apps/api/Dockerfile .` from this branch,
then listed inside the container: `/repo/apps` holds `api` only, `/repo/apps/api/eval`
does not exist, 0 harness files anywhere outside `node_modules`, and the control file
(`apps/api/lib/facilitator/agent.ts`) is there.

**Real path, placeholder credentials.** One conversation with `apps/api/.env.ci` as the
env file: config, facilitator, search tool and prompt all loaded through `@/` under tsx,
Vertex refused the placeholder key, and the run recorded the error row with the right
provenance and wrote both files. No real credentials were used; no model answered.

**Local checks need Node 22.** This machine's default Node is 26, under which
`apps/frontend/hooks/useKeyboard.web.test.ts` fails 11/11 (`window.localStorage`
undefined; Node 26 has its own `localStorage` global). Same finding as bugfix-383. Porch
was run through `fnm exec --using=22`, with `apps/auth/.env.ci` exported as well. The eval
checks and the dry-run comparison were repeated under Node 22: same results.

Porch's `tests` check has a 300 s limit and the full `pnpm test` took 298 to 310 s here
with the machine at load 30 to 70 (other builders, plus my image build). It timed out
once for that reason and passed on the rerun.

## 2026-11-15 — pr

Implement phase done (porch checks green under Node 22). Opening the PR against `develop`.

- **PR #398** opened against `develop` (`Closes #397`). Not merged; the `pr` gate is the
  human's.
- First CI run on the PR: all green, including the new `eval (lint, typecheck, test)` job
  (48 s, its first run anywhere).
- CMAP: codex APPROVE, claude APPROVE, gemini SKIPPED. The Gemini lane did not review:
  its CLI (`agy`) exited with code 3. That is not an approval. (The first attempt at all
  three stopped at once with "Multiple projects found"; `--issue 397` fixed it.)
- Taken from the Claude review:
  - The watch-pattern claim was stated as fact about the live service, but the check
    reads `apps/api/railway.toml`, which Railway does not read here (the dashboard is the
    live config). README, arch.md and the PR body now say "recorded watch patterns", and
    that `pnpm-lock.yaml` is watched, so a dependency change in apps/eval still redeploys
    the api. **I have not seen the dashboard.** Someone with access should confirm the api
    service's watch patterns there match the toml.
  - `apps/eval/models.json`'s note still said `eval/rescore.ts`. Fixed.
  - The Dockerfile COPY reader takes one line per instruction; a continued or heredoc
    COPY is now refused. Proven on a planted continued COPY (fails), restored (passes).
- Not taken, with the reason: the review said the next plain `pnpm install` would rewrite
  the lockfile block. Checked: `pnpm install --lockfile-only` on this branch changes
  nothing (0 diff lines). The re-resolution of unrelated entries happens when a manifest
  next changes, as it would have without this PR. The importer block itself is pnpm's
  own output, taken from a pinned install.
- Follow-ups worth an issue, not done here: put `tsx`, `vitest`, `zod` and `@types/node`
  in the pnpm catalog so apps/api and apps/eval cannot drift (touches apps/api's
  manifest); add `eval (lint, typecheck, test)` to `develop`'s required checks (admin);
  reconcile CONTRIBUTING.md's "five required checks" with the four in branch protection.

## 2026-11-16 — pr gate approved, merging

- Final CI on the PR (head `202eb41c`): all seven checks green.
- Architect integration review on the PR: no changes requested. My open question is
  answered there: the api service's live watch patterns on staging and production match
  `apps/api/railway.toml` and do not cover `apps/eval`.
- The architect relayed the human's explicit approval of the `pr` gate and of merging
  PR #398 (2026-11-16T15:11Z). I ran `porch approve 397 pr` on that instruction, not
  before. Merging with a merge commit (no squash) once CI is green on the final head.
- Still open for others: add `eval (lint, typecheck, test)` to `develop`'s required
  checks (repo admin); the pnpm catalog follow-up for `tsx`, `vitest`, `zod` and
  `@types/node`; move any existing `apps/api/.env.eval.local` to `apps/eval/`.
