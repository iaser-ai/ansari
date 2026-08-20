# Plan: Standardise to apps/ + packages/ monorepo layout and introduce Turborepo

**Specification**: [`codev/specs/48-standardise-to-apps-packages-m.md`](../specs/48-standardise-to-apps-packages-m.md)

## Executive Summary

Implements the spec's **Approach 2** — ordered commits inside a **single PR** (architect
decision; the work must not be staged across two PRs). The ordering is load-bearing rather
than cosmetic:

1. **The move lands first, complete and green**, before Turborepo exists. This is the
   spec's core risk mitigation: if the suite passes and the two doc-consistency tests still
   assert against the real repo root, the move is correct *independently* of anything Turbo
   later changes about what "green" means.
2. **`turbo.json` is therefore only ever authored against the final layout** — which is
   precisely the architect's stated rationale for single-PR delivery.
3. **Shared packages come last, one per phase.** They are the only phases containing design
   judgement rather than mechanical rewriting, so they are isolated where a reviewer can
   see them as such.

Two structural constraints from the spec shape the phase boundaries:

- **Phase 1 is indivisible.** A move-only commit cannot be green — every path consumer
  breaks at once, and `release-doc.test.ts` asserts on RELEASE.md's *contents*, so the doc
  must move with the code. Move + path-fix + doc rewrite are one atomic commit.
- **Docs are touched twice, deliberately.** Phase 1 rewrites them for the new paths while
  the per-app `pnpm --filter` scripts still exist; Phase 2 rewrites the command blocks
  again for the root `turbo run` scripts. Each commit is internally coherent; trying to do
  it once would leave one of the two commits describing a repo that does not exist.

