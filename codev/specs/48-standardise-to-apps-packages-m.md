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
│   ├── api/          (was backend/)  — package `ansari-api`
│   └── frontend/                     — package `ansari-frontend`
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

**The layout is ready for a second service.** A planned `apps/auth` (auth extracted from
today's backend) slots in alongside `apps/api` on the same naming axis, without renaming
anything that this change puts in place. That extraction is **not** part of this spec.

```
apps/
├── api/          the product engine — threads, chat, facilitator, tools, admin stats
├── auth/         FUTURE, out of scope here
└── frontend/     the Ask Ansari client (iOS, Android, web)
```

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
- [ ] The full backend Vitest suite passes with **no reduction in the set of passing
      tests relative to the `develop` baseline**. The baseline is captured by running the
      suite on `develop` before the move and comparing test-name sets, not counts — a
      count alone cannot distinguish "a test was renamed" from "a test stopped being
      collected". (For orientation: `develop` currently has 66 test files under
      `backend/tests`, including the `api/`, `lib/`, and `migration/` subdirectories.)
- [ ] `apps/api/tests/release-doc.test.ts` and `apps/api/tests/self-hosting-docs.test.ts`
      are **verified to still assert against the real repo root** — demonstrated by a
      deliberate negative check (temporarily breaking a referenced path makes the test
      fail), not merely by observing green.
- [ ] `docker build -f apps/api/Dockerfile .` succeeds from the repo root.
- [ ] `docker build -f apps/frontend/Dockerfile.web .` succeeds from the repo root.
- [ ] No file tracked in the repo still refers to a top-level `backend/` or `frontend/`
      path, except where the reference is deliberately historical (existing
      `codev/specs`, `codev/plans`, `codev/reviews`, `codev/projects`, `codev/state`
      records, and `.gitleaksignore` commit fingerprints, which pin history and must
      not be rewritten).
- [ ] `git log --follow` on a representative moved file (e.g. the api Dockerfile)
      still shows its pre-move history. Note the rename compounds move+rename, so this
      check matters more than it would for a plain move.
- [ ] CI is green on the PR and runs the following explicit task matrix through
      Turborepo, with no task silently dropped relative to today:
      - api (was backend): `lint`, `typecheck`, `test:coverage`, `build`
      - frontend: `lint`, `typecheck` (which must pull `gen:types` in via the graph),
        and `build`
      - shared packages: `lint` and `typecheck` for every package under `packages/`
        that defines them
      - gitleaks continues to run over full history, unchanged
      Frontend `build` running in CI is a **new** check that does not exist today; it is
      required so that `pnpm build` meaning "both apps" is actually enforced rather than
      merely claimed.
- [ ] **Shared-config extraction is behaviour-preserving, demonstrated not asserted.**
      For ESLint: for each app, the set of rule violations reported over its real source
      tree is identical before and after extraction (captured by running eslint with a
      machine-readable formatter on `develop` and on the branch, and diffing). For
      TypeScript: for each app, the fully-resolved compiler options
      (`tsc --showConfig`) are unchanged before and after extraction, or every
      difference is individually enumerated and justified in the PR description.
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

**Single-PR delivery (architect decision, 2026-08-20).** The directory move and the
Turborepo introduction land together in **one PR**. The work must not be staged across
two PRs, because a staged split would leave `turbo.json` briefly encoding a layout that
is about to change. Internal commit granularity within that single PR is unconstrained
by this decision — but any ordering chosen must never author `turbo.json` against the
pre-move layout.

Also fixed by the issue: the target layout is `apps/*` + `packages/eslint-config`,
`packages/tsconfig`, `packages/types`, and `turbo.json` — those locations are the
architect's choice, not open for re-derivation. `packages/types` is scaffolded
minimally: **do not invent contracts.** The one deviation is the backend app's name
(`apps/backend` → `apps/api`), decided by the human and recorded immediately below.

**Shared package names are scoped `@ansari/*`** — `@ansari/eslint-config`,
`@ansari/tsconfig`, `@ansari/types` — while the two apps keep flat, unscoped names
(`ansari-api`, `ansari-frontend`). Rationale: the apps are private and never published,
whereas the scope on the shared packages signals "internal, workspace-only" at every
import site and cannot collide with a public npm name. Decided default; cheap for the
architect to override at `spec-approval` in favour of flat `ansari-*` names.

