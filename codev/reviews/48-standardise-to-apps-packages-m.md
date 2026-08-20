# Review: Standardise to apps/ + packages/ monorepo layout and introduce Turborepo

**Spec**: [`codev/specs/48-standardise-to-apps-packages-m.md`](../specs/48-standardise-to-apps-packages-m.md)
**Plan**: [`codev/plans/48-standardise-to-apps-packages-m.md`](../plans/48-standardise-to-apps-packages-m.md)

83 commits · 284 files changed (+7713 / −197) · six phases · **14 implementation review rounds** (plus one each for specify and plan).

> Counts are regenerated from `git diff --shortstat develop...HEAD` and the consultation
> artifacts in `codev/projects/`, not typed by hand — they went stale twice when they were.

## What shipped

`backend/` → `apps/api/` and `frontend/` → `apps/frontend/`, with Turborepo owning the task
graph and three shared packages under `packages/`. Root scripts now mean what they say:
`pnpm dev` starts **both** apps, where before it was `--filter ansari-backend dev` with
nothing at the call site admitting it.

| | Before | After |
|---|---|---|
| `pnpm dev` | backend only, silently | both apps |
| `pnpm test` / `build` | backend only, silently | api / both apps, and Turbo prints the scope |
| `pnpm lint` / `typecheck` | repo-wide | repo-wide (preserved deliberately) |
| Task graph | none | `dependsOn`, declared `outputs`, caching |
| Repeat build | cold every time | **FULL TURBO**, 10ms |
| Shared config | none | `@ansari/tsconfig`, `@ansari/eslint-config`, `@ansari/types` |

## The one thing worth remembering

**Every serious defect on this project had the same shape: it reported success while not
doing its job.** Six instances, none of which a passing build would have revealed:

1. An ESLint config that failed to resolve would report **zero violations** — indistinguishable from clean.
2. A warm cache skipped `gen:types` with no declared output to restore — green cold, broken warm.
3. Undeclared env was excluded from the cache hash — a cached frontend build could ship a
   staging API URL to production **while reporting a cache hit**.
4. `workspace:*` puts a package in the dependency *graph* but not in a consumer task's
   *hash* — editing a shared config left the hash identical, so a warm cache replayed stale results.
5. `@ansari/types`' `eslint .` discovered no `.ts` files at all — the task ran, exited 0, checked nothing.
6. A `watchPatterns` glob matching nothing does not error; it silently stops triggering deploys.

That is why this review's evidence is phrased as *"assert against the tree"* rather than
*"confirm it passes"*, and why acceptance criteria demand **both directions**: proving a
change moves the hash is only half — you must also prove that removing the declaration makes
it stop moving. One direction alone cannot distinguish working from broken.

The same discipline applies to the checks themselves. Three of my own scans reported a wrong
answer: a compound regex that silently matched nothing, a too-loose pattern that matched
`apps/frontend/` inside `frontend/`, and an exclusion filter that never fired because paths
lacked a `./` prefix. **A verification pattern is code, and untested code is not evidence.**
Every scan in the final sweep was negative-tested against a known-bad line *and* a known-good
near-miss before its result was trusted.

## Verification (final sweep — 10 of 12 criteria closed locally)

| Criterion | Evidence |
|---|---|
| `globalEnv` vs **four** derivation methods | Zod 23 · static 21 · dynamic 2 · documented 29 — **missing: NONE** |
| Cache key, both directions | declared var moves hash; undeclared silently dropped |
| Shared-package contents in hash, both directions | tsconfig and eslint edits each move the dependent hash |
| Stale-path scan (pattern negative-tested first) | 134 hits · **134 exempt · 0 live** |
| Suite vs `develop` **test-name set** | 66 suites · 623 passed · 0 failed · diff = 1 intentional rename |
| Both doc-consistency negative checks | each fails when broken, restores clean, 14/14 after |
| FULL TURBO on repeat | 10ms |
| Both Docker images | `EXIT=0`, and confirmed running `COPY packages packages` → frozen install → app build |
| `git log --follow` | `apps/api/lib/config.ts` traces to "Initial import of the Ansari backend" |
| Both `railway.toml` | dockerfilePaths exist; every glob matches real paths (25 / 18) |
| Fresh-clone walkthrough | install · lint (3) · typecheck (4) · test (66 files) · build — all pass verbatim |
| Shared packages linted + typechecked | all three in scope locally — **CI-log confirmation NOT yet obtained** |

**Two criteria are deliberately UNMET until the PR's CI run**, and are not claimed as satisfied:

1. **gitleaks** — not installed locally. `.gitleaks.toml` and `.gitleaksignore` are verified
   byte-identical to `develop` and the CI job is intact with `fetch-depth: 0`, but the scan
   itself has not been run here.
