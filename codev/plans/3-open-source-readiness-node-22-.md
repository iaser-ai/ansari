# Plan: Open-Source Readiness — Node 22, Dependency Sweep, Working Lint, CI Hardening, DB Healthcheck, Test-Suite Honesty

## Metadata
- **ID**: plan-2026-08-01-open-source-readiness
- **Status**: draft
- **Specification**: [codev/specs/3-open-source-readiness-node-22-.md](../specs/3-open-source-readiness-node-22-.md)
- **Created**: 2026-08-01

## Executive Summary
Implements the spec's selected **Approach 1**: a single batched open-source-readiness PR whose commits
are grouped by the issue's six numbered areas. Each area is one phase and one atomic commit. The
ordering is dependency-driven: the Node-22 + dependency sweep lands first (it changes the runtime and
the dependency graph — notably moving `drizzle-kit` to `devDependencies`, which is what makes
`npm audit --omit=dev` clean); working lint lands next so the CI phase can add a lint step that passes;
CI hardening then consolidates **all** `ci.yml` edits into one commit; **test-suite honesty lands before
the healthcheck** (it deletes the vacuous `api.test.ts` cases — one of which imports the health route
unmocked and asserts 200/`ok`, and would otherwise turn red the moment the healthcheck starts running
`SELECT 1`); the healthcheck follows; and contributor polish closes.

The gate `npm run typecheck && npm test && npm run build` (run from `backend/` on Node 22) must be
green at the end of every phase. The only intentional product-behavior change in the whole PR is the
healthcheck returning 503 when the database is unreachable — which, per `backend/railway.toml`
(`healthcheckPath = /api/health`, `restartPolicyMaxRetries = 3`), converts a previously-unfailable probe
into a real deploy gate. That is intended, and is the one change verified explicitly post-deploy.

## Success Metrics
Copied from the spec's Success Criteria (all must hold at PR time):
- [ ] `backend/.nvmrc` = `22`; `engines.node` = `>=22`; root `.nvmrc` = `22`; build green on Node 22.
- [ ] After `drizzle-kit` → `devDependencies`, `npm audit --omit=dev` = **0** vulns; `--force` never run.
- [ ] `drizzle-orm >= 0.45.2`, Next latest 15.5.x, `vitest` 4.1.x, Sentry/Resend transitives patched.
- [ ] `drizzle-kit`, `typescript`, `@types/*` in `devDependencies`; `mongodb` removed.
- [ ] `.github/dependabot.yml` (npm weekly + github-actions).
- [ ] `npm run lint` = `eslint .`, exits 0, flat `eslint.config.mjs`, `eslint-config-next` on 15.5.x.
- [ ] CI: `checkout`/`setup-node` off deprecated majors, all actions SHA-pinned with `# vX.Y.Z`;
      gitleaks checksum-verified; `concurrency` + `timeout-minutes`; coverage step via `@vitest/coverage-v8`.
- [ ] `/api/health`: 200 `{status:'ok',service:'ansari-backend',timestamp}` on DB-ok; 503
      `{status:'error',…}` on query failure / timeout (2000 ms race) / unset `DATABASE_URL`;
      `export const dynamic = 'force-dynamic'`; tests cover all three paths.