Phase 6 exists because the spec's highest-value criteria — no stale path survives, both
images build, both `railway.toml` globs actually match, the fresh-clone walkthrough — are
inherently cross-cutting and cannot be evaluated until every other phase has landed.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Directory move to apps/api + apps/frontend and path-consumer rewrite"},
    {"id": "phase_2", "title": "Turborepo task graph and root scripts"},
    {"id": "phase_3", "title": "Shared TypeScript config package"},
    {"id": "phase_4", "title": "Shared ESLint config package"},
    {"id": "phase_5", "title": "Shared types package and packages README"},
    {"id": "phase_6", "title": "Repo-wide acceptance verification and fresh-clone doc walkthrough"}
  ]
}
```

## Phase Breakdown

### Phase 1: Directory move to apps/api + apps/frontend and path-consumer rewrite

**Dependencies**: None

#### Objective

Move both apps into `apps/`, rename the backend to `api`, and rewrite **every** path
consumer in the same atomic commit, leaving the repo fully green with its existing
`pnpm --filter` scripts untouched. This phase introduces no Turborepo and no shared
packages: it is a pure relocation, verifiable entirely on its own.

#### Files to Create / Modify

**Moves (via `git mv`, so rename detection has the best chance):**
- `backend/` → `apps/api/`
- `frontend/` → `apps/frontend/`

**Workspace / manifests:**
- `pnpm-workspace.yaml` — `packages:` becomes `apps/*` and `packages/*`. The
  `packages/*` glob matches nothing yet; that is valid and intentional (Phase 3 fills it).
  **Preserve the `catalog:` and `onlyBuiltDependencies` blocks byte-for-byte.**
- `apps/api/package.json` — `"name": "ansari-backend"` → `"ansari-api"`.
- `package.json` (root) — rename the `backend` convenience alias to `api`. **Preserve each
  script's existing scope exactly**; this phase changes paths, never semantics:
  - `dev`, `test`, `build` → `--filter ansari-api` (they are backend-only **today** and stay
    that way until Phase 2 fixes that deliberately)
  - `lint`, `typecheck` → **stay `pnpm -r`** (repo-wide today). Repointing these at
    `--filter ansari-api` would silently narrow repo-wide checks to one app — a real
    regression, and exactly the class of change this phase must not make.
  Still `pnpm --filter` / `pnpm -r` throughout; Phase 2 converts to Turbo.

**Container / deploy:**
- `apps/api/Dockerfile` — `COPY apps/api/package.json apps/api/`, `COPY apps/api apps/api`,
  `WORKDIR /repo/apps/api`, `. ./apps/api/.env.ci`, `--filter ansari-api`. Build context
  stays the repo root.
- `apps/frontend/Dockerfile.web` — `COPY apps/frontend/package.json apps/frontend/`,
  `COPY apps/frontend apps/frontend`, `COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile`,
  `COPY --from=builder /repo/apps/frontend/dist /usr/share/caddy`.
- `apps/api/railway.toml` — `dockerfilePath = "apps/api/Dockerfile"`,
  `watchPatterns = ["apps/api/**", ...]`.
- `apps/frontend/railway.toml` — `dockerfilePath = "apps/frontend/Dockerfile.web"`,
  `watchPatterns = ["apps/frontend/**", ...]`.
- `.dockerignore` — `frontend/google-service-account` → `apps/frontend/google-service-account`.

**CI / GitHub:**
- `.github/workflows/ci.yml` — `apps/api/.env.ci`; `--filter ansari-api`.
- `.github/dependabot.yml` — **rewritten, not repointed.** Decided here rather than deferred:
  - `package-ecosystem: "npm"` **stays**. Dependabot has **no `pnpm` value** — pnpm is
    handled *by* the `npm` ecosystem. The fix is in directories, comment, and coverage.
  - **Use a single `directory: "/"` entry**, not per-app entries. This matches the actual
    shape of the repo: there is exactly **one** lockfile (root `pnpm-lock.yaml`), and the
    npm ecosystem resolves a pnpm workspace from it, covering every workspace package.
    It also covers the **root `package.json` itself**, which is where `turbo` lives — a
    per-app-only config would leave Turborepo unwatched.
  - **Delete** the false comment claiming `backend/package-lock.json` is the single lockfile
    and that there is no root `package.json`. Both have been untrue since the pnpm migration.
  - Keep the `github-actions` entry at `/` unchanged.
  - **Verify, do not assume:** after the change, confirm Dependabot's config is accepted and
    that its coverage reaches workspace packages (repo Insights → Dependency graph →
    Dependabot shows the parsed config and last-run status). If a single root entry proves
    not to reach workspace packages, fall back to explicit per-directory entries covering
    `/`, `/apps/api`, `/apps/frontend`, and each `packages/*` — and record which was used
    and why in the PR description.
- `.github/PULL_REQUEST_TEMPLATE.md` — lines ~16 and ~26: "run from `backend/`" and
  "`backend/.env.ci`" → `apps/api`.

**Tests (the highest-risk edit in this phase):**
- `apps/api/tests/release-doc.test.ts` — `repoRoot` must become `resolve(apiDir, '../..')`.
  Rename the `backendDir` variable to `apiDir`. Update the `referenced` array literals to
  `apps/api/railway.toml`, `apps/api/drizzle/0000_baseline.sql`,
  `apps/api/sentry.server.config.ts` — these are asserted to be **present in RELEASE.md**,
  so the doc and the test must change together in both directions.
- `apps/api/tests/self-hosting-docs.test.ts` — `resolve(__dirname, '../../docs/self-hosting.md')`
  gains a level → `'../../../docs/self-hosting.md'`. The sibling
  `'../lib/auth/startup-checks.ts'` is backend-internal and stays unchanged.

**Docs (new paths; still per-app pnpm commands at this stage):**
- `RELEASE.md` — all `backend/...` references → `apps/api/...`; **line ~69's
  `(cd .. && pnpm install) && pnpm build` becomes `(cd ../.. && ...)`**, since it is run
  from the app directory and now sits one level deeper.
- `docs/self-hosting.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`
- `apps/api/README.md`, `apps/api/AGENTS.md`, `apps/api/CLAUDE.md` (note `cd ..` →
  `cd ../..` in the install snippets), `apps/frontend/README.md` (its `../backend/` links).

**Path consumers that are easy to miss — explicitly in scope:**
- `apps/api/scripts/grant-admin.ts` line ~8 — the header comment reads
  `Usage (from backend/):` and line ~9 reads `npx tsx scripts/grant-admin.ts <email>`.
  **Both are wrong**: the path is stale, and `npx tsx` is npm-era wording the pnpm migration
  missed — `docs/self-hosting.md` already uses `pnpm exec tsx`. This is the instruction an
  operator follows during the admin-bootstrap step of a release, so stale wording here
  misdirects a **live production runbook**. Check `RELEASE.md`'s grant-admin line for the
  same `npx` drift. Note that `release-doc.test.ts`'s npm-drift regex matches
  `npm run|ci|install|test` and therefore does **not** catch `npx` — this class of drift is
  unguarded by the existing test.
- `codev/resources/arch.md` line ~11 — references `backend/lib/auth/` and
  `backend/lib/db/users.ts`. **This is a living architecture document, NOT one of the
  deliberately-historical records the spec exempts** (`codev/specs`, `codev/plans`,
  `codev/reviews`, `codev/projects`, `codev/state`). It must be updated.
- **Both `railway.toml` header comments.** Each says: point the service's "config file path"
  at `backend/railway.toml` / `frontend/railway.toml`. That exact string is what an operator
  pastes into the Railway dashboard, so it is the single most consequential comment in
  either file — update it precisely, not approximately.

#### Deliverables

- [ ] Both apps moved with `git mv`; `ansari-backend` renamed to `ansari-api`.
- [ ] Every path consumer above rewritten in the **same commit** as the move.
- [ ] `.github/dependabot.yml` rewritten properly, false comment deleted.
- [ ] Both doc-consistency tests corrected and re-verified (see Test Plan).
- [ ] Tests for this phase: the existing suite is the regression net; **no new test files**
      are added, because this phase must change zero behaviour. The two doc tests are
      *modified*, and are themselves the tests for the riskiest part of the change.

#### Acceptance Criteria

- [ ] `pnpm install` clean from the root; single `pnpm-lock.yaml`; no per-package lockfiles.
- [ ] Full api Vitest suite green, compared to the `develop` baseline **by test-name set,
      not by count** (see Test Plan for capturing the baseline).
- [ ] `pnpm --filter ansari-api lint | typecheck | build` all green.
- [ ] `pnpm --filter ansari-frontend lint | typecheck` green.
- [ ] `docker build -f apps/api/Dockerfile .` succeeds from the repo root.
- [ ] `docker build -f apps/frontend/Dockerfile.web .` succeeds from the repo root.
- [ ] `git log --follow apps/api/Dockerfile` shows pre-move history.
- [ ] No tracked file refers to a top-level `backend/` or `frontend/` path, except the
      deliberately historical records (`codev/specs`, `codev/plans`, `codev/reviews`,
      `codev/projects`, `codev/state`, and `.gitleaksignore` commit fingerprints).
- [ ] No tracked file refers to the package name `ansari-backend`.

#### Test Plan

- **Baseline first.** Before moving anything, run the suite on `develop` with a reporter
  that emits test names, and save the list. Every later comparison is against this file.
  A count is explicitly not sufficient — it cannot distinguish a renamed test from one that
  stopped being collected.
- **Intentional title renames get enumerated in the PR description.** This phase legitimately
  renames at least one test title — `'only references package scripts that exist in
  backend/package.json'` becomes `apps/api/package.json`. Because the baseline is a test-*name*
  set, such renames show up as one removal plus one addition. List them up front, or the diff
  invites exactly the hand-waving the baseline exists to prevent.
- **Negative check on `release-doc.test.ts` (required).** Temporarily rename
  `apps/api/railway.toml`; the test **must fail**. Restore.
- **Negative check on `self-hosting-docs.test.ts` (required).** Temporarily remove a
  distinguishing phrase from `apps/api/lib/auth/startup-checks.ts`; the test **must fail**.
  Restore.
  *Calibration:* both tests `readFileSync` at module load, so a stale `'..'` throws ENOENT
  and fails **loudly**. These checks guard against the realistic failure — patching a path
  just far enough to go green without confirming it points at the true repo root — not
  against a silent pass.
- **Docker:** run both builds locally. Do not infer either from the other.
- **Railway globs:** assert each `watchPatterns` entry matches at least one real path in
  the tree. A glob that matches nothing does not error — it silently stops triggering
  deploys.

---

### Phase 2: Turborepo task graph and root scripts

**Dependencies**: Phase 1

#### Objective

Introduce Turborepo as the task runner over the now-final layout: a real task graph with
declared `dependsOn` edges, cached `outputs`, and root scripts that mean what they say —
including `pnpm dev` bringing up **both** apps.

#### Files to Create / Modify

- `turbo.json` (**new**) — Turborepo 2.x, so the top-level key is `"tasks"` (1.x used
  `"pipeline"`). Task graph:
  - `gen:types` — **`outputs: ["uniwind-types.d.ts"]`**. Load-bearing: the file is
    gitignored, so on a warm cache Turbo skips the task, and without a declared output
    there is nothing to restore.
  - `typecheck` — `dependsOn: ["gen:types"]`.
  - `build` — `dependsOn: ["^build", "gen:types"]`, `outputs` for `.next/**`
    (excluding `.next/cache/**`) and `dist/**`.
  - `test` — no outputs.
  - `test:coverage` — `outputs: ["coverage/**"]`. Required because **CI runs
    `test:coverage`, not `test`**; without it CI must bypass Turbo.
  - `lint` — no outputs.
  - `dev` — `cache: false`, `persistent: true`, **and `interactive: true`** (see below).
  - **`env` declarations — REQUIRED, and their absence would break CI.**
    `apps/api/lib/config.ts` exports `config` as a **getter object** (`config.ts:~104`)
    whose accessors call a memoized `getEnv()` (`config.ts:~77`), which runs
    `envSchema.safeParse(process.env)`. **The parse happens on first property ACCESS, not
    at import** — precision matters, because the lazy shape makes the failure *more*
    insidious, not less: it surfaces only on code paths that actually touch `config`, so one
    task can pass while a later task fails on the same missing variable. Do not go looking
    for an import-time parse; there isn't one.
    CI injects `apps/api/.env.ci` into the **process environment** via
    `>> "$GITHUB_ENV"` — not as a `.env` file Next would load itself. Turborepo 2.x
    defaults to **strict env mode**: a task's child process sees only variables declared in
    `env` / `globalEnv` / `passThroughEnv` plus a small builtin allowlist. Move CI onto
    `turbo run ... --filter ansari-api` without declaring env and the Zod parse fails,
    breaking this phase's own "CI green" criterion.
    - api `build`, `test`, `test:coverage`, `typecheck` — declare at minimum the schema's
      hard-required vars (`DATABASE_URL`, `JWT_SECRET`, `KALEMAT_API_KEY`,
      `USUL_API_TOKEN`) plus the optional ones `.env.ci` actually supplies. Derive the list
      from the Zod schema in `lib/config.ts`; do not hand-guess it.
    - frontend `build` / `build:web` — declare `EXPO_PUBLIC_*`.
    - api `build` and `test:coverage` — add `apps/api/.env.ci` to `inputs`, so editing the
      dummy env busts the cache.
    **This is a cache-correctness bug independently of the strict-mode default.** Undeclared
    env is excluded from the task hash, and `Dockerfile.web` bakes `EXPO_PUBLIC_*` into the
    bundle at export time — so a cached frontend `build` restored under a different
    `EXPO_PUBLIC_API_V2_URL` would ship wrong configuration while reporting a cache hit.
    Declaring `env` is required whether or not strict mode is the active default.
- `package.json` (root) — add `turbo` to `devDependencies`; convert `dev`, `lint`,
  `typecheck`, `test`, `build` to `turbo run <task>`. Keep the `api` / `frontend`
  convenience aliases (architect decision) for scripts Turbo does not model
  (`db:migrate`, `ios`, `web`).
- `apps/frontend/package.json`:
  - **add `dev`** (delegating to `expo start`) — required for "`pnpm dev` starts both apps".
  - **add `build`** aliasing `build:web` — so `pnpm build` genuinely covers both apps.
  - `typecheck` — **drop the `&& ` chain**; the `gen:types` edge now provides ordering.
  - `build:web` — **KEEP its `pnpm run gen:types && ` chain.** See the constraint note below.
> **CI job NAMES are frozen — do not "fix" them** (human decision, 2026-08-20).
> `develop`'s branch protection is confirmed on (`protected: true`) and its required
> checks are exactly `backend (lint, typecheck, test, build)` and
> `gitleaks (secret scan)`. Required checks are matched by **name**, so the api job's
> **ID** is `api` while its **emitted name** stays `backend (...)`. A job's ID and its
> emitted name are independent, so this costs nothing and avoids an unmergeable window.
> Renaming the emitted name silently re-arms the blocker; it is a deferred follow-up that
> a repo admin must do by editing the protection rule and the `name:` line **together**.
> The `name:` line carries a comment saying so — keep it.

- `.github/workflows/ci.yml` — both jobs move to `turbo run <tasks> --filter <app>...`,
  keeping the **two-job split** (architect decision: stable check names, legible diff).
  Note the **trailing `...`**: `--filter ansari-api...` selects the app *and its workspace
  dependencies*, so the shared packages introduced in Phases 3–4 are linted and typechecked
  by CI rather than silently skipped. A bare `--filter ansari-api` would leave
  `packages/*` uncovered, contradicting the spec's required CI matrix.
  `@ansari/types` has **no consumer by design**, so a dependency-closure filter will never
  reach it — Phase 5 adds its explicit coverage. The frontend job gains a **`build`** step.
  Update the existing comment that explicitly says the typecheck step relies on the `&&` —
  it must not be silently invalidated.
- `.gitignore` — add `.turbo` (git matches at any depth, so the bare entry is correct here).
- `.dockerignore` — add **`**/.turbo`**, matching the file's existing `**/.next`, `**/dist`,
  `**/coverage` style. A bare `.turbo` matches only the repo root and would leave
  `apps/api/.turbo` and `apps/frontend/.turbo` in both build contexts.
- `CONTRIBUTING.md`, `README.md`, `docs/self-hosting.md`, `apps/api/README.md`,
  `apps/api/AGENTS.md`, `apps/api/CLAUDE.md`, `apps/frontend/README.md` — command blocks
  rewritten for the root `turbo` scripts.
- **`RELEASE.md` stays app-scoped — decided, not incidental.** It is an operational runbook
  executed *from the api app* (`pnpm db:migrate`, `pnpm exec tsx scripts/grant-admin.ts`,
  `pnpm start`), and `apps/api/tests/release-doc.test.ts` asserts that **every `pnpm <script>`
  the doc names exists in `apps/api/package.json`**. Rewriting the runbook to root `turbo`
  commands would make that assertion semantically wrong even where it still passes by
  coincidence of overlapping script names. So: leave RELEASE.md's commands app-scoped, and
  add a comment in `release-doc.test.ts` stating that assumption **explicitly** rather than
  leaving it implicit for the next person to trip over. Only genuinely root-level lines
  (the `cd ../..` install) reference the root.

> **Constraint resolution — do not "simplify" this.** The spec's baked constraint says model
> `gen:types` as a Turbo dependency "not a shell `&&`". It names **`typecheck`**, not
> `build:web`. `apps/frontend/Dockerfile.web` invokes `build:web` **directly** after a
> `--filter`-scoped install, which does not install root devDependencies — so `turbo` is
> **absent from that image**. Removing `build:web`'s chain would run `expo export` with no
> `uniwind-types.d.ts` and break an explicit acceptance criterion. The redundancy (Turbo edge
> **and** in-script chain on `build:web`) is deliberate: `gen:types` is idempotent and the
> Turbo path makes the second call a cache hit. Leave a comment in `package.json` saying so.

#### Deliverables

- [ ] `turbo.json` with the full task graph above.
- [ ] Root scripts delegating to `turbo run`; `pnpm dev` starts both apps.
- [ ] Frontend `dev` and `build` scripts added; `typecheck` de-chained; `build:web` chain kept.
- [ ] CI on `turbo run --filter`, two-job split preserved, frontend `build` step added.
- [ ] Tests for this phase: the task graph is verified by executable checks in the Test Plan
      (cache behaviour, clean-tree codegen, warm-cache restore) rather than by unit tests —
      there is no application code here to unit-test. All existing suites stay green.

#### Acceptance Criteria

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` run through Turbo and cover
      every package defining the task.
