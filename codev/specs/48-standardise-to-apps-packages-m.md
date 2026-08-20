# Specification: Standardise to apps/ + packages/ monorepo layout and introduce Turborepo

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Keep implementation phases, file paths, code, and "first we will… then we will…"
out of the spec — those belong in codev/plans/48-standardise-to-apps-packages-m.md.
-->

## Problem Statement

The Ansari repo is a two-package pnpm workspace whose root scripts lie about what
they do, and which has no task graph at all.

`pnpm dev` at the root is an alias for `pnpm --filter ansari-backend dev`: it starts
the backend and nothing else. `pnpm test` and `pnpm build` are likewise backend-only,
while `pnpm lint` and `pnpm typecheck` genuinely are repo-wide (`pnpm -r`). Nothing at
the call site distinguishes the two shapes, so a contributor who runs `pnpm test` at
the root and sees green has tested half the repo and does not know it.

Three groups are affected. **Contributors** get no reliable "run everything" command
and must learn per-app incantations from prose in four different documents.
**CI** hand-rolls the same knowledge a fourth time as a list of `pnpm --filter`
invocations that must be kept in sync with the scripts by hand. **Everyone** pays for
every run twice, because there is no caching and no `dependsOn` — each lint, typecheck,
test, and build is a cold run even when nothing changed.

The layout compounds this. `backend/` and `frontend/` sit at the repo root as
top-level directories, which is not a convention any tool recognises, and there is no
place to put anything shared: eslint configuration, TypeScript base settings, and API
contract types are today either duplicated between the apps or simply absent.

## Current State

**Layout.** Flat workspace: `backend/` (Next.js 15 API + admin UI, Vitest, Drizzle) and
`frontend/` (Expo / React Native, web via react-native-web) as sibling top-level
directories. `pnpm-workspace.yaml` lists them literally (`- backend`, `- frontend`),
carries a `catalog:` pinning `typescript: ~6.0.3`, and an `onlyBuiltDependencies`
allowlist. One root `pnpm-lock.yaml`; no per-package lockfiles.

**Root scripts.** Five, of mixed and undocumented scope:

| Script | Actually runs |
|---|---|
| `pnpm dev` | `--filter ansari-backend dev` — **backend only** |
| `pnpm test` | `--filter ansari-backend test` — **backend only** |
| `pnpm build` | `--filter ansari-backend build` — **backend only** |
| `pnpm lint` | `pnpm -r lint` — both apps |
| `pnpm typecheck` | `pnpm -r typecheck` — both apps |

There is no way to start both apps together, and no root script advertises which of
these two behaviours it has.

**No task graph.** No Turborepo, no Nx, no caching, no `dependsOn`, no declared task
outputs. Ordering that genuinely matters is expressed as shell `&&` inside package
scripts: the frontend's `typecheck` is `pnpm run gen:types && tsc --noEmit`, and its
`build:web` is `pnpm run gen:types && expo export --platform web`, because uniwind's
generated `uniwind-types.d.ts` (gitignored) must exist before `tsc` runs. The
dependency is real but invisible to any tool.

**Nothing is shared.** The two apps' eslint configs have essentially no overlap:
backend uses ESLint 9 flat config bridging `eslint-config-next` through `FlatCompat`,
plus a bespoke `no-restricted-properties` rule that forbids reading `JWT_SECRET`,
`DATABASE_URL`, and the token-expiry vars off `process.env` outside two allowlisted
files; frontend is a five-line CommonJS file spreading `eslint-config-expo/flat`. The
tsconfigs likewise diverge — backend's is Next-shaped and standalone, frontend's
extends `expo/tsconfig.base`. The only things they truly duplicate are `strict: true`,
`@/*` path-alias conventions, and build-output ignore globs. No shared types package
exists, so the API contract between the Expo app and the Next.js API is not expressed
anywhere.

**Paths are hardcoded across sixteen-plus files.** Both Dockerfiles build with the repo
root as context and hardcode app-relative COPY paths; both `railway.toml` files name
their Dockerfile by path and scope `watchPatterns` to `backend/**` / `frontend/**`; CI
sources `backend/.env.ci`; `.dockerignore` and `.github/dependabot.yml` name `backend`
and `frontend` directly; and two backend tests resolve upward out of the backend
directory to assert against repo-root documentation.

## Desired State