- [ ] `api.test.ts` vacuous cases replaced with real `login` + public `share` route tests.
- [ ] e2e suite removed (`tests/e2e/`, `playwright.config.ts`, `@playwright/test`); all Playwright/Node-20
      doc references updated.
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` + `.github/ISSUE_TEMPLATE/*`; root `.editorconfig`.
- [ ] No wire-format/prompt/API changes beyond the healthcheck 503.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Runtime & dependency sweep (Node 22, audit, dep layout, dependabot, doc Node bump)"},
    {"id": "phase_2", "title": "Working lint (flat ESLint config via FlatCompat, version pin, passing lint)"},
    {"id": "phase_3", "title": "CI hardening (SHA pins, gitleaks checksum, concurrency/timeouts, lint + coverage steps)"},
    {"id": "phase_4", "title": "Test-suite honesty (real route tests, remove e2e, fix docs)"},
    {"id": "phase_5", "title": "Healthcheck verifies the database (SELECT 1, 503 on failure)"},
    {"id": "phase_6", "title": "Contributor-facing polish (PR/issue templates, root .nvmrc, .editorconfig)"}
  ]
}
```

## Phase Breakdown

### Phase 1: Runtime & dependency sweep
**Dependencies**: None

#### Objectives
- Move the runtime to Node 22 and clean up the dependency graph so the rest of the work builds on a
  supported, non-vulnerable, correctly-classified base. Update the Node-version claims in docs.

#### Deliverables
- [ ] `backend/.nvmrc` → `22`; `backend/package.json` `engines.node` → `>=22`.
- [ ] Move `drizzle-kit`, `typescript`, `@types/bcrypt`, `@types/jsonwebtoken`, `@types/node`,
      `@types/pg`, `@types/react`, `@types/react-dom` from `dependencies` to `devDependencies`.
- [ ] Remove the unused `mongodb` devDependency.
- [ ] Bump `drizzle-orm` → `>=0.45.2`, Next → latest 15.5.x patch, `vitest` → 4.1.x, and let
      `npm audit fix` (no `--force`) patch Sentry/Resend transitives and the rest.
- [ ] `.github/dependabot.yml` with `npm` (weekly, `directory: /backend`) and `github-actions` (weekly).
- [ ] Bump Node-version references in docs: `backend/README.md:33` ("Node ≥ 20") and `:44` ("Node >= 20"),
      `backend/AGENTS.md:17`, `backend/CLAUDE.md:17`, `docs/self-hosting.md:8` — all → Node 22.
- [ ] Regenerated `backend/package-lock.json`.

#### Implementation Details
- Edit `backend/package.json` directly for the section moves and `engines`/`.nvmrc`, then run
  `npm install` from `backend/` to sync the lockfile.
- Sequence to keep the audit honest: **first** move `drizzle-kit` to `devDependencies`, **then** run
  `npm audit --omit=dev` to confirm the `esbuild`/`@esbuild-kit/*` chain has left the prod graph.
- Use `npm audit fix` (never `--force`). If any prod advisory remains that is only `--force`-fixable,
  leave it and note it in the PR body (spec Constraint).
- `mongodb` is confirmed unused (only reference is its own `package.json` line) — safe to drop.
- Verify Railway's Node source: `backend/railway.toml` uses `builder = "nixpacks"` with no Node
  directive → Nixpacks reads `.nvmrc`/`engines`; no Railway config edit expected. If a Node pin is found
  elsewhere, update it too.
- Doc edits are Node-version-only here (Playwright doc refs are handled in Phase 4).

#### Acceptance Criteria
- [ ] `npm audit --omit=dev` reports 0 vulnerabilities.
- [ ] `drizzle-kit`/`typescript`/`@types/*` no longer under `dependencies`; `mongodb` gone.
- [ ] `node -v` under the new `.nvmrc` is 22.x; `npm run typecheck && npm test && npm run build` green.
- [ ] No doc says "Node >= 20" / "Node ≥ 20" anymore.

#### Test Plan
- **Unit/Integration**: existing Vitest suite must stay green after bumps.
- **Manual**: `npm audit --omit=dev`; `node -v` shows 22; full gate; `grep -rn "20" README/self-hosting` sanity.

#### Rollback Strategy
- Revert the phase commit; `package.json`/lockfile/docs return to the Node-20 baseline.

#### Risks
- **Risk**: a bump is secretly breaking. **Mitigation**: bump incrementally, run the gate after each;
  back out any non-green bump.
- **Risk**: `npm audit fix` pulls a major. **Mitigation**: inspect its plan; never `--force`.

---

### Phase 2: Working lint
**Dependencies**: Phase 1

#### Objectives
- Make `npm run lint` a real, passing, non-interactive check backed by a Next-15-matched flat config.

#### Deliverables
- [ ] `backend/eslint.config.mjs` — flat config for Next 15.
- [ ] `backend/package.json`: `"lint": "eslint ."`; repin `eslint-config-next` from `^16.1.4` to the
      Next 15.5.x line; add `@eslint/eslintrc` as a devDependency if `FlatCompat` is needed (see below).
- [ ] Any lint violations on the current tree fixed trivially or disabled with a scoped, commented rule
      (NO drive-by refactors — spec Constraint).

#### Implementation Details
- ESLint 9 (`^9.39.2`) is already present and requires flat config. Repin `eslint-config-next` to match
  the installed Next (15.5.x line) so its rules target the right major.
- **Do not assume a native flat export.** Next 15's own scaffold builds `eslint.config.mjs` via
  `FlatCompat` from `@eslint/eslintrc`, extending `next/core-web-vitals` and `next/typescript`.
  Step: check whether the installed `eslint-config-next@15.5.x` exposes a native flat entry; if it does,
  use it directly; **if not, add `@eslint/eslintrc` as a devDependency and use `FlatCompat`** —
  e.g. `const compat = new FlatCompat({ baseDirectory: import.meta.dirname }); export default [...compat.extends('next/core-web-vitals', 'next/typescript')]`.
- Ignore `.next`, `node_modules`, `coverage`, and `tests/e2e` (deleted in Phase 4, but harmless to list).
- Run `npx eslint .` iteratively; for each finding prefer the minimal in-place fix; where a rule is
  noisy/inappropriate, disable it at config level with a one-line rationale comment (no restructuring).
- Confirm `eslint .` runs non-interactively (unlike `next lint`).
- **Conscious scope decision**: the script is exactly `eslint .` (spec-mandated), and the config targets
  the app source. `tests/**` is already excluded from typecheck (`tsconfig.json:31`); this plan does NOT
  expand lint to `tests/**` either, to avoid vitest-globals churn and drive-by changes. Noted so the
  test-file coverage gap is a decision, not an accident.

#### Acceptance Criteria
- [ ] `npm run lint` exits 0 on the current codebase.
- [ ] `eslint-config-next` version matches Next 15; no `next lint` remains in scripts.
- [ ] `npm run typecheck && npm test && npm run build` still green.

#### Test Plan
- **Manual**: `npm run lint` (0 exit); re-run the full gate.

#### Rollback Strategy
- Revert the phase commit; `lint` returns to its prior state, config removed.

#### Risks
- **Risk**: lint surfaces many violations tempting refactors. **Mitigation**: fix trivially or disable
  the rule with a comment; no restructuring (Constraint).
- **Risk**: `FlatCompat`/`@eslint/eslintrc` wiring. **Mitigation**: mirror Next 15's scaffold; verify
  the config loads before fixing findings.

---

### Phase 3: CI hardening
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Consolidate all `.github/workflows/ci.yml` changes into one commit: pin actions to SHAs, upgrade the
  deprecated action majors, verify the gitleaks download, add `concurrency` + `timeout-minutes`, and add
  the lint and coverage steps.

#### Deliverables
- [ ] `actions/checkout` and `actions/setup-node` upgraded off the deprecated majors and pinned to a
      full commit SHA with a trailing `# vX.Y.Z` comment; same treatment for any other action refs.
- [ ] gitleaks tarball: download, verify against its published SHA-256 checksum, then extract (fail the
      job on mismatch).
- [ ] Top-level `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`.
- [ ] `timeout-minutes` on both `backend` and `gitleaks` jobs.
- [ ] A `Lint` step (`npm run lint`) in the `backend` job.
- [ ] `@vitest/coverage-v8` added as a devDependency; a `test:coverage` script
      (`vitest run --coverage`); a CI coverage step that invokes it via `npm run test:coverage`
      (report/summary only — no threshold gate).

#### Implementation Details
- Resolve the current release + SHA for each action (`actions/checkout` and `actions/setup-node` current
  majors at implementation time) and pin `uses: owner/repo@<40-char-sha> # vX.Y.Z`. Cross-check each SHA
  against its tag on GitHub.
- gitleaks: replace the `curl | tar` pipe with: download the tarball and the release's
  `*_checksums.txt`, run `sha256sum -c` (or `--check`) filtered to the tarball, and only then extract.
  Keep `GITLEAKS_VERSION` pinned (currently 8.24.3). Fail closed on mismatch.
- **Coverage must be invoked via an npm script, not a bare `vitest`** — a project-local binary is not on
  a plain workflow shell's PATH. Add `"test:coverage": "vitest run --coverage"` to `package.json` and
  call `npm run test:coverage` in CI. No `thresholds` (report-only, per spec).
- Lint step goes in the `backend` job (already `working-directory: backend`), after Install.
- **Note for review**: this phase edits `package.json`/lockfile (adding `@vitest/coverage-v8` +
  `test:coverage` script). That is intentional and belongs to the CI area — it is not Phase 1 leakage.
- No repository secrets; `.env.ci` stays the sole env source.

#### Acceptance Criteria
- [ ] `ci.yml` has no mutable action tags; every `uses:` is a SHA with a version comment.
- [ ] The gitleaks step verifies a checksum before extracting.
- [ ] `concurrency` and `timeout-minutes` present; lint and coverage steps present.
- [ ] CI is green on a pushed branch (verified via the PR run).

#### Test Plan
- **Manual/local**: `npm run lint` and `npm run test:coverage` succeed locally (proving the exact
  commands CI calls are valid). Validate `ci.yml` YAML.
- **Integration**: the actual CI run on the PR branch goes green (checked during Review/verify).

#### Rollback Strategy
- Revert the phase commit; CI and `package.json` coverage bits return to prior state.

#### Risks
- **Risk**: a pinned SHA is wrong/for the wrong tag. **Mitigation**: cross-check SHA↔tag; `# vX.Y.Z` comment.
- **Risk**: coverage package version mismatch with vitest. **Mitigation**: install the 4.1.x-matched
  `@vitest/coverage-v8`; non-gating summary run suffices.
- **Risk**: gitleaks checksum URL/format changes. **Mitigation**: pull from the pinned release's
  `checksums.txt`; fail closed.

---

### Phase 4: Test-suite honesty
**Dependencies**: Phase 1
**(Runs before Phase 5 by design — see Executive Summary. Deleting the vacuous `api.test.ts` health case
here is what keeps the gate green when Phase 5 makes the health route hit the DB.)**

#### Objectives
- Replace vacuous tests with real ones and remove the dead e2e suite; make every doc truthful.

#### Implementation Details
- **`backend/tests/api.test.ts`**: remove the seven self-asserting object-literal cases (including the
  health case at `:21` that imports the route unmocked and asserts 200/`ok`). Add real route tests using
  the pglite + `vi.mock('@/lib/db/index')` pattern from `tests/token-grace.test.ts`:
  - `POST /api/v2/users/login`: seed a user (hashed password) in pglite; valid creds → Ansari token
    shape (`access_token`, `refresh_token`, `token_type:'bearer'`); wrong password / unknown email →
    401 with the generic message. Provide required env (`JWT_SECRET`, expiry vars) via the test.
  - Public `GET /api/v2/share/[id]`: **the FK matters** — `shares.thread_id` is a `notNull` FK to
    `threads` (`db/schema/shares.ts:16`). Seed the minimal chain the insert needs (a `users` row, a
    `threads` row, then the `shares` row) before asserting: existing id → snapshot shape
    (`id`, `thread_name`, `messages[]`, `created_at`); missing id → 404. Read each route's imports first
    and create only the tables/columns the route touches.
  - Keep the file name `api.test.ts` (or split into `login.test.ts` / `share.test.ts` if cleaner —
    either satisfies the criterion).
- **e2e removal**: delete `backend/tests/e2e/` (chat/login/registration specs), delete
  `backend/playwright.config.ts`, and remove `@playwright/test` from `devDependencies` (re-sync lockfile).
- **Doc + config cleanup (Playwright/e2e references)** — verified locations, update all:
  - `CONTRIBUTING.md` — remove the Playwright/e2e paragraph.
  - `backend/README.md:39` — drop "Playwright (e2e, run locally)".
  - `backend/AGENTS.md:34` and `backend/CLAUDE.md:34` — drop the `tests/e2e/` Playwright line.
  - `backend/tsconfig.json` — remove the now-stale `"playwright.config.ts"` exclude entry (`:33`)
    (harmless if left, but tidy).
  - `backend/.gitignore` — remove the Playwright artifact entries `test-results/` (`:8`) and
    `playwright-report/` (`:9`).
  - Final sweep: `grep -rin playwright` returns nothing actionable.

#### Deliverables
- [ ] `api.test.ts` real route tests (login + share) — vacuous cases gone.
- [ ] `tests/e2e/`, `playwright.config.ts` deleted; `@playwright/test` removed from `package.json`.
- [ ] All Playwright/e2e references removed from `CONTRIBUTING.md`, `README.md`, `AGENTS.md`,
      `CLAUDE.md`, `tsconfig.json`, `.gitignore`.

#### Acceptance Criteria
- [ ] New tests genuinely exercise route handlers (can fail if the route breaks) and pass.
- [ ] No `tests/e2e/`, no `playwright.config.ts`, no `@playwright/test` dep, no Playwright docs/config.
- [ ] Full gate green (in particular, no lingering `api.test.ts` health assertion).

#### Test Plan
- **Unit/Integration**: the new login/share tests via the mock pattern (share test seeds users→threads→shares).
- **Manual**: `grep -rin playwright` clean; `npm test` passes.

#### Rollback Strategy
- Revert the phase commit; old tests/e2e/docs return.

#### Risks
- **Risk**: login/share routes pull more than `lib/db` (auth middleware, jwt). **Mitigation**: read each
  route's imports first; seed the minimal schema/env each needs, following `token-grace.test.ts`.
- **Risk**: share FK insert fails without parent rows. **Mitigation**: seed users→threads→shares in order.

---

### Phase 5: Healthcheck verifies the database
**Dependencies**: Phase 1, Phase 4 (Phase 4 removes the unmocked `api.test.ts` health assertion first)

#### Objectives
- Make `/api/health` reflect real availability: 200 when a `SELECT 1` succeeds, 503 on failure, timeout,
  or unreachable/unset `DATABASE_URL` — without changing the response field set.

#### Implementation Details
- `backend/src/app/api/health/route.ts`:
  - Add `export const dynamic = 'force-dynamic'` so the probe is never served from a build-time cache.
  - **Avoid the import-time throw**: `lib/db/index.ts:26` builds `db` at module scope via `getPool()`,
    which throws if `DATABASE_URL` is unset. Import the db handle **lazily** inside `GET`
    (`await import('@/lib/db/index')`) wrapped in try/catch, so an unset/broken `DATABASE_URL` yields a
    503, not an import-time 500.
  - Run `SELECT 1` via the drizzle `db` handle (`db.execute(sql\`SELECT 1\`)` — verify the node-postgres
    `execute` signature first), raced against a hard 2000 ms timeout (`Promise.race` with a timer that
    rejects) so an unreachable host can't hang on the pool's 5000 ms `connectionTimeoutMillis`.
  - On success: `200` `{ status:'ok', service:'ansari-backend', timestamp: new Date().toISOString() }`.
  - On any failure/timeout: `503` `{ status:'error', service:'ansari-backend', timestamp }` — no raw DB
    error text (log the real error server-side via `console.error`).
  - Keep the field set and `service` value exactly as today.

#### Deliverables
- [ ] Updated `health/route.ts` (lazy db import, `SELECT 1`, 2000 ms race, 503 paths, `force-dynamic`).
- [ ] Rewritten `backend/tests/health.test.ts` using `vi.hoisted` + `vi.mock('@/lib/db/index')` + pglite,
      covering three cases (see below).

#### Test approach (explicit, per review)
- **Healthy → 200 `ok`**: mock `db` backed by pglite (or a stub whose `execute` resolves); assert body.
- **Query failure → 503 `error`**: mock factory's `db.execute` rejects; assert 503 + `status:'error'`,
  no raw error text.
- **Unset/broken `DATABASE_URL` → 503 (not 500)**: with `vi.mock('@/lib/db/index')` in place the module
  can never throw at import, so this case is simulated by a **mock factory whose `get db()` throws** (or
  whose `execute` throws the "DATABASE_URL not set" error). Be explicit that this exercises the route's
  try/catch around the lazy import — it approximates, not literally reproduces, the real import-time
  failure. That is the correct and testable contract for the route.
- **2000 ms timeout → 503**: use Vitest **fake timers** (or a never-resolving `execute`) and advance past
  2000 ms; assert the route returns 503 without waiting on the real pool timeout.

#### Acceptance Criteria
- [ ] Health returns the exact 200/503 bodies from the spec across all scenarios.
- [ ] No raw DB error leaks in the 503 body.
- [ ] `tests/health.test.ts` passes (all four cases); full gate green.

#### Rollback Strategy
- Revert the phase commit; the route returns to the static `ok`.

#### Risks
- **Risk**: mocking `@/lib/db/index` while the route imports it lazily. **Mitigation**: the `vi.mock`
  factory intercepts the dynamic import too; mirror `token-grace.test.ts`.
- **Risk**: `db.execute(sql`SELECT 1`)` shape differs from expectation. **Mitigation**: verify the
  drizzle node-postgres `execute` signature in tests before finalizing.
- **Risk**: this turns Railway's `/api/health` into a real deploy gate (`railway.toml`
  `restartPolicyMaxRetries=3`). **Mitigation**: intended per spec; verify the probe passes post-deploy
  (see Post-Implementation).

---

### Phase 6: Contributor-facing polish
**Dependencies**: None (independent; sequenced last)

#### Objectives
- Add the small contributor-facing files a public repo is expected to have.

#### Deliverables
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` — concise checklist (typecheck/test/build/lint pass, tests
      added, no secrets, Islamic-content note mirroring CONTRIBUTING).
- [ ] `.github/ISSUE_TEMPLATE/bug_report.md` and `.github/ISSUE_TEMPLATE/feature_request.md` (basic).
- [ ] Root `.nvmrc` = `22` (matching backend's).
- [ ] Root `.editorconfig` (UTF-8, LF, final newline, 2-space indent for JS/TS/JSON/YAML/MD;
      consistent with existing style).

#### Implementation Details
- Keep templates short and aligned with `CONTRIBUTING.md` (checks contract, no-secrets rule,
  Islamic-content scrutiny for prompt/citation changes).
- `.editorconfig` at repo root; match observed conventions (2-space indent) — do not reformat code.

#### Acceptance Criteria
- [ ] All four artifacts exist and are well-formed.
- [ ] Root `.nvmrc` matches `backend/.nvmrc` (`22`).
- [ ] No behavior change; gate still green.

#### Test Plan
- **Manual**: files render on GitHub as templates (visual); `.editorconfig` parses.

#### Rollback Strategy
- Revert the phase commit; files removed.

#### Risks
- **Risk**: `.editorconfig` conflicts with existing formatting. **Mitigation**: match current
  conventions; no reformatting of existing files.

## Dependency Map
```
Phase 1 (Node 22 + deps + doc Node bump)
   ├──→ Phase 2 (lint) ──→ Phase 3 (CI: needs .nvmrc=22 + passing lint + coverage script)
   ├──→ Phase 4 (test honesty)  ──→ Phase 5 (healthcheck)   [4 must precede 5: it removes the
   │                                                          unmocked api.test.ts health assertion]
   └──→ Phase 6 (contributor polish)  [independent; last]
```

## Resource Requirements
### Development Resources
- **Engineers**: one; familiarity with Next 15 App Router, ESLint flat config + FlatCompat, GitHub
  Actions, drizzle/pg, Vitest + pglite.
- **Environment**: local Node 22 (via nvm), backend deps installed; no DB required (tests use pglite).

### Infrastructure
- No DB schema changes, no new services. CI and Railway pick up Node 22 via `.nvmrc`/`engines`.
- Config-only additions: `dependabot.yml`, `eslint.config.mjs`, `.editorconfig`, `.github/` templates.

## Integration Points
### External Systems
- **GitHub Actions**: consumes `ci.yml` and `node-version-file`; Phase 3. Fallback: N/A.
- **Railway**: builds from `.nvmrc`/`engines` (nixpacks); Phase 1 verifies. `healthcheckPath=/api/health`
  becomes a real gate after Phase 5. Fallback: update any explicit Node pin found.
### Internal Systems
- **`lib/db/index.ts`** (`db`/`closeDb`, module-scope pool): consumed by the healthcheck (Phase 5) and
  the new route tests (Phase 4) via the `vi.mock` pattern.

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Dependency bump breaks the gate | M | M | Incremental bumps; run gate per phase; back out non-green | builder |
| Node 22 runtime incompatibility | L | M | Verify green gate on 22 locally before PR | builder |
| ESLint flat config missing `@eslint/eslintrc`/FlatCompat | M | M | Verify native export; else add dep + FlatCompat (Phase 2) | builder |
| Healthcheck import-time throw yields 500 not 503 | M | H | Lazy `await import` + try/catch; test unset-DATABASE_URL via throwing mock | builder |
| Share test FK insert fails | M | M | Seed users→threads→shares in order (Phase 4) | builder |
| Coverage run fails (bare `vitest` not on PATH) | M | M | Invoke via `npm run test:coverage` | builder |
| Pinned action SHA mismatched to tag | L | M | Cross-check SHA↔tag; `# vX.Y.Z` comment | builder |
| Healthcheck 503 gate takes prod down on bad DATABASE_URL | L | H | Intended; verify probe passes post-deploy | builder |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| CI-only failures invisible locally (SHA/checksum/YAML) | M | M | Validate YAML + run the exact `npm run` commands locally; confirm on PR run | builder |

## Validation Checkpoints
1. **After Phase 1**: `npm audit --omit=dev` = 0; gate green on Node 22; no "Node >= 20" in docs.
2. **After Phase 2**: `npm run lint` exits 0.
3. **After Phase 3**: `ci.yml` valid; `npm run lint` + `npm run test:coverage` run locally; PR CI green.
4. **After Phase 4**: real route tests pass (login + FK-seeded share); no Playwright footprint anywhere.
5. **After Phase 5**: four health scenarios pass (ok / query-fail / unset-DATABASE_URL / timeout).
6. **Before Production (Review/verify)**: full gate green on Node 22; PR CI green; spec criteria checked.

## Monitoring and Observability
### Metrics to Track
- CI job duration (now bounded by `timeout-minutes`); coverage summary (informational, non-gating).
### Logging Requirements
- Healthcheck logs the real DB error server-side (`console.error`) while returning a generic 503 body.
### Alerting
- Railway deploy health now gated by the real 503; a failing `DATABASE_URL` will (correctly) fail the deploy.

## Documentation Updates Required
- [ ] Node-version bump in `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/self-hosting.md` (Phase 1).
- [ ] Remove Playwright/e2e refs from `CONTRIBUTING.md`, `README.md`, `AGENTS.md`, `CLAUDE.md` (Phase 4).
- [ ] `.github/` PR + issue templates (Phase 6).
- [ ] N/A — API docs / runbooks unchanged (healthcheck body shape preserved).

## Post-Implementation Tasks
- [ ] Confirm the PR's CI run is green (all jobs).
- [ ] Confirm Railway build picks Node 22 (verify phase / next deploy).
- [ ] **Confirm Railway's `/api/health` probe passes post-deploy** — Phase 5 converts it into a deploy
      gate (`railway.toml` `restartPolicyMaxRetries=3`); this is the one change that can take prod down.
- [ ] Security: `npm audit --omit=dev` clean; actions SHA-pinned; gitleaks checksum-verified.

## Expert Review
**Date**: 2026-08-01
**Model**: Gemini (APPROVE), Codex (REQUEST_CHANGES), Claude (REQUEST_CHANGES) — 3-way plan consultation.
**Key Feedback**:
- Phase 4 (old order) broke its own per-phase green-gate invariant: `tests/api.test.ts:21` imports the
  health route unmocked and asserts 200/`ok`, so making the route run `SELECT 1` turned it red.
- Node-20 and Playwright references survived in `README.md`, `AGENTS.md`, `CLAUDE.md`, `self-hosting.md`,
  `tsconfig.json`, `.gitignore` — unaddressed by a generic "grep" instruction.
- ESLint flat config assumed a native flat export; Next 15 needs `FlatCompat` + `@eslint/eslintrc`.
- Coverage invoked as bare `vitest` wouldn't be on a workflow shell's PATH.
- Public-share test can't seed a bare share row — `shares.thread_id` is a `notNull` FK to `threads`.
- Healthcheck timeout and unset-`DATABASE_URL` cases needed explicit, testable mechanisms.

**Plan Adjustments**:
- **Swapped Phase 4 and Phase 5** so test-honesty (which deletes the vacuous health case) precedes the
  healthcheck change — the gate now stays green every phase. Dependency map/checkpoints updated.
- Named every stale doc/config file explicitly: Node bumps → Phase 1; Playwright refs (+ tsconfig
  exclude, .gitignore artifacts) → Phase 4.
- Phase 2: prescribed `FlatCompat` + `@eslint/eslintrc` (verify-then-install), and made the
  tests-unlinted scope an explicit decision.
- Phase 3: coverage via a `test:coverage` npm script (`npm run test:coverage`), and flagged the
  `package.json` touch as intentional (not Phase 1 leakage).
- Phase 4: share test seeds users→threads→shares to satisfy the FK.
- Phase 5: added explicit timeout (fake-timers/never-resolving) and unset-`DATABASE_URL` (throwing mock
  factory, with an honesty note on what it exercises) test approaches; noted the Railway deploy-gate
  implication and added a post-deploy probe check.

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-08-01 | Initial plan draft | Spec 3 approved (ASPIR, auto) | builder aspir-3 |
| 2026-08-01 | Revised per 3-way plan review | Fix per-phase gate break, stale docs, lint/coverage/FK/test mechanics | builder aspir-3 |

## Notes
- ASPIR: plan auto-approves; the PR gate is preserved for human review.
- **Commit grouping**: one commit per phase, matching the issue's six numbered areas. Two documented
  deviations, both intentional: (1) all `ci.yml` edits are consolidated into the Phase 3 (CI) commit so
  the workflow is touched once — area 2's "add a lint step to CI" lands in Phase 3 while lint
  config/script land in Phase 2; (2) Phase 4 (test honesty) is sequenced before Phase 5 (healthcheck) to
  preserve the per-phase green gate.
- **PR strategy**: single PR opened after Phase 6, with all six phase-commits on the branch (per the
  builder PR strategy) — unless the architect requests slicing.