- [ ] A second identical `turbo run build` with no changes reports **FULL TURBO**.
- [ ] **Env is in the cache hash — the headline risk of this phase, not a footnote.**
      `Dockerfile.web` bakes `EXPO_PUBLIC_*` into the JS bundle at export time. A cache keyed
      *without* those values can restore a bundle built with the wrong ones and **report a
      hit**: wrong configuration shipped to production, green build, no signal anywhere.
      Prove the **hash actually changes**, not merely that caching works:
      1. Run `turbo run build --filter ansari-frontend` and record the task hash
         (`--dry=json`, or the hash in the run summary).
      2. Change one declared value (e.g. `EXPO_PUBLIC_API_V2_URL`) and re-run.
      3. **The recorded hash must differ**, and the task must re-execute.
      A criterion asserting only "a cache hit occurs" would **pass on the broken behaviour**
      — the broken build hits cache too. The hash comparison is what separates them.
- [ ] `turbo run typecheck test:coverage build --filter ansari-api...` succeeds with the
      `.env.ci` values supplied **as process env** — exactly how CI supplies them — proving
      the `env` declarations are complete.
- [ ] **`pnpm dev` verified by actually running it** (spec hard requirement): both apps
      confirmed up — api serving `/api/health`, Expo dev server reachable — **and** the Expo
      TUI confirmed still responsive to `i` / `a` / `w` / `r`.
      *Turbo multiplexes child stdio, and an Expo TUI that has lost keypress handling still
      looks like a perfectly healthy running process. Do not infer this from the process
      starting.*