Further constraints imposed by the existing system:

- **No behaviour change.** This is a layout and tooling change. No application source
  logic, no API surface, no database schema, and no runtime configuration semantics may
  change. The only source edits permitted are path corrections and config extraction.
- **The backend app is renamed to `api`; the frontend keeps its name** (human decision,
  2026-08-20, superseding the `apps/backend` name in issue #48's target layout — the
  architect was notified). Directory `backend/` → `apps/api`, package `ansari-backend` →
  `ansari-api`. Frontend is unchanged: `frontend/` → `apps/frontend`, package
  `ansari-frontend`.
  **Reasoning:** an `apps/auth` service is planned (auth extraction out of the backend).
  "backend" is a *tier* name while "auth" is a *domain* name; once both exist,
  `apps/backend` is ambiguous, because auth is backend code too. `apps/api` sits on the
  same axis as `auth`, and remains a good name even if the auth split never happens — so
  this is not a speculative bet. The rename is nearly free **only if done here**: every
  path consumer it touches is already being rewritten by this change. Deferring it costs
  a second full sweep of the same files plus a second Railway dashboard coordination,
  which is this spec's one High-probability/High-impact out-of-repo risk.
  **The rename is strictly a rename** — no route, module, or behaviour boundary moves in
  this change. Extracting `apps/auth` is explicitly **out of scope** here and is a future
  piece of work; this spec only ensures the layout it will land into is coherent.
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

The target layout, the choice of Turborepo, and single-PR delivery are all fixed (see
Constraints). What remains open is **the commit granularity inside that one PR** — which
determines how verifiable the change is for a reviewer — and **how much the shared
packages actually absorb**. Those are the axes explored here. All approaches below ship
as exactly one PR; they differ only in how that PR's history is organised.

### Approach 1: One atomic commit — move, adopt Turbo, extract packages, fix all consumers together

The entire change as a single commit: `git mv` both apps, add `turbo.json` and the root
Turbo scripts, create all three shared packages and rewire the apps onto them, and update
every path consumer.

**Pros.** The tree is never in an intermediate state on any commit. Nothing transitional
is written and later deleted.

**Cons.** The diff is enormous and fuses a mechanical rename with genuine design work
(what belongs in the shared eslint config?). A reviewer cannot separate "this is just a
move" from "this changed behaviour" — and that is precisely where a silent breakage
hides, because the two doc-consistency tests can be made to pass wrongly during a large
mechanical sweep. A later bisect lands on one giant commit and tells you nothing.

**Risk/complexity.** High risk, moderate complexity. The risk is not that it fails
loudly; it is that something passes for the wrong reason.

### Approach 2: Ordered commits within the one PR — move first, then Turbo, then shared packages

The same PR, organised as ordered commits: (1) the directory move **together with** every
path-consumer fix in the same commit — the move and the path fixes are one indivisible
unit, because a move-only commit would leave the tree broken — with the existing
`pnpm --filter` scripts untouched and the full suite green; (2) Turborepo adoption — `turbo.json`, root scripts rewired, CI moved onto
`turbo run`, `dev` covering both apps; (3) shared-package extraction, one package at a
time, each with the apps rewired onto it.

Note that this ordering **satisfies the architect's rationale for single-PR delivery
directly**: `turbo.json` does not exist until commit 2, by which point the tree is
already in its final layout. At no point is `turbo.json` authored against the pre-move
layout.

**Pros.** Commit 1 is verifiable in isolation: if the suite is green and the two
doc-consistency tests still assert against the real repo root, the move is correct
independent of anything Turbo does. Each subsequent commit changes exactly one thing, so
a reviewer reads a rename as a rename and a design decision as a design decision. Bisect
works.

**Cons.** More discipline required; the branch must stay green at each commit, which
means doc updates split to match (docs describing per-app scripts in commit 1, docs
describing root turbo scripts in commit 2). Slightly more total work.

**Risk/complexity.** Moderate complexity, low risk.

### Approach 3: Turbo first, then move — RULED OUT