The repo uses the conventional monorepo layout, and one task runner owns the task graph.

```
ansari/
├── apps/
│   ├── backend/
│   └── frontend/
├── packages/
│   ├── eslint-config/
│   ├── tsconfig/
│   └── types/
├── turbo.json
├── package.json
└── pnpm-workspace.yaml
```

**Root scripts mean what they say.** `pnpm dev`, `pnpm lint`, `pnpm typecheck`,
`pnpm test`, and `pnpm build` all delegate to `turbo run <task>` and all cover every
workspace package that defines the task. In particular `pnpm dev` brings up **both**
apps, which is not possible today.

**Ordering is declared, not shell-chained.** The frontend's dependency on uniwind
codegen is a Turborepo `dependsOn` edge, so `typecheck` and the web build each wait on
the codegen task rather than re-running it inline via `&&`. Task `outputs` are
declared, so a repeat run of an unchanged task is a cache hit, and `dev` is marked
persistent and uncached.

**Shared configuration has a home.** `packages/eslint-config` and `packages/tsconfig`
hold whatever the two apps genuinely share, and each app extends the shared base rather
than restating it. `packages/types` exists as a real, installable workspace package
ready to carry API contract types — scaffolded minimally, with no contracts invented
ahead of a consumer that needs them.

**Every path consumer is updated in the same change**, so a fresh clone can be set up,
built, tested, containerised, and deployed by following the documentation verbatim.

## Success Criteria

- [ ] `pnpm install` is clean from the repo root, and the repo still has exactly one
      lockfile (`pnpm-lock.yaml`) with no per-package lockfiles.