- [ ] **Before accepting any degradation, try Turborepo 2.x's `interactive: true`** task
      option on `dev` — it exists precisely for tasks that need stdin, and the plan must not
      pre-accept a documented workaround without first using the mechanism built to prevent
      the problem. Documenting the caveat is the **fallback**, not the first stop.
- [ ] If TUI interactivity is still degraded with `interactive: true` set, that is an
      acceptable outcome **only if** the caveat is written into `CONTRIBUTING.md` pointing at
      the per-app scripts for interactive Expo work. Undocumented degradation fails this phase.
- [ ] `.turbo` is ignored by git and Docker.

#### Test Plan

- **Cache:** `turbo run build` twice → FULL TURBO. Then touch one api source file → the api
  build re-runs and the frontend build stays cached.
- **Codegen edge is real:** delete `apps/frontend/uniwind-types.d.ts`, then
  `turbo run typecheck --filter ansari-frontend` — must succeed by running `gen:types` as a
  graph dependency. Confirm removing the `dependsOn` edge makes it fail, proving the edge and
  not a leftover file is what makes it work.
- **Warm-cache output restore:** with the cache warm, delete `uniwind-types.d.ts` and re-run
  — Turbo must restore it from cached outputs. This is the check that catches an undeclared
  `outputs` entry, which is green cold and broken warm.
