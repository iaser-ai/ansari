# Plan: Open-Source Readiness — Node 22, Dependency Sweep, Working Lint, CI Hardening, DB Healthcheck, Test-Suite Honesty

## Metadata
- **ID**: plan-2026-08-01-open-source-readiness
- **Status**: draft
- **Specification**: [codev/specs/3-open-source-readiness-node-22-.md](../specs/3-open-source-readiness-node-22-.md)
- **Created**: 2026-08-01

## Executive Summary
Implements the spec's selected **Approach 1**: a single batched open-source-readiness PR whose commits
are grouped by the issue's six numbered areas. Each area is one phase and one atomic commit. The
ordering is dependency-driven, not arbitrary: the Node-22 + dependency sweep lands first because it
changes the runtime and dependency graph everything else runs against (notably moving `drizzle-kit`
to `devDependencies`, which is what makes `npm audit --omit=dev` clean); working lint lands next so the
CI phase can add a lint step that actually passes; CI hardening then consolidates **all** `ci.yml`
edits into one commit; and the healthcheck, test-suite honesty, and contributor-polish phases follow.

The gate `npm run typecheck && npm test && npm run build` (run from `backend/` on Node 22) must be
green at the end of every phase. The only intentional product-behavior change in the whole PR is the
healthcheck returning 503 when the database is unreachable.

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
- [ ] e2e suite removed (`tests/e2e/`, `playwright.config.ts`, `@playwright/test`); `CONTRIBUTING.md` updated.
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` + `.github/ISSUE_TEMPLATE/*`; root `.editorconfig`.
- [ ] No wire-format/prompt/API changes beyond the healthcheck 503.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Runtime & dependency sweep (Node 22, audit, dep layout, dependabot)"},
    {"id": "phase_2", "title": "Working lint (flat ESLint config, version pin, passing lint)"},
    {"id": "phase_3", "title": "CI hardening (SHA pins, gitleaks checksum, concurrency/timeouts, lint + coverage steps)"},
    {"id": "phase_4", "title": "Healthcheck verifies the database (SELECT 1, 503 on failure)"},
    {"id": "phase_5", "title": "Test-suite honesty (real route tests, remove e2e, fix CONTRIBUTING)"},
    {"id": "phase_6", "title": "Contributor-facing polish (PR/issue templates, root .nvmrc, .editorconfig)"}
  ]
}
```

## Phase Breakdown

### Phase 1: Runtime & dependency sweep
**Dependencies**: None

#### Objectives
- Move the runtime to Node 22 and clean up the dependency graph so the rest of the work builds on a
  supported, non-vulnerable, correctly-classified base.

#### Deliverables
- [ ] `backend/.nvmrc` → `22`; `backend/package.json` `engines.node` → `>=22`.
- [ ] Move `drizzle-kit`, `typescript`, `@types/bcrypt`, `@types/jsonwebtoken`, `@types/node`,
      `@types/pg`, `@types/react`, `@types/react-dom` from `dependencies` to `devDependencies`.
- [ ] Remove the unused `mongodb` devDependency.
- [ ] Bump `drizzle-orm` → `>=0.45.2`, Next → latest 15.5.x patch, `vitest` → 4.1.x, and let
      `npm audit fix` (no `--force`) patch Sentry/Resend transitives and the rest.
- [ ] `.github/dependabot.yml` with `npm` (weekly, `directory: /backend`) and `github-actions` (weekly).
- [ ] Regenerated `backend/package-lock.json`.

#### Implementation Details
- Edit `backend/package.json` directly for the section moves and `engines`/`.nvmrc`, then run
  `npm install` from `backend/` to sync the lockfile.
- Sequence to keep the audit honest: **first** move `drizzle-kit` to `devDependencies`, **then** run
  `npm audit --omit=dev` to confirm the `esbuild`/`@esbuild-kit/*` chain has left the prod graph.
- Use `npm audit fix` (never `--force`). If any prod advisory remains that is only `--force`-fixable,
  leave it and note it in the PR body (spec Constraint).
- `mongodb` is confirmed unused (only reference is its own `package.json` line) — safe to drop.
- Verify Railway's Node source: inspect `backend/railway.toml` (no Node directive expected → Nixpacks
  reads `.nvmrc`/`engines`); if a Node pin exists elsewhere, update it too.

#### Acceptance Criteria
- [ ] `npm audit --omit=dev` reports 0 vulnerabilities.
- [ ] `drizzle-kit`/`typescript`/`@types/*` no longer appear under `dependencies`; `mongodb` gone.
- [ ] `node -v` under the new `.nvmrc` is 22.x; `npm run typecheck && npm test && npm run build` green.

#### Test Plan
- **Unit/Integration**: existing Vitest suite must stay green after bumps.
- **Manual**: `npm audit --omit=dev`; `nvm use` (or `node -v`) shows 22; full gate.

#### Rollback Strategy
- Revert the phase commit; `package.json`/lockfile return to the Node-20 baseline.

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
- [ ] `backend/eslint.config.mjs` — flat config using `eslint-config-next`'s flat export for Next 15,
      scoped to the app (`src`, `lib`, `db`), ignoring `.next`, `node_modules`, `coverage`, `tests/e2e`.
- [ ] `backend/package.json`: `"lint": "eslint ."`; repin `eslint-config-next` to the Next 15.5.x line.
- [ ] Any lint violations on the current tree fixed trivially or disabled with a scoped, commented rule
      (NO drive-by refactors — spec Constraint).

#### Implementation Details
- ESLint 9 (`^9.39.2`) is already present and requires flat config. `eslint-config-next` must be
  repinned from `^16.1.4` to the version matching Next 15 (the `15.5.x` line) so its rules target the
  installed Next.
- Compose the flat config from `eslint-config-next` (it ships a flat-compatible entry for Next 15);
  keep it minimal — the goal is a working baseline, not a strict new ruleset.
- Run `npx eslint .` iteratively; for each finding, prefer the minimal in-place fix; where a rule is
  noisy or inappropriate for this codebase, disable it at config level with a one-line rationale
  comment rather than restructuring code.
- Confirm `eslint .` is non-interactive (unlike `next lint`, which can prompt).

#### Acceptance Criteria
- [ ] `npm run lint` exits 0 on the current codebase.
- [ ] `eslint-config-next` version matches Next 15; no `next lint` remains in scripts.
- [ ] `npm run typecheck && npm test && npm run build` still green.

#### Test Plan
- **Manual**: `npm run lint` (0 exit); re-run the full gate.

#### Rollback Strategy
- Revert the phase commit; `lint` returns to its (broken) prior state, config file removed.

#### Risks
- **Risk**: lint surfaces many violations tempting refactors. **Mitigation**: fix trivially or disable
  the rule with a comment; no restructuring (Constraint).
- **Risk**: `eslint-config-next` flat export differs across the 15.x line. **Mitigation**: pin to the
  installed Next's matching version; verify the config loads.

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
- [ ] `@vitest/coverage-v8` added as a devDependency; a coverage step
      (`vitest run --coverage`, report/summary only — no threshold gate).

#### Implementation Details
- Resolve the current release + SHA for each action (`actions/checkout` → v5 line, `actions/setup-node`
  → v5 line, or the current majors at implementation time) and pin `uses: owner/repo@<40-char-sha> # vX.Y.Z`.
- gitleaks: replace the `curl | tar` pipe with: download the tarball and the release's checksum, compute
  `sha256sum -c`, and only then extract. Keep `GITLEAKS_VERSION` pinned (currently 8.24.3); source the
  expected checksum from that release's `*_checksums.txt`.
- Lint step goes in the `backend` job (which already sets `working-directory: backend`), after Install,
  before/after Typecheck — order doesn't matter functionally.
- Coverage: install `@vitest/coverage-v8` (matched to the vitest 4.1.x line from Phase 1) and add a step
  running coverage with a text/summary reporter. No `thresholds` — report only, per spec.
- Do not introduce repository secrets; `.env.ci` stays the sole env source.

#### Acceptance Criteria
- [ ] `ci.yml` has no mutable action tags; every `uses:` is a SHA with a version comment.
- [ ] The gitleaks step verifies a checksum before extracting.
- [ ] `concurrency` and `timeout-minutes` present; lint and coverage steps present.
- [ ] CI is green on a pushed branch (verified via the PR run).

#### Test Plan
- **Manual/local**: `npm run lint` and `vitest run --coverage` succeed locally (proving the commands CI
  will call are valid). Validate `ci.yml` YAML.
- **Integration**: the actual CI run on the PR branch goes green (checked during Review/verify).

#### Rollback Strategy
- Revert the phase commit; CI returns to the prior workflow.

#### Risks
- **Risk**: a pinned SHA is wrong/for the wrong tag. **Mitigation**: cross-check SHA against the tag on
  GitHub; the `# vX.Y.Z` comment documents intent.
- **Risk**: coverage package version mismatch with vitest. **Mitigation**: install the 4.1.x-matched
  `@vitest/coverage-v8`; coverage is non-gating so a summary-only run is sufficient.
- **Risk**: gitleaks checksum URL/format changes. **Mitigation**: pull the checksum from the pinned
  release's published `checksums.txt`; fail closed on mismatch.

---

### Phase 4: Healthcheck verifies the database
**Dependencies**: Phase 1

#### Objectives
- Make `/api/health` reflect real availability: 200 when a `SELECT 1` succeeds, 503 on failure, timeout,
  or unreachable/unset `DATABASE_URL` — without changing the response field set.

#### Implementation Details
- `backend/src/app/api/health/route.ts`:
  - Add `export const dynamic = 'force-dynamic'` so the probe is never served from a build-time cache.
  - **Avoid the import-time throw**: `lib/db/index.ts` builds `db` at module scope via `getPool()`,
    which throws if `DATABASE_URL` is unset. Import the db handle lazily inside `GET` (dynamic
    `await import('@/lib/db/index')`) and wrap it in try/catch so an unset/broken `DATABASE_URL`
    yields a 503, not an import-time 500.
  - Run `SELECT 1` via the drizzle `db` handle (e.g. `db.execute(sql\`SELECT 1\`)`), raced against a
    hard 2000 ms timeout (`Promise.race` with a timer that rejects) so an unreachable host can't hang
    on the pool's 5000 ms `connectionTimeoutMillis`.
  - On success: `200` `{ status:'ok', service:'ansari-backend', timestamp: new Date().toISOString() }`.
  - On any failure/timeout: `503` `{ status:'error', service:'ansari-backend', timestamp }` — no raw DB
    error text in the body (log the real error server-side via `console.error`).
- Keep the field set and `service` value exactly as today.

#### Deliverables
- [ ] Updated `health/route.ts` (lazy db import, `SELECT 1`, 2000 ms race, 503 paths, `force-dynamic`).
- [ ] Rewritten `backend/tests/health.test.ts` using `vi.hoisted` + `vi.mock('@/lib/db/index')` + pglite
      (per `token-grace.test.ts`) covering: healthy → 200 `ok`; query throws → 503 `error`; unset/broken
      `DATABASE_URL` → 503 (not 500).

#### Acceptance Criteria
- [ ] Health returns the exact 200/503 bodies from the spec across all three scenarios.
- [ ] No raw DB error leaks in the 503 body.
- [ ] `tests/health.test.ts` passes; full gate green.

#### Test Plan
- **Unit**: three Vitest cases (ok / query-failure / unset-DATABASE_URL) via the mock pattern.
- **Manual**: hit `/api/health` with a good and a bad `DATABASE_URL` locally (optional sanity check).

#### Rollback Strategy
- Revert the phase commit; the route returns to the static `ok`.

#### Risks
- **Risk**: mocking `@/lib/db/index` while the route imports it lazily. **Mitigation**: the `vi.mock`
  factory intercepts the dynamic import too; mirror `token-grace.test.ts`.
- **Risk**: `db.execute(sql`SELECT 1`)` shape differs from expectation. **Mitigation**: verify the
  drizzle node-postgres `execute` signature in the REPL/tests before finalizing.

---

### Phase 5: Test-suite honesty
**Dependencies**: Phase 1

#### Objectives
- Replace vacuous tests with real ones and remove the dead e2e suite; make `CONTRIBUTING.md` truthful.

#### Implementation Details
- **`backend/tests/api.test.ts`**: remove the self-asserting object-literal cases. Add real route tests
  using the pglite + `vi.mock('@/lib/db/index')` pattern:
  - `POST /api/v2/users/login`: seed a user (hashed password) in pglite; valid creds → Ansari token
    shape (`access_token`, `refresh_token`, `token_type:'bearer'`); wrong password / unknown email →
    401 with the generic message. Mock only what the route needs (JWT secret via env, `lib/db`).
  - Public `GET /api/v2/share/[id]`: seed a share row; existing id → snapshot shape
    (`id`, `thread_name`, `messages[]`, `created_at`); missing id → 404.
  - Keep the file name `api.test.ts` (or split into `login.test.ts` / `share.test.ts` if cleaner —
    decide during implementation; either satisfies the criterion).
- **e2e removal**: delete `backend/tests/e2e/` (chat/login/registration specs), delete
  `backend/playwright.config.ts`, and remove `@playwright/test` from `devDependencies`
  (re-sync lockfile).
- **`CONTRIBUTING.md`**: remove the Playwright paragraph ("Playwright e2e tests … `npx playwright test`")
  so it matches reality (Vitest is the only suite). Verify no other doc references the e2e suite.

#### Deliverables
- [ ] `api.test.ts` real route tests (login + share) — vacuous cases gone.
- [ ] `tests/e2e/` and `playwright.config.ts` deleted; `@playwright/test` removed from `package.json`.
- [ ] `CONTRIBUTING.md` updated; no dangling e2e references anywhere.

#### Acceptance Criteria
- [ ] New tests genuinely exercise route handlers (can fail if the route breaks) and pass.
- [ ] No `tests/e2e/`, no `playwright.config.ts`, no `@playwright/test` dep, no Playwright docs.
- [ ] Full gate green.

#### Test Plan
- **Unit/Integration**: the new login/share tests via the mock pattern.
- **Manual**: `grep -ri playwright` across repo returns nothing actionable; `npm test` passes.

#### Rollback Strategy
- Revert the phase commit; old tests/e2e return.

#### Risks
- **Risk**: login/share routes have more dependencies than `lib/db` (e.g. auth middleware). **Mitigation**:
  read each route's imports first; seed the minimal pglite schema and env the route needs, following
  `token-grace.test.ts`.
- **Risk**: removing `@playwright/test` breaks an unexpected import. **Mitigation**: `grep` for
  `@playwright/test` usage before removal (only e2e specs should use it).

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
      consistent with the existing code style).

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
  conventions; no reformatting of existing files in this PR.

## Dependency Map
```
Phase 1 (Node 22 + deps) ──→ Phase 2 (lint) ──→ Phase 3 (CI: needs .nvmrc=22 + passing lint + coverage dep)
        │
        ├──→ Phase 4 (healthcheck)      [needs the bumped deps / green base]
        ├──→ Phase 5 (test honesty)     [needs the pglite/mock base]
        └──→ Phase 6 (contributor polish) [independent; last]
```

## Resource Requirements
### Development Resources
- **Engineers**: one; familiarity with Next 15 App Router, ESLint flat config, GitHub Actions, drizzle/pg, Vitest.
- **Environment**: local Node 22 (via nvm), backend deps installed; no DB required (tests use pglite).

### Infrastructure
- No DB schema changes, no new services. CI and Railway pick up Node 22 via `.nvmrc`/`engines`.
- Config-only additions: `dependabot.yml`, `eslint.config.mjs`, `.editorconfig`, `.github/` templates.

## Integration Points
### External Systems
- **GitHub Actions**: consumes `ci.yml` and `node-version-file`; Phase 3. Fallback: N/A (CI-only).
- **Railway**: builds from `.nvmrc`/`engines`; Phase 1 verifies. Fallback: update any explicit Node pin found.
### Internal Systems
- **`lib/db/index.ts`** (`db`/`closeDb`, module-scope pool): consumed by the healthcheck (Phase 4) and
  the new route tests (Phase 5) via the `vi.mock` pattern.

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Dependency bump breaks the gate | M | M | Incremental bumps; run gate per phase; back out non-green | builder |
| Node 22 runtime incompatibility | L | M | Verify green gate on 22 locally before PR | builder |
| Healthcheck import-time throw yields 500 not 503 | M | H | Lazy `await import` + try/catch in `GET`; test unset-DATABASE_URL path | builder |
| Lint surfaces many violations | M | L | Trivial fixes or scoped rule-disable; no refactors | builder |
| Pinned action SHA mismatched to tag | L | M | Cross-check SHA↔tag; `# vX.Y.Z` comment | builder |
| Removing `@playwright/test` breaks an import | L | L | grep usage before removal | builder |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| CI-only failures invisible locally (SHA/checksum/YAML) | M | M | Validate YAML + run the exact commands locally; confirm on PR run | builder |

## Validation Checkpoints
1. **After Phase 1**: `npm audit --omit=dev` = 0; gate green on Node 22.
2. **After Phase 2**: `npm run lint` exits 0.
3. **After Phase 3**: `ci.yml` valid; lint + coverage commands run locally; PR CI run green.
4. **After Phase 4**: three health scenarios pass.
5. **After Phase 5**: real route tests pass; no Playwright footprint.
6. **Before Production (Review/verify)**: full gate green on Node 22; PR CI green; spec criteria all checked.

## Monitoring and Observability
### Metrics to Track
- CI job duration (now bounded by `timeout-minutes`); coverage summary (informational, non-gating).
### Logging Requirements
- Healthcheck logs the real DB error server-side (`console.error`) while returning a generic 503 body.
### Alerting
- Railway deploy health now gated by the real 503; a failing `DATABASE_URL` will (correctly) fail the deploy.

## Documentation Updates Required
- [ ] `CONTRIBUTING.md` — remove Playwright/e2e instructions (Phase 5).
- [ ] `.github/` PR + issue templates (Phase 6).
- [ ] N/A — API docs / architecture diagrams / runbooks unchanged (healthcheck body shape preserved).

## Post-Implementation Tasks
- [ ] Confirm the PR's CI run is green (all jobs).
- [ ] Confirm Railway build picks Node 22 (verify phase / next deploy).
- [ ] Security: `npm audit --omit=dev` clean; actions SHA-pinned; gitleaks checksum-verified.

## Expert Review
**Date**: 2026-08-01
**Model**: Pending — porch runs the 3-way (Gemini, Codex, Claude) plan consultation.
**Key Feedback**: To be filled after consultation.

**Plan Adjustments**:
- To be filled after consultation.

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-08-01 | Initial plan draft | Spec 3 approved (ASPIR, auto) | builder aspir-3 |

## Notes
- ASPIR: plan auto-approves; the PR gate is preserved for human review.
- **Commit grouping**: one commit per phase, matching the issue's six numbered areas. The lone
  deviation: the issue lists "add a lint step to CI" under area 2, but all `ci.yml` edits are
  consolidated into the Phase 3 (CI) commit so the workflow is touched exactly once — the lint *config
  and script* still land in Phase 2. Called out here so the grouping is intentional, not accidental.
- **PR strategy**: single PR opened after Phase 6, with all six phase-commits on the branch (per the
  builder PR strategy) — unless the architect requests slicing.