Adopt Turborepo against the current flat layout, then move the directories and rewrite
`turbo.json` and every path.

**Ruled out** by the architect's single-PR rationale: it is the ordering that leaves
`turbo.json` encoding a layout that is about to change. Recorded here only so the
rejected ordering is explicit and not re-proposed during planning.

### Also ruled out: deferring Turborepo to a follow-up PR

Shipping the move alone and opening a follow-up for Turborepo and the shared packages
would be smaller and safer, but it is a two-PR staging of exactly the kind the architect's
decision excludes, and it leaves the issue's actual complaint — misleading root scripts,
no task graph, cold runs — unaddressed. It is **not** an available option.

If Turborepo adoption hits a genuine hard blocker (e.g. an irreconcilable Expo/Metro
interaction), the correct response is to **escalate to the architect**, not to
unilaterally fall back to a move-only PR.

### Recommendation

**Approach 2.** The dominant risk in this change is a silent wrong-path failure, not a
loud one — and the single most valuable mitigation is being able to verify the move on
its own, before Turbo and the shared packages change what "green" even means. Approach 2
buys exactly that for the cost of ordering discipline, ships as the one PR the architect
directed, and never writes `turbo.json` against a stale layout.

## Open Questions

The three questions that would otherwise block planning are **resolved below as decided
defaults**, so the plan can proceed without waiting. Each records the decision, the
reasoning, and what would change if the architect overrides it at the `spec-approval`
gate. They are called out here rather than buried in Constraints precisely because they
are the builder's calls, not the architect's — an override is cheap now and expensive
later.

**Resolved (decided default; architect may override at spec-approval)**

1. **The shared config packages are deliberately thin, and the env guard stays in the
   backend.** The two apps' eslint configs share essentially nothing: Next + FlatCompat +
   the bespoke env guard versus a five-line Expo spread. The tsconfigs share `strict` and
   little else, and the frontend's already extends `expo/tsconfig.base`.
   **Decision:** `packages/eslint-config` carries only what is genuinely common (shared
   build-output ignore globs and any rule both apps already agree on);
   `packages/tsconfig` carries a base of `strict`, `skipLibCheck`, `esModuleInterop`,
   `isolatedModules`, and `resolveJsonModule`. The backend's `no-restricted-properties`
   env guard **stays in the backend**, because its allowlist (`lib/config.ts`,
   `drizzle.config.ts`) is expressed in backend-relative paths and is meaningless in a
   package shared with an Expo app.
   **Reasoning:** a thin base that gives future shared rules a home beats a contrived one
   that forces unrelated config together. The extraction is a refactor, so it is bounded
   by the behaviour-preservation criterion in Success Criteria.
   *If overridden* (push the extraction further, e.g. moving the env guard): the
   allowlist must become path-portable, and `eslint-env-guard.test.ts` needs rework —
   materially more work, and it weakens a load-bearing security guard's locality.

2. **`packages/types` ships as a real package with a placeholder export and no
   consumer.** The issue is explicit: scaffold it, do not invent contracts.
   **Decision:** it gets a `package.json`, a tsconfig extending the shared base, working
   `lint`/`typecheck` scripts, and a single placeholder export. Nothing imports it yet.
   **Reasoning:** wiring the task scripts means the package is exercised by the task
   graph from day one, so the first real contract lands in a package already proven to
   build — rather than discovering the scaffold was wrong at the moment someone needs it.
   *If overridden* (seed it with the real backend↔frontend API contract): that is
   extraction, not invention, but it is a materially larger change touching both apps'
   source, and it would breach this spec's no-behaviour-change constraint.

3. **Frontend `build` aliases `build:web`, so `pnpm build` genuinely covers both apps.**
   **Decision:** add a `build` script to the frontend delegating to `build:web`
   (`expo export --platform web`), with `gen:types` as a graph dependency rather than a
   shell `&&`.
   **Reasoning:** the entire point of the issue is that root scripts must stop silently
   meaning "backend only". Option (a) — leaving `build` backend-only but documenting it —
   reproduces the exact defect being fixed. `expo export` is slow, but Turbo's cache
   makes the repeat cost near zero, and CI already pays this cost nowhere else.
   *If overridden* (keep `build` backend-only): the "covers both apps" success criterion
   and the frontend-build CI check must both be struck, and the docs must state the
   asymmetry loudly.