- **`dev` semantics:** `turbo run dev` does not exit and is not reported as a cache hit.
- **Env completeness:** export the `.env.ci` values into the shell as process env, then run
  the api tasks through Turbo. This reproduces CI's injection mechanism exactly; running them
  via `pnpm --filter` instead would pass regardless and prove nothing.
- **Env cache invalidation:** the record-hash / change-value / compare-hash procedure above.
- **Manual:** the `pnpm dev` / Expo TUI verification above. Manual by necessity — no
  automated check covers TTY keypress handling.

---

### Phase 3: Shared TypeScript config package

**Dependencies**: Phase 2

#### Objective

Create `@ansari/tsconfig` as the shared TypeScript base and rewire both apps onto it,
**changing no effective compiler behaviour**. This is the first phase to introduce a
`workspace:` dependency, so it also carries the Docker fix that workspace links require.

#### Files to Create / Modify

- `packages/tsconfig/package.json` (**new**) — `"name": "@ansari/tsconfig"`, private.
  It ships **only JSON** and deliberately has **no `lint` / `typecheck` scripts** — there is
  nothing to compile or lint. Turbo simply skips packages that do not define a task, so this
  is correct rather than a gap; do not add empty scripts to make it "appear" in task output.
  **Either omit `exports` entirely or explicitly export `./base.json`.** TypeScript resolves
  `extends: "@ansari/tsconfig/base.json"` through node resolution, so an `exports` map that
  lacks that entry silently breaks the extends chain.
- `packages/tsconfig/base.json` (**new**) — only what the apps genuinely share:
  `strict`, `skipLibCheck`, `esModuleInterop`, `isolatedModules`, `resolveJsonModule`.
  Deliberately thin (spec decision, confirmed at the gate).
- `apps/api/tsconfig.json` — extend the shared base; keep every Next-specific option,
  the `paths` aliases, and the `exclude` list.
- `apps/frontend/tsconfig.json` — **`extends` becomes an array**:
  `["expo/tsconfig.base", "@ansari/tsconfig/base.json"]`. Order matters — later entries
  win. Verify the resolved result rather than assuming.
- `apps/api/package.json`, `apps/frontend/package.json` — add
  `"@ansari/tsconfig": "workspace:*"` to `devDependencies`.
- `apps/api/Dockerfile` **and** `apps/frontend/Dockerfile.web` — add `COPY packages packages`
  **before** the `pnpm install` step. Copying only `packages/*/package.json` is **necessary
  but not sufficient**: once a tsconfig extends a shared base, the build needs the package
  *contents*. Half-fixing this yields an install that succeeds and a build that fails later.
- `pnpm-lock.yaml` — regenerated.

#### Deliverables

- [ ] `@ansari/tsconfig` created and both apps extending it.
- [ ] Both Dockerfiles copying `packages` before install.
- [ ] Tests for this phase: a **behaviour-preservation diff** (below) is the test. No unit
      tests — the deliverable is config, and the only meaningful assertion is that resolved
      compiler behaviour is unchanged.

#### Acceptance Criteria

- [ ] For **each** app, `tsc --showConfig` output is byte-identical before and after the
      extraction — or every difference is individually enumerated and justified in the PR
      description. No unexplained deltas.
- [ ] `pnpm typecheck` green for both apps.
- [ ] Both Docker builds still succeed (this is where the workspace-link fix is proven).
- [ ] `pnpm install --frozen-lockfile` succeeds.

#### Test Plan

- Capture `tsc --showConfig` per app on the Phase 2 commit, then again after; diff them.
- Re-run both Docker builds — the specific regression this phase risks is an image that
  installs fine and then fails at `next build` on a missing extended config.
- `turbo run typecheck` from a clean cache and from a warm cache.

---

### Phase 4: Shared ESLint config package

**Dependencies**: Phase 3

#### Objective

Create `@ansari/eslint-config` holding what the two apps genuinely share, and rewire both
onto it **without changing a single reported lint violation**. The api app's
`no-restricted-properties` env guard **stays where it is**.

#### Files to Create / Modify