2. **`@ansari/types` lint/typecheck in CI** — it has no consumer, so the app jobs' dependency-
   closure filters cannot reach it and a dedicated step exists. Reading the workflow file is
   not evidence a step executed.

A third, **Dependabot `directory: "/"` workspace coverage**, is only confirmable post-merge
from GitHub's Dependency graph.

## Decisions worth carrying forward

**The env list is derived, not guessed — by four methods, each added because skipping it lost
a real variable.** The Zod schema alone misses `SENTRY_DSN` and `RESEND_API_KEY` (read
directly); a static `process.env.X` grep cannot see `process.env[name]` (lost the two
facilitator budget vars); and neither sees `SENTRY_AUTH_TOKEN`, which appears nowhere in our
source because `withSentryConfig` consumes it. `turbo.json` documents all four steps with the
variable each one rescued.

**`isolatedModules` is deliberately absent from the shared tsconfig base.** `apps/api` sets
it; `apps/frontend` does not. Including it would have silently enabled it for the frontend —
a behaviour change wearing a refactor's clothing. The rule now written into
`packages/README.md`: *a shared package holds what its consumers genuinely agree on, and
nothing else.*

**The `no-restricted-properties` env guard stays in `apps/api`.** Its allowlist names
backend-relative paths that mean nothing in an Expo app. Security rules belong where their
allowlist is meaningful. `eslint-env-guard.test.ts` (9/9) lints through the *real composed*
config, so it proves the rule survived being layered on a shared base.

**`build:web` keeps its `pnpm run gen:types &&` chain.** `Dockerfile.web` installs with
`--filter` (no root devDependencies, so no turbo in that image) and calls it directly.
Removing the chain would break the image. Under the graph it is a duplicate uniwind run —
idempotent, sub-second, and **not** a cache hit, since `pnpm run` bypasses Turbo entirely.

**CI job IDs were renamed; emitted check names were not.** `develop`'s protection requires
`backend (lint, typecheck, test, build)`, matched **by name**. A job's ID and its emitted
name are independent, so the ID moved with the directory and the name stayed put — merging
with no admin coordination and no unmergeable window. Renaming it is a deferred follow-up
requiring the protection rule and the `name:` line to change **together**.

**`/api/health` still returns `service: 'ansari-backend'`.** Spec 3 pins it ("frontend and
runbooks key on it"). It is a public API contract, not a path.

## Flaky Tests

None. The suite was green on every run. One **latent** race is documented rather than
observed-and-ignored: `apps/api/tsconfig.json` includes `.next/types/**/*.ts`, which a
concurrent `next build` rewrites underneath `tsc`. A reviewer hit it once in two runs of a
combined `turbo run typecheck build`. CI is unaffected (sequential steps), and `turbo.json`
now warns against the combined invocation — because "intermittent, passes on re-run" is
exactly the shape that gets papered over.

## What this cost, and what it caught

14 implementation review rounds across six phases. Phase 2 alone took five, and each round found a
genuinely different class of missing environment variable — every one of which would have
failed silently in production. The rounds were not ceremony.

Two reviewer lanes wedged repeatedly on phase 2 (claude 3×, gemini 1×). Root cause, diagnosed
by the architect: phase 2 introduced `turbo run dev`, a task that never terminates, and an
agentic reviewer that decides to exercise it hangs forever. The trigger is stochastic — the
same lane completed later on the same phase. Phase 2 therefore shipped with one fewer
reviewer than any other, and carries a compensating control: its `turbo.json` was re-reviewed
in phase 6 against all four derivation methods.

## Out-of-repo actions required after merge

1. **Railway** — both services need their **dashboard** settings updated: Dockerfile path to
   `apps/api/Dockerfile` / `apps/frontend/Dockerfile.web`, root directory left at the repo
   root, and watch paths including **`packages/**`**. See the "Railway service configuration"
   block in `RELEASE.md` for the full per-service table. There is no "config file path"
   setting to change — Railway resolves a config file relative to the service root directory,
   so `apps/*/railway.toml` is never picked up; those files are the reviewable record, not the
   live configuration. No PR can fix this. *(Completed by the human before merge.)*
2. **Dependabot coverage** — `directory: "/"` covering every workspace package is only
   confirmable from GitHub's Dependency graph after merge. A config that resolves nothing
   produces no error, just silence. Fallback (per-directory entries) is specified in the plan.
3. **Open Dependabot PRs** — ten are open against the old path. **Leave them.** Repointing
   `dependabot.yml` obsoletes them and Dependabot re-opens against the new path.
4. **CI check rename** — deferred follow-up; requires repo admin, and the protection rule and
   `ci.yml` `name:` line must change together.