**Important (shapes design, does not block)**

4. **How is CI restructured?** Recommendation: keep the existing two-job split, each job
   running `turbo run <tasks> --filter <app>`, so PR check names stay stable and the CI
   diff stays legible. A single-job `turbo run` across everything would be simpler and
   get cross-app caching, but loses parallel wall-clock and per-app check names. The
   required task matrix either way is pinned in Success Criteria.
5. **Should `.turbo` be cached in CI?** Recommendation: no, not in this PR — it adds a
   cache-key correctness surface for no acceptance-criterion benefit. Revisit once the
   layout is stable.
6. **Should Dependabot gain `apps/frontend` and `packages/*` coverage?** Today it watches
   only `/backend`; the frontend has never been covered. Correcting `/backend` →
   `/apps/api` is in scope; *adding* coverage is a policy expansion.
   Recommendation: fix the path here, propose the expansion separately.
7. **Does `pnpm dev` running Expo under Turbo remain usable?** `expo start` is an
   interactive TUI (keypress commands for iOS/Android/reload); multiplexed under
   `turbo run dev` alongside `next dev`, that interactivity may degrade. This is a
   verify-in-practice item. If it degrades, `pnpm dev` still satisfies the both-apps
   criterion while the per-app scripts remain the documented path for interactive Expo
   work — and that caveat must then be written into the docs, not left as folklore.

**Nice-to-know**

8. Should the root `package.json` keep the `backend` / `frontend` convenience aliases
   (`pnpm backend <script>`)? They remain useful for per-app scripts Turbo does not model
   (`db:migrate`, `ios`, `web`). Recommendation: keep them.
9. Should `packages/` get a README explaining the convention? Cheap, not required.

## Test Scenarios

**Verification of the move (the highest-risk area)**

- *The two doc-consistency tests still point at the real repo root.* Positive check:
  both suites pass. **Negative check (required):** temporarily rename a file that
  `release-doc.test.ts` asserts exists (e.g. `apps/api/railway.toml`) and confirm
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
  touch one api source file → the api build re-runs, frontend build stays cached.
- *Codegen edge is real.* Delete `apps/frontend/uniwind-types.d.ts`, then run
  `turbo run typecheck --filter ansari-frontend`: it must succeed, having run `gen:types`
  as a graph dependency. Removing the `dependsOn` edge must make it fail — confirming
  the edge, not a leftover file, is what makes it work.
- *`dev` is persistent and uncached*: `turbo run dev` does not exit and does not report a
  cache hit on a second invocation.

**Containers and deployment config**

- `docker build -f apps/api/Dockerfile .` succeeds from the repo root, including the
  `--frozen-lockfile --filter ansari-api` install step — which must still resolve
  after the apps gain `workspace:` devDependencies on the shared packages.
- `docker build -f apps/frontend/Dockerfile.web .` succeeds from the repo root and the
  Caddy stage finds the exported SPA.
- Both `railway.toml` files name Dockerfile paths that exist and `watchPatterns` that
  match the new tree.

**Regression / non-functional**

- Full api Vitest suite green against the `develop` baseline, no test removed or skipped.
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
| 9 open Dependabot PRs against `/backend` all conflict | High | Low | Update `.github/dependabot.yml` to `/apps/api`; close the stale PRs and let Dependabot recreate them |
| Rename detection fails, losing blame/history on a moved file | Low | Medium | Git records no rename — it infers one at diff time from content similarity, so moving and path-fixing a file in the *same* commit is safe as long as similarity stays above threshold, which it does for edits this small. Do **not** split move from path-fix into separate commits: a move-only commit would leave path consumers broken and unbuildable. Verify with `git log --follow` and `git show -M --stat` on the moved files instead |
| The `ansari-backend` → `ansari-api` package rename is missed in one `--filter` call site, so a task silently no-ops instead of failing | Medium | High | `turbo run` errors on an unmatched `--filter`, unlike some pnpm paths; additionally grep for the old package name repo-wide as part of the "no stale path survives" scan, and confirm every CI job reports the tasks it is supposed to run rather than zero |
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