- `packages/eslint-config/package.json` (**new**) — `"name": "@ansari/eslint-config"`,
  private, **`"type": "module"`** (or `.mjs` files), with an explicit `exports` map defining
  the subpath the apps import (e.g. `"./base"`). Under pnpm's strict layout an undeclared
  subpath fails to resolve, and ESLint's failure mode for an unresolved config is to report
  **nothing** — indistinguishable from passing. It also needs `eslint` in its own
  `devDependencies` (and `peerDependencies`), because pnpm will not hoist the apps' copies.
- `packages/eslint-config/base.js` (**new**) — the shared floor: common ignore globs
  (build output, `node_modules`, coverage) and any rule both apps already agree on.
  Deliberately thin — the two configs share almost nothing, and a contrived shared config
  would be worse than a small honest one.
- `apps/api/eslint.config.mjs` — consume the shared base, then keep, unchanged: the
  `FlatCompat` bridge to `next/core-web-vitals` + `next/typescript`, the **four-property
  `no-restricted-properties` guard with its exact messages**, and the two-file allowlist
  (`lib/config.ts`, `drizzle.config.ts`).
- `apps/frontend/eslint.config.js` → **rename to `eslint.config.mjs`** and convert from CJS
  to ESM. Required: the frontend package has no `"type": "module"`, so the current CJS file
  cannot `require()` an ESM shared config. Verify ESLint still resolves the renamed file.
- `apps/api/package.json`, `apps/frontend/package.json` — add
  `"@ansari/eslint-config": "workspace:*"` to `devDependencies`.
- `pnpm-lock.yaml` — regenerated.

> **The env guard is load-bearing** (arch-critical: auth secrets are read only through the
> validated `config` object). It stays in the api app because its allowlist is expressed in
> backend-relative paths and is meaningless in a package shared with an Expo app. Confirmed
> at the gate — the guard's locality is worth more than maximal sharing.

#### Deliverables

- [ ] `@ansari/eslint-config` created; both apps consuming it.
- [ ] Frontend eslint config converted to ESM and still resolved by ESLint.
- [ ] Env guard preserved verbatim in the api app.
- [ ] Tests for this phase: `apps/api/tests/eslint-env-guard.test.ts` **already exists and is
      the regression net** — it lints virtual files through the *real composed* config and
      asserts the rule fires tree-wide and stays silent in the allowlisted files. It must be
      run explicitly, not merely swept up by the suite.

#### Acceptance Criteria

- [ ] For **each** app, the set of reported rule violations over its real source tree is
      identical before and after extraction — captured with a machine-readable formatter and
      diffed. Not "lint passes"; the violation **set** is unchanged.
- [ ] `apps/api/tests/eslint-env-guard.test.ts` green — all five `flags process.env.X` cases
      and the allowlist-silence cases.
- [ ] `pnpm lint` green for both apps, through Turbo.
- [ ] `pnpm install --frozen-lockfile` succeeds.

#### Test Plan

- Run eslint with `-f json` per app on the Phase 3 commit and after; diff the violation sets.
  An empty-to-empty diff is only meaningful if the run actually linted files — assert the
  file count is non-zero on both sides.
- Run the env-guard suite explicitly.
- Confirm the frontend's ESM rename did not silently drop its config: introduce a deliberate
  violation of an Expo rule, confirm it is reported, then remove it.

---

### Phase 5: Shared types package and packages README

**Dependencies**: Phase 4

#### Objective

Scaffold `@ansari/types` as a real, installable workspace package with working task scripts
and a placeholder export — **no contracts invented** — and document the `packages/`
convention.

#### Files to Create / Modify

- `packages/types/package.json` (**new**) — `"name": "@ansari/types"`, private, `"type":
  "module"`, with `lint` and `typecheck` scripts. **Naming the scripts is not enough**:
  under pnpm's strict dependency model nothing is hoisted, so the package needs its own
  `devDependencies` — `typescript` (via `catalog:`, so it cannot drift from the pinned
  `~6.0.3`), `eslint`, and `"@ansari/eslint-config": "workspace:*"` — or both scripts fail
  with "command not found" the first time CI runs them.
- `packages/types/eslint.config.mjs` (**new**) — consumes `@ansari/eslint-config`. Without
  its own config, `eslint .` in this package either errors or lints nothing.
- `packages/types/tsconfig.json` (**new**) — extends `@ansari/tsconfig/base.json`.
- `packages/types/src/index.ts` (**new**) — a single placeholder export.
- `.github/workflows/ci.yml` — **add explicit `@ansari/types` coverage.** The app jobs use
  dependency-closure filters (`--filter <app>...`), which by construction never reach a
  package with no consumer. Cover it explicitly (e.g. a `--filter './packages/*'` step on
  one job) so the spec's "lint and typecheck for every package under `packages/`" criterion
  is actually satisfied rather than nominally claimed.
- `packages/README.md` (**new**) — one short paragraph on the convention (architect decision).
- `pnpm-lock.yaml` — regenerated.

> **Nothing imports this package yet, by design.** Wiring its task scripts now means the
> first real contract lands in a package already proven to lint, typecheck, and cache —
> rather than discovering the scaffold was wrong at the moment someone needs it. Extracting
> real API contracts is explicitly **out of scope** (spec constraint: do not invent contracts).

#### Deliverables

- [ ] `@ansari/types` scaffolded with working `lint` and `typecheck`.
- [ ] `packages/README.md` written.
- [ ] Tests for this phase: the package's own `typecheck` and `lint` tasks, executed through
      Turbo, are the test — they prove the package is a real graph participant rather than an
      inert directory.