- [ ] `pnpm dev` starts **both** the backend and the frontend.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` each run through
      Turborepo and each cover every workspace package that defines that task.
- [ ] A second identical `turbo run build` with no intervening changes reports FULL
      TURBO (all tasks cache hits).
- [ ] `turbo run typecheck --filter ansari-frontend` succeeds from a clean tree in
      which `uniwind-types.d.ts` does not exist, proving the codegen edge is a real
      graph dependency and not an accident of a previously generated file.
- [ ] The full backend Vitest suite passes (61 test files), with **no reduction in the
      set of passing tests** relative to `develop`.
- [ ] `backend/tests/release-doc.test.ts` and `backend/tests/self-hosting-docs.test.ts`
      are **verified to still assert against the real repo root** — demonstrated by a
      deliberate negative check (temporarily breaking a referenced path makes the test
      fail), not merely by observing green.
- [ ] `docker build -f apps/backend/Dockerfile .` succeeds from the repo root.
- [ ] `docker build -f apps/frontend/Dockerfile.web .` succeeds from the repo root.
- [ ] No file tracked in the repo still refers to a top-level `backend/` or `frontend/`
      path, except where the reference is deliberately historical (existing
      `codev/specs`, `codev/plans`, `codev/reviews`, `codev/projects`, `codev/state`
      records, and `.gitleaksignore` commit fingerprints, which pin history and must
      not be rewritten).
- [ ] `git log --follow` on a representative moved file (e.g. the backend Dockerfile)
      still shows its pre-move history.
- [ ] CI is green on the PR, and CI exercises both apps through Turborepo.
- [ ] Docs (`README.md`, `CONTRIBUTING.md`, `RELEASE.md`, `docs/self-hosting.md`,
      `SECURITY.md`, and the per-app READMEs / AGENTS.md / CLAUDE.md) describe the new
      layout and the new root scripts accurately enough that a fresh clone can be set
      up by following them verbatim.
- [ ] The out-of-repo Railway change required by this move (see Risks) is documented in
      the PR description and in `RELEASE.md` as an explicit operator action.

## Constraints

Copied verbatim from issue #48 and treated as fixed architectural decisions:

> - **pnpm only.** One root `pnpm-lock.yaml`; no per-package lockfiles. Turborepo is the
>   task runner, not the package manager.
> - **Do not touch DB migration flow.** `db:generate` / `db:migrate` stay as-is and
>   `db:push` stays forbidden.
> - Use `git mv` for the moves so blame/history survives.
> - Frontend `typecheck` depends on `gen:types` (uniwind codegen) running first —
>   model that as a real Turborepo dependency, not a shell `&&`.

Also fixed by the issue: the target layout is `apps/backend`, `apps/frontend`,
`packages/eslint-config`, `packages/tsconfig`, `packages/types`, and `turbo.json` —
those names and locations are the architect's choice, not open for re-derivation.
`packages/types` is scaffolded minimally: **do not invent contracts.**

Further constraints imposed by the existing system:

- **No behaviour change.** This is a layout and tooling change. No application source
  logic, no API surface, no database schema, and no runtime configuration semantics may
  change. The only source edits permitted are path corrections and config extraction.
- **Package names stay.** `ansari-backend` and `ansari-frontend` are referenced by CI,
  both Dockerfiles, and prose across the docs. Renaming them would multiply the blast
  radius for no benefit.
- **The `catalog:` and `onlyBuiltDependencies` blocks in `pnpm-workspace.yaml` survive
  intact.** The catalog pins `typescript: ~6.0.3`; `onlyBuiltDependencies` allowlists
  postinstall scripts for bcrypt, sharp, esbuild, `@sentry/cli`, `unrs-resolver`,
  protobufjs, and `@google/genai`. Dropping either breaks installs.
- **The backend eslint config's `no-restricted-properties` env guard is load-bearing**
  (it enforces a critical architectural invariant: auth secrets are read only through
  the validated `config` object). Any eslint extraction must preserve it, its messages,
  and its two-file allowlist exactly. `backend/tests/eslint-env-guard.test.ts` lints
  through the real composed config and is the regression net for this.
- **Both Docker builds use the repo root as build context** because the pnpm workspace
  needs the root lockfile. That property must be preserved.
- **Node ≥ 22, pnpm ≥ 10**, pinned via `.nvmrc` and `packageManager`.
- **History-pinning files must not be rewritten**: `.gitleaksignore` fingerprints are
  `commit:file:rule:line` tuples referencing historic commits under `backend/`, and
  prior `codev/` artifacts are immutable records of past work.

## Assumptions

- Turborepo is compatible with this stack. Turborepo is package-manager agnostic and
  supports pnpm workspaces natively; it discovers packages from `pnpm-workspace.yaml`.
  The version to adopt is pinned as a root devDependency and invoked via `pnpm exec` /
  package scripts rather than a global install.
- **The frontend gains a `dev` script.** It currently has `start` (`expo start`) and no
  `dev`. The success criterion "`pnpm dev` starts both apps" is unachievable without
  adding one; adding an alias is assumed to be in scope as a path/plumbing change.
- **The frontend's `build` task must be decided.** The frontend has `build:web`
  (`expo export --platform web`) but no `build`. See Open Questions.
- Railway deployment configuration lives partly outside the repo (each service's "config
  file path" setting points at `backend/railway.toml` / `frontend/railway.toml`). This
  spec assumes a human with Railway access will update those two settings at merge time;
  the repo change alone cannot.
- The 9 open Dependabot PRs targeting `dependabot/npm_and_yarn/backend/*` will conflict
  with this move. This spec assumes they are disposable — Dependabot recreates them
  against the new directory after `.github/dependabot.yml` is updated.
- No consumer outside this repo depends on the `backend/` or `frontend/` top-level paths
  other than the Railway settings noted above.
- Turborepo's local filesystem cache is sufficient for the FULL TURBO acceptance
  criterion. Remote caching (Vercel or self-hosted) is explicitly out of scope.

## Solution Approaches

The target layout and the choice of Turborepo are fixed by the issue. What remains open
is **how the change is sequenced and verified**, and **how much the shared packages
actually absorb**. Those are the axes explored here.

### Approach 1: Single atomic change — move, adopt Turbo, extract packages, fix all consumers together

One coherent change set: `git mv` both apps, add `turbo.json` and the root Turbo
scripts, create all three shared packages and rewire the apps onto them, and update
every path consumer — all landing together.

**Pros.** The repo is never in an inconsistent state on any commit. There is exactly one
"everything moved" moment for reviewers and for downstream branches to rebase past. No
transitional shims to write and later delete.

**Cons.** The diff is enormous and mixes a mechanical rename with genuine design work
(what belongs in the shared eslint config?). A reviewer cannot separate "this is just a
move" from "this changed behaviour", which is exactly where a silent breakage hides —
and the two doc-consistency tests are precisely the kind of thing that can be made to
pass wrongly during a large mechanical sweep. Bisecting a later regression lands on one
giant commit.

**Risk/complexity.** High risk, moderate complexity. The risk is not that it fails
loudly; it is that something passes for the wrong reason.

### Approach 2: Sequenced phases within one PR — move first, then Turbo, then shared packages

The same end state, reached as ordered commits on one branch: (1) the directory move
plus every path-consumer fix, with the existing `pnpm --filter` scripts untouched and
the full suite green; (2) Turborepo adoption — `turbo.json`, root scripts rewired, CI
moved onto `turbo run`, `dev` covering both apps; (3) shared-package extraction, one
package at a time, each with the apps rewired onto it.

**Pros.** Commit 1 is verifiable in isolation: if the suite is green and the two
doc-consistency tests still assert against the real repo root, the move is correct
independent of anything Turbo does. Each subsequent commit changes exactly one thing, so
a reviewer reads a rename as a rename and a design decision as a design decision.
Bisect works. If shared-package extraction turns out thinner than hoped (see Open
Questions), phases 1–2 still stand on their own.

**Cons.** More discipline required; the branch must stay green at each commit, which
means the doc updates have to be split to match (docs describing per-app scripts in
commit 1, docs describing root turbo scripts in commit 2). Slightly more total work.

**Risk/complexity.** Moderate complexity, low risk.

### Approach 3: Move only, defer Turborepo and shared packages

Ship `apps/backend` + `apps/frontend` and the path fixes; leave the root scripts as
`--filter` aliases and open follow-ups for Turborepo and the shared packages.

**Pros.** Smallest, safest, fastest change. Delivers the layout convention immediately.

**Cons.** Leaves the actual complaint unaddressed — the misleading root scripts, the
absent task graph, and the cold runs are the reason the issue exists. It also guarantees
a second repo-wide churn later. The issue's acceptance criteria explicitly require
Turborepo and the shared packages, so this does not satisfy the spec.

**Risk/complexity.** Low risk, low complexity, but it is not the requested change. Listed
because it is the natural fallback if Turborepo adoption hits an unforeseen blocker with
Expo/Metro — in that case, shipping the move and escalating the blocker beats stalling.

### Recommendation

**Approach 2.** The dominant risk in this change is a silent wrong-path failure, not a
loud one — and the single most valuable mitigation is being able to verify the move on
its own, before Turbo and the shared packages change what "green" even means. Approach 2
buys exactly that for the cost of ordering discipline. It ships as one PR (per the
project's PR strategy: plan phases are commits, not PRs), so it costs reviewers nothing
extra relative to Approach 1 while giving them a readable commit-by-commit narrative.

## Open Questions

**Critical (blocks progress)**

1. **Do the shared packages carry real content, or are they scaffolds?** The two apps'
   eslint configs share essentially nothing: Next+FlatCompat+bespoke env guard versus a
   five-line Expo spread. The tsconfigs share `strict: true` and little else, and the
   frontend's already extends `expo/tsconfig.base`. An honest extraction yields a very
   thin `packages/eslint-config` (shared ignore globs, perhaps a shared rule floor) and
   a thin `packages/tsconfig` (`strict`, `skipLibCheck`, `esModuleInterop`,
   `isolatedModules`, `resolveJsonModule`). **Question for the architect:** is a
   deliberately thin shared base — created now so future shared rules have a home —
   the intent, or should the extraction be pushed further (e.g. moving the backend's
   `no-restricted-properties` guard into the shared package)? Recommendation: keep it
   thin and honest, and leave the env guard in the backend where its allowlist paths
   are meaningful. This shapes what "done" means for scope item 3.
2. **Does `packages/types` get a consumer, or does it ship unimported?** The issue says
   scaffold it and do not invent contracts, which implies nothing imports it initially.
   An unimported package still costs install, lint, typecheck, and build surface.
   **Question:** ship it truly empty (a placeholder export), or seed it with the one
   contract that already exists implicitly — the shape the Expo app receives from the
   backend's API — by extracting rather than inventing? Recommendation: ship it with a
   placeholder export plus the task scripts wired, so the graph is exercised; extract
   real contracts in a follow-up when a consumer exists.
3. **What does `turbo run build` mean for the frontend?** The frontend has no `build`,
   only `build:web` (a full `expo export`, which is slow and needs the uniwind codegen).
   Options: (a) leave the frontend out of `build` and treat `build` as backend-only but
   *documented* as such; (b) alias frontend `build` → `build:web`, making `pnpm build`
   genuinely repo-wide but noticeably slower; (c) define a lighter frontend `build`.
   The acceptance criterion hedges with "where applicable". **Recommendation: (b)** —
   the whole point of the issue is that root scripts should not silently mean
   "backend only", and Turbo's cache makes the repeat cost near zero.

**Important (shapes design)**

4. **How is CI restructured?** Today there are two parallel jobs (backend, frontend)
   plus gitleaks. Turborepo invites a single job running `turbo run lint typecheck test
   build`, which is simpler and gets cross-app caching, but loses the parallel wall-clock
   and the clear per-app job names in the PR checks UI. Recommendation: keep the two-job
   split, with each job running `turbo run <tasks> --filter <app>`, so PR check names
   stay stable and the change to CI stays legible.
5. **Should `.turbo` be cached in CI?** Not required by any acceptance criterion, and it
   adds a cache-key correctness surface. Recommendation: no, in this PR; revisit once
   the layout is stable.
6. **Should Dependabot gain `apps/frontend` and `packages/*` coverage?** Today it only
   watches `/backend` — the frontend has never been covered. Correcting `/backend` →
   `/apps/backend` is squarely in scope; *adding* coverage is a policy expansion.
   Recommendation: fix the path in scope, propose the expansion separately.
7. **Does `pnpm dev` running Expo under Turbo remain usable?** `expo start` is an
   interactive TUI (keypress commands for iOS/Android/reload). Multiplexed under
   `turbo run dev` alongside `next dev`, that interactivity may degrade. If it does,
   the fallback is that `pnpm dev` starts both while the per-app scripts remain the
   documented path for interactive Expo work.

**Nice-to-know**

8. Should the root `package.json` keep the `backend` / `frontend` convenience aliases
   (`pnpm backend <script>`), now pointing at the same filters? They are cheap and
   still useful for per-app scripts Turbo does not model (`db:migrate`, `ios`, `web`).
   Recommendation: keep them.
9. Is there appetite to also move `docs/` under a package, or add a `packages/` README
   explaining the convention? Neither is required.

## Test Scenarios

**Verification of the move (the highest-risk area)**

- *The two doc-consistency tests still point at the real repo root.* Positive check:
  both suites pass. **Negative check (required):** temporarily rename a file that
  `release-doc.test.ts` asserts exists (e.g. `apps/backend/railway.toml`) and confirm
  the test **fails**; likewise remove a distinguishing error phrase from
  `startup-checks.ts` and confirm `self-hosting-docs.test.ts` fails. A test that passes
  because it is looking at nothing is the specific failure mode this change invites.
- *No stale path survives.* A repo-wide search for top-level `backend/` and `frontend/`
  path references returns only the deliberately historical records enumerated in
  Success Criteria.
- *History survived.* `git log --follow` on moved files shows pre-move commits.

**Task graph**

- `pnpm dev` starts both apps; the backend serves `/api/health` and the Expo dev server
  comes up.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` each run through Turbo and
  each report a task for every package that defines it.
- *Cache.* `turbo run build` twice with no changes → second run is FULL TURBO. Then
  touch one backend source file → backend build re-runs, frontend build stays cached.
- *Codegen edge is real.* Delete `apps/frontend/uniwind-types.d.ts`, then run
  `turbo run typecheck --filter ansari-frontend`: it must succeed, having run `gen:types`
  as a graph dependency. Removing the `dependsOn` edge must make it fail — confirming
  the edge, not a leftover file, is what makes it work.
- *`dev` is persistent and uncached*: `turbo run dev` does not exit and does not report a
  cache hit on a second invocation.

**Containers and deployment config**

- `docker build -f apps/backend/Dockerfile .` succeeds from the repo root, including the
  `--frozen-lockfile --filter ansari-backend` install step — which must still resolve
  after the apps gain `workspace:` devDependencies on the shared packages.
- `docker build -f apps/frontend/Dockerfile.web .` succeeds from the repo root and the
  Caddy stage finds the exported SPA.
- Both `railway.toml` files name Dockerfile paths that exist and `watchPatterns` that
  match the new tree.

**Regression / non-functional**

- Full backend Vitest suite (61 files) green, no test removed or skipped.
- `eslint-env-guard.test.ts` green **after** the eslint extraction — proving the
  `no-restricted-properties` env guard still fires tree-wide and still stays silent in
  `lib/config.ts` and `drizzle.config.ts`.
- `pnpm install --frozen-lockfile` succeeds (lockfile committed and consistent).
- gitleaks scan green over full history (`.gitleaksignore` fingerprints untouched).
- *Fresh-clone doc walkthrough:* follow `CONTRIBUTING.md` and `docs/self-hosting.md`
  verbatim from a clean clone; every command runs as written.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A repo-root-relative test silently asserts against `apps/` instead of the repo root — passing while checking nothing | High | High | Explicit negative checks on both doc-consistency tests (see Test Scenarios); never accept "it's green" as evidence for these two |
| Railway deploys break: each service's *config file path* is a dashboard setting pointing at `backend/railway.toml` — outside the repo, unfixable by this PR | High | High | Call it out in the PR description and `RELEASE.md` as a required operator action, and coordinate merge timing with someone who has Railway access; verify both services after merge |
| `frontend/Dockerfile.web`, `frontend/railway.toml`, and `frontend/Caddyfile` are **not listed** in the issue's path-consumer inventory and get missed, silently breaking the frontend web deploy | Medium | High | Treat the issue's list as incomplete; the spec's inventory is the checklist, and the "no stale path survives" scan is the backstop |
| Docker build breaks once apps devDepend on `packages/*` via `workspace:` — the Dockerfile copies only root manifests plus the app's `package.json`, so `--frozen-lockfile` cannot resolve the workspace links | Medium | High | Both Docker builds are acceptance criteria and must be run locally, not assumed; the fix is copying `packages/*/package.json` into the manifest layer |
| `release-doc.test.ts` asserts RELEASE.md *contains* literal `backend/...` strings **and** that every `pnpm <script>` it names exists in the backend's `package.json` — doc and test are coupled in both directions, and root-level turbo scripts break the second assertion | Medium | Medium | Update doc and test as one unit; decide deliberately whether RELEASE.md quotes app-scoped or root scripts, and make the test's assumption explicit rather than incidental |
| The shared eslint/tsconfig packages turn out near-empty, adding indirection for no benefit | Medium | Low | Resolve Open Question 1 with the architect before building them; prefer a thin, honest base over a contrived one |
| `expo start` becomes unusable multiplexed under `turbo run dev` | Medium | Low | Verify interactively; if degraded, document per-app scripts as the path for interactive Expo work while `pnpm dev` still satisfies the both-apps criterion |
| 9 open Dependabot PRs against `/backend` all conflict | High | Low | Update `.github/dependabot.yml` to `/apps/backend`; close the stale PRs and let Dependabot recreate them |
| `git mv` fails to preserve blame because a file is also edited in the same commit | Low | Medium | Move and edit in separate commits (Approach 2 does this naturally); verify with `git log --follow` |
| Lockfile churn from adding Turborepo and three new workspace packages masks an unintended dependency change | Low | Medium | Review the `pnpm-lock.yaml` diff for entries unrelated to turbo and the new packages |
| Build/cache artifacts (`.turbo/`) get committed | Low | Low | Add `.turbo` to `.gitignore` and `.dockerignore` alongside the existing `.next` / `dist` entries |

## References

- Issue #48 — *Standardise to apps/ + packages/ monorepo layout and introduce Turborepo*
  (source of the target layout, scope, constraints, and acceptance criteria).
- `codev/specs/3-open-source-readiness-node-22-.md` — established the Node 22 baseline,
  the eslint flat config, and the CI shape this change rewires.
- `codev/specs/4-auth-hardening-admin-roles-in-.md` — origin of the
  `no-restricted-properties` config-bypass guard that the eslint extraction must preserve.
- PR #35 (*Monorepo conversion: pnpm workspace, frontend skeleton, EAS + web deployment*)
  and PR #36 (*Backend Railway Dockerfile cutover + pnpm docs sweep*) — created the
  current flat workspace, both Dockerfiles, and the pnpm docs this change supersedes.
- `codev/resources/arch-critical.md` — the DB-migration and config-boundary invariants
  this change must not disturb.
- Turborepo documentation: task graph (`dependsOn`), `outputs` and caching, `persistent`
  tasks, and pnpm workspace discovery.