#### Acceptance Criteria

- [ ] `turbo run lint typecheck` includes `@ansari/types` in its task list (verified in the
      output, not assumed from config), **and CI runs those tasks too** — confirmed by
      reading the CI job log, not by reading the workflow file.
- [ ] `pnpm install --frozen-lockfile` succeeds.
- [ ] `packages/README.md` exists and explains the convention.

#### Test Plan

- Run `turbo run typecheck` and confirm `@ansari/types` appears as an executed task.
- Introduce a deliberate type error in the placeholder, confirm `pnpm typecheck` fails, then
  revert — proving the package is genuinely typechecked and not silently skipped.

---

### Phase 6: Repo-wide acceptance verification and fresh-clone doc walkthrough

**Dependencies**: Phases 1–5

#### Objective

Execute the spec's cross-cutting acceptance criteria — the ones that cannot be evaluated
until everything has landed — and fix whatever they surface. This phase exists because the
dominant risk in this change is a *silent* wrong-path failure, and the sweep is what catches it.

#### Files to Create / Modify

- Whatever the sweep surfaces (expected: residual doc drift, a missed path).
- `RELEASE.md` — add the **operator action** for Railway (below).
- `codev/state/spir-48_thread.md` — final entry, committed with the PR.

#### Deliverables

- [ ] Full acceptance sweep executed and recorded.
- [ ] Railway operator action documented in `RELEASE.md` and repeated in the PR description.
- [ ] Tests for this phase: no new tests — this phase *runs* the spec's acceptance criteria
      end-to-end. Any defect it finds is fixed in the phase that owns it, with that phase's
      tests re-run.

#### Acceptance Criteria

- [ ] **No stale path survives.** Repo-wide search for top-level `backend/` / `frontend/`
      paths and the `ansari-backend` package name returns only deliberately historical
      records: `codev/specs`, `codev/plans`, `codev/reviews`, `codev/projects`,
      `codev/state`, and `.gitleaksignore` fingerprints.
      **`codev/resources/**` is explicitly NOT exempt** — `arch.md` and the other governance
      docs are living documents that must be updated. Stating this inline matters: an
      exclusion list that reads "`codev/`" would wave the real drift straight through.
- [ ] Both Docker builds succeed from the repo root.
- [ ] Both `railway.toml` name a `dockerfilePath` that exists, and every `watchPatterns` glob
      matches at least one real path — **asserted against the tree, not read**.
- [ ] **MANDATORY: re-review `turbo.json` — phase_2's compensating control** (architect
      decision, 2026-08-20). Phase 2 shipped with **two reviewers, not three**: the claude
      lane wedged 3× on a never-terminating `turbo run dev` and produced no review (see
      `48-phase_2-iter1-claude.txt`). Phase 2 is the highest-consequence phase in this plan —
      a wrong cache key ships wrong baked `EXPO_PUBLIC_*` to production **while reporting a
      cache hit**: green build, no signal — and it has had the least review. So re-review it
      here, explicitly:
      1. **`globalEnv` completeness against ALL THREE derivation methods** — the Zod schema
         in `apps/api/lib/config.ts`, the static `grep process\.env\.[A-Z]`, and the
         dynamic `grep process\.env\[` **followed to its call-site string literals**. The
         third is not optional: skipping it is exactly how
         `FACILITATOR_REQUEST_BUDGET_MS` / `FACILITATOR_SYNTHESIS_RESERVE_MS` were missed,
         and a static pattern cannot see `process.env[name]` by construction.
      2. **The cache-key assertion proven in BOTH directions** — changing a declared variable
         changes the task hash, AND removing it from `globalEnv` makes the override silently
         invisible (`configured` shows NONE). One direction alone does not distinguish
         working from broken.
- [ ] **The open Dependabot PRs are NOT a defect and must NOT be closed** (human decision,
      2026-08-20). Ten are open, all emitting the `backend (...)` check. Repointing
      `dependabot.yml` obsoletes them and Dependabot re-opens against the new path on its
      own. Do not close them, and do not report their staleness as a finding.
- [ ] **Every scan in this phase is negative-tested before its result is trusted.** A
      pattern must be shown to (a) match a known-bad line and (b) NOT match a known-good
      near-miss — e.g. the stale-path scan must flag `backend/foo` and must not flag
      `apps/frontend/foo`. Report hit counts (total vs. exempt vs. live) rather than
      asserting "clean": three separate scans on this project reported clean while not
      actually checking. A verification pattern is code, and untested code is not evidence.
- [ ] **Dependabot coverage — POST-MERGE CHECKPOINT, not a repo-verifiable criterion.**
      `directory: "/"` for a pnpm workspace is well-founded, but whether it actually reaches
      every workspace package can only be confirmed from GitHub's Dependency graph →
      Dependabot view **after merge**. This is the one acceptance criterion that cannot be
      settled from the tree. **A config that resolves nothing produces no error, just
      silence** — the same failure shape as everything else here. Check it explicitly
      post-merge and, if coverage is missing, apply the per-directory fallback the
      Constraints section already specifies (`/`, `/apps/api`, `/apps/frontend`, each
      `packages/*`).
- [ ] `.github/dependabot.yml` accounts for every workspace package directory
      (config-vs-tree comparison), with no false lockfile comment.
- [ ] Full api suite green vs. the Phase 1 `develop` baseline **by test-name set**.
- [ ] **End-to-end behaviour preservation vs. `develop`, not merely phase-to-phase.**
      Re-run the ESLint violation-set diff and the `tsc --showConfig` diff for both apps
      against **`develop`**, comparing the assembled branch tip. Adjacent-phase diffs can
      each be clean while drift accumulates across Phases 3–5; only the end-to-end
      comparison satisfies the spec's criterion. Any delta must be enumerated and justified
      in the PR description.
- [ ] `turbo run build` twice → FULL TURBO.
- [ ] gitleaks green over full history; `.gitleaksignore` untouched.
- [ ] **Fresh-clone walkthrough:** in a clean clone, follow `CONTRIBUTING.md` and
      `docs/self-hosting.md` verbatim. Every command runs as written.
- [ ] CI green on the PR, running the pinned task matrix.

#### Test Plan

- Scripted stale-path scan with the historical-record exclusions applied explicitly, so the
  exclusion list is visible and reviewable rather than implicit in a grep.
- `git log --follow` on several moved files across both apps.
- Fresh clone into a temp directory; run the documented setup verbatim. Reading the docs is
  not a substitute for executing them.
- Re-run the two doc-consistency negative checks a final time on the assembled branch.

---

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A repo-root-relative test is patched just far enough to go green without pointing at the true repo root | Medium | High | Phase 1 negative checks are mandatory, not optional; both are re-run in Phase 6 on the assembled branch |
| Railway deploys break — each service's *config file path* is a dashboard setting outside the repo | High | High | Cannot be fixed by this PR. Documented in `RELEASE.md` and the PR description as a required operator action; coordinate merge timing with someone holding Railway access, and verify both services after merge |
| `build:web`'s `&&` is removed by a later reader "finishing" the constraint, silently breaking the frontend image | Medium | High | The redundancy is documented as deliberate in both the plan and a `package.json` comment; Phase 6 re-runs the frontend Docker build |
| `gen:types` outputs undeclared → green on a cold cache, broken on a warm one | Medium | High | Explicit warm-cache delete-and-restore check in Phase 2's test plan, separate from the cold-tree check |
| Docker workspace fix half-applied (manifests copied, contents not) → install succeeds, build fails later | Medium | High | Phase 3 makes `COPY packages packages` explicit and re-runs both image builds as acceptance |
| `tsc --showConfig` reveals unintended option drift from the `extends` array ordering | Medium | Medium | Byte-identical diff is a Phase 3 acceptance criterion; any delta must be enumerated and justified, never waved through |
| Frontend ESM eslint rename silently drops the config (ESLint finds no config and reports nothing) | Medium | Medium | Phase 4 asserts a deliberate violation is still reported, and that the linted file count is non-zero on both sides of the diff |
| `pnpm dev` starts both apps but the Expo TUI silently loses keypress handling | Medium | Medium | Hard, manual, architect-mandated verification in Phase 2; degraded interactivity is acceptable **only** if documented in `CONTRIBUTING.md` |
| Dependabot pnpm-workspace directory semantics differ from expectation | Medium | Low | Phase 1 settles it by checking current behaviour and records the choice and rationale rather than guessing |
| Widened Dependabot coverage opens a burst of PRs for newly watched packages | Medium | Low | Expected, not misconfiguration; `open-pull-requests-limit` bounds it |
| `turbo.json` omits `env`, so Turbo 2.x strict env mode filters out the vars `config`'s getters Zod-parse on first access, breaking the api build under CI | High | High | Per-task `env` derived from the Zod schema (not hand-guessed), `.env.ci` in `inputs`, and an acceptance check that runs the api tasks with values supplied as **process env**, reproducing CI's injection mechanism |
| Undeclared env is excluded from the cache hash, so a cached frontend `build` ships wrong baked `EXPO_PUBLIC_*` values **while reporting a cache hit** — wrong config in production, green build, no signal | Medium | High | Declare `env` per task, and prove the **task hash changes** when a declared value changes (record hash → change value → compare). A check asserting only that a cache hit occurs would pass on the broken behaviour |
| Bare `.turbo` in `.dockerignore` leaves `apps/*/.turbo` in both build contexts | Medium | Low | Use `**/.turbo`, matching the file's existing `**/.next` / `**/dist` style |
| `codev/resources/arch.md` waved through the stale-path sweep as a "codev record" when it is a living governance doc | Medium | Medium | Phase 6's exclusion list names `codev/resources/**` as explicitly NOT exempt, inline where the sweep is defined |
| Root `lint` / `typecheck` silently narrowed from repo-wide (`pnpm -r`) to one app during the Phase 1 rewrite | Medium | High | Phase 1 explicitly preserves each script's existing scope; the change is paths only. Verify by running root `lint` and `typecheck` and confirming both apps appear in the output |
| Shared packages never get linted or typechecked in CI, so a broken shared config ships green | Medium | Medium | App jobs use dependency-closure filters (`--filter <app>...`); `@ansari/types` has no consumer so Phase 5 adds explicit coverage, verified from the CI job log rather than the workflow file |
| A shared package's scripts are declared but its own deps are not, so they fail on first CI run under pnpm's strict layout | Medium | Medium | Phases 4–5 declare `typescript` (via `catalog:`), `eslint`, and the workspace config dep in each package that has scripts; `packages/tsconfig` deliberately has none |
| Lockfile churn across Phases 3–5 masks an unintended dependency change | Low | Medium | Review each `pnpm-lock.yaml` diff for entries unrelated to turbo and the new workspace packages |
| Rename detection fails on a moved file, losing blame | Low | Medium | Git infers renames at diff time from content similarity; the path edits are small relative to file size. Verified with `git log --follow` and `git show -M --stat` in Phases 1 and 6 |
