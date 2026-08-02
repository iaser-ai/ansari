# Specification: Open-Source Readiness — Node 22, Dependency Sweep, Working Lint, CI Hardening, DB Healthcheck, Test-Suite Honesty

## Metadata
- **ID**: spec-2026-08-01-open-source-readiness
- **Status**: draft
- **Created**: 2026-08-01

## Clarifying Questions Asked
No clarifying questions were needed. Issue #3 is a fully-specified, pre-baked batch of
open-source-readiness fixes with firm constraints. The builder grounded every item against
the real `backend/` tree rather than asking questions:

- **Q: What is the current Node baseline?** A: `backend/.nvmrc` = `20`, `engines.node` = `>=20.0.0`; no root `.nvmrc`.
- **Q: Does any ESLint config exist today?** A: No — no `.eslintrc*` and no `eslint.config.*`; `lint` script calls `next lint` (removed in Next 16), and `eslint-config-next` is pinned `^16` against `next@^15.5.9`.
- **Q: How is the DB reached from a route?** A: `lib/db/index.ts` exports a drizzle instance `db` backed by a singleton `pg` Pool, plus `closeDb()`. Tests mock it via `vi.mock('@/lib/db/index')` + pglite (see `tests/token-grace.test.ts`).
- **Q: What does the health route return today?** A: A static `{ status:'ok', timestamp, service:'ansari-backend' }` — it never touches the database.
- **Q: What do the e2e specs target?** A: `tests/e2e/{chat,login,registration}.spec.ts` all target a frontend at `localhost:8081` that does not exist in this repo.

## Problem Statement
The `ansari` backend is about to be made public. A multi-model review on 2026-08-02 surfaced a
batch of gaps that new contributors and security-minded readers will hit first. None of these are
product-behavior changes; they are hygiene and correctness fixes concentrated in `backend/` and the
repo root:

1. **Stale runtime & vulnerable dependencies.** Node 20 reached end-of-life on 2026-04-30, yet
   `.nvmrc`/`engines`/CI/Railway all still pin it. `npm audit` reports 31 production-dependency
   vulnerabilities with non-breaking fixes, including a SQL-injection advisory in `drizzle-orm`
   (GHSA-gpj5-g38j-94v9) and a critical (dev-only) `vitest` UI-server advisory. Production and dev
   dependencies are also mis-classified (`drizzle-kit`, `typescript`, `@types/*` live in
   `dependencies`; an unused `mongodb` dev dependency lingers).
2. **Lint does not work.** `npm run lint` invokes the removed-in-Next-16 `next lint`, there is no
   ESLint configuration anywhere, and `eslint-config-next` is pinned against the wrong Next major.
   Contributors cannot lint, and CI does not lint.
3. **CI is not hardened.** Actions are on deprecated majors (Node 20 runner deprecation warnings),
   pinned to mutable tags rather than commit SHAs; the gitleaks binary is downloaded without
   checksum verification; there is no `concurrency` cancellation or per-job timeout; and there is no
   coverage reporting.
4. **The healthcheck lies.** `/api/health` returns a static `ok`, so Railway will happily pass a
   deploy whose `DATABASE_URL` is broken — the service reports healthy while every real request fails.
5. **The test suite is dishonest.** `tests/api.test.ts` asserts on object literals it just
   constructed (it can never fail), and the Playwright e2e suite targets a frontend that does not
   exist in this repo while `CONTRIBUTING.md` tells contributors to run it.
6. **Contributor-facing polish is missing.** No PR/issue templates, no root `.nvmrc`, no
   `.editorconfig`.

## Current State
- **Runtime/deps** (`backend/package.json`, `backend/.nvmrc`): `.nvmrc` = `20`; `engines.node` =
  `>=20.0.0`. `dependencies` wrongly contains `drizzle-kit`, `typescript`, and the `@types/*`
  packages. `devDependencies` contains an unused `mongodb`. `drizzle-orm@^0.45.1` (below the patched
  `0.45.2`), `eslint-config-next@^16.1.4`, `vitest@^4.0.17`. No `.github/dependabot.yml`.
- **Lint**: `"lint": "next lint"`. No ESLint config file. `eslint@^9.39.2` is present but unusable
  without config; `eslint-config-next` is on the wrong major.
- **CI** (`.github/workflows/ci.yml`): `backend` job (typecheck/test/build) and `gitleaks` job. Uses
  `actions/checkout@v4` and `actions/setup-node@v4` (mutable tags). `node-version-file: backend/.nvmrc`.
  gitleaks tarball is piped straight into `tar` with no checksum verification. No `concurrency`, no
  `timeout-minutes`, no coverage.
- **Healthcheck** (`src/app/api/health/route.ts`): returns static
  `{ status:'ok', timestamp, service:'ansari-backend' }`; never queries the DB.
  `tests/health.test.ts` asserts only the static shape.
- **Tests**: `tests/api.test.ts` builds `expectedFormat` object literals and asserts on their own
  keys — vacuous. `tests/e2e/{chat,login,registration}.spec.ts` drive a `localhost:8081` frontend.
  `CONTRIBUTING.md` instructs contributors to run `npx playwright test`. The real DB-backed test
  pattern (pglite + `vi.mock('@/lib/db/index')`) is established in `tests/token-grace.test.ts`.
- **Contributor polish**: no `.github/PULL_REQUEST_TEMPLATE.md`, no `.github/ISSUE_TEMPLATE/`, no
  root `.nvmrc`, no `.editorconfig`.

## Desired State
- **Runtime/deps**: Node 22 everywhere (`.nvmrc` = `22`, `engines.node` = `>=22`, CI + Railway pick it
  up via `node-version-file`); build verified green on 22. `npm audit` clean of the fixable prod-dep
  vulns; `drizzle-orm >= 0.45.2`, latest Next 15.5.x patch, `vitest` 4.1.x, Sentry/Resend transitives
  patched. `drizzle-kit`/`typescript`/`@types/*` in `devDependencies`; `mongodb` removed. A
  `.github/dependabot.yml` (npm weekly + github-actions) prevents recurrence.
- **Lint**: a flat `eslint.config.mjs` matched to Next 15, correct `eslint-config-next` pin,
  `npm run lint` passing on the current codebase, and a lint step in CI.
- **CI**: `actions/checkout` and `actions/setup-node` on current majors and pinned to full commit
  SHAs; gitleaks download checksum-verified before extraction; `concurrency` (cancel-in-progress per
  ref) and `timeout-minutes` on jobs; a coverage step (report/summary only, no threshold gate) using
  `@vitest/coverage-v8`.
- **Healthcheck**: `/api/health` runs `SELECT 1` through the pool with a short timeout, returns 503
  on failure, keeps the response shape otherwise identical (`service: 'ansari-backend'`).
  `tests/health.test.ts` covers both the healthy and DB-down paths.
- **Tests**: the vacuous `api.test.ts` cases are replaced with real route tests (pglite/mock pattern)
  prioritizing `v2/users/login` and public `v2/share/[id]`, or deleted outright. The e2e suite is
  removed (or rewritten as API-level smoke tests with a `webServer` block), and `CONTRIBUTING.md`
  matches whatever is chosen.
- **Contributor polish**: `.github/` PR template + basic issue templates; a root `.nvmrc` matching
  backend's; a repo-root `.editorconfig`.

## Stakeholders
- **Primary Users**: External contributors landing on the public repo — they hit lint, tests, and
  setup docs first.
- **Secondary Users**: Security-minded readers auditing the repo; maintainers who triage
  dependency/CI health.
- **Technical Team**: `ansari` backend maintainers (IASER) who run CI and deploy on Railway.
- **Business Owners**: IASER — the open-sourcing decision-holders.

## Success Criteria
- [ ] `backend/.nvmrc` = `22`; `backend/package.json` `engines.node` = `>=22`; root `.nvmrc` = `22`.
- [ ] `npm audit` (prod deps) reports no fixable vulnerabilities; `drizzle-orm >= 0.45.2`, Next on
      latest 15.5.x patch, `vitest` on 4.1.x.
- [ ] `drizzle-kit`, `typescript`, and all `@types/*` are in `devDependencies`; `mongodb` is gone.
- [ ] `.github/dependabot.yml` exists with `npm` (weekly) and `github-actions` ecosystems.
- [ ] `npm run lint` exits 0 on the current codebase via a flat `eslint.config.mjs`; CI runs it.
- [ ] `eslint-config-next` version matches Next 15.
- [ ] CI: `checkout`/`setup-node` on current majors, all third-party actions pinned to full commit
      SHAs; gitleaks download checksum-verified; `concurrency` + `timeout-minutes` present; a coverage
      step runs (no threshold gate).
- [ ] `/api/health` returns 200 with `SELECT 1` succeeding and 503 when the DB query fails/times out,
      response shape otherwise unchanged (`service:'ansari-backend'`). `tests/health.test.ts` covers
      both paths.
- [ ] `tests/api.test.ts` no longer contains self-asserting object-literal cases; real login + share
      route tests exist (or the vacuous cases are deleted).
- [ ] The e2e suite is either removed or rewritten as runnable API smoke tests; `CONTRIBUTING.md`
      reflects the choice with no dangling instructions.
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` and at least one `.github/ISSUE_TEMPLATE/*` exist; root
      `.editorconfig` exists.
- [ ] From `backend/`: `npm run typecheck && npm test && npm run build` are all green on Node 22.
- [ ] No changes to streaming wire formats, prompts, or API behavior (the healthcheck 503-on-dead-DB
      is the sole intentional behavior change).

## Constraints
### Technical Constraints
The following are fixed decisions from the architect's issue and MUST NOT be relitigated:
- **No product-behavior changes** beyond the healthcheck: no changes to streaming wire formats,
  prompts, or API request/response behavior. The `/api/health` 503-on-dead-DB is the only permitted
  behavior change.
- **Healthcheck response shape stays identical** apart from the status code: `service` must remain
  `'ansari-backend'` (frontend and runbooks key on it); keep `status` and `timestamp` fields.
- **No DB schema changes / no migrations** anywhere in this work.
- **All npm commands run from `backend/`.** `backend/package-lock.json` is the single authoritative
  lockfile; there is deliberately no root `package.json`/lockfile. Do not create one.
- **Deps bumps must keep `npm run typecheck && npm test && npm run build` green** from `backend/`.
- **Lint must pass with no drive-by refactors** — fix or explicitly disable rules; do not restructure
  code to satisfy lint.
- **`.env.ci` is the single no-secrets CI env source**; no repository secrets are introduced.
- Commits grouped by the six numbered areas of the issue.

### Business Constraints
- The repo is public-bound; changes must be safe to expose and free of secrets.
- No external budget/compliance dependencies beyond standard open-source hygiene.

## Assumptions
- Node 22 is compatible with Next 15.5.x, drizzle, and the rest of the stack (verified by the green
  `typecheck/test/build` gate on 22).
- The fixable `npm audit` advisories genuinely have non-breaking fixes (per the issue's review).
- The frontend truly does not live in this repo, so the e2e suite has no valid target here.
- Railway reads the Node version from `node-version-file`/`.nvmrc` and needs no separate config edit.
- `@vitest/coverage-v8` is compatible with the pinned `vitest` 4.1.x line.

## Solution Approaches

### Approach 1: Single batched sweep, committed in six themed groups (SELECTED)
**Description**: Implement all six areas together in one PR, with commits grouped by the issue's
numbered areas (runtime/deps, lint, CI, healthcheck, test honesty, contributor polish). Each group
keeps the `typecheck/test/build` gate green.

**Pros**:
- Matches the issue's explicit "keep commits grouped by the numbered areas" instruction.
- One coherent open-source-readiness PR; reviewers see the whole hygiene story at once.
- Groups are largely independent, so a problem in one is easy to isolate by commit.

**Cons**:
- Larger single PR to review.

**Estimated Complexity**: Medium
**Risk Level**: Low (no product-behavior changes except the health 503)

### Approach 2: One PR per numbered area
**Description**: Six sequential PRs.

**Pros**: Smaller reviews.

**Cons**: Six review/merge cycles for tightly-related hygiene; contradicts the builder PR strategy
(single PR unless the architect requests slicing); more overhead than the change warrants.

**Estimated Complexity**: Medium
**Risk Level**: Low

**Decision**: Approach 1. The architect may still request slicing; absent that, ship one PR with
six themed commit groups.

## Open Questions

### Critical (Blocks Progress)
- [ ] None. The issue is fully specified.

### Important (Affects Design)
- [ ] **e2e suite: remove vs. rewrite.** The issue permits either "remove the suite" or "rewrite as
      API-level smoke tests with a `webServer` block." Leaning **remove** (the suite belongs with the
      frontend, which is not in this repo), updating `CONTRIBUTING.md` accordingly. Final call made in
      the plan; both options satisfy the constraint.
- [ ] **api.test.ts: replace vs. delete.** Leaning **replace** the vacuous cases with real
      login + public-share route tests (pglite/mock pattern), which raises coverage honesty more than
      deletion. Deletion remains an acceptable fallback per the issue.

### Nice-to-Know (Optimization)
- [ ] Whether to also pin the first-party `actions/*` to SHAs or only the third-party ones. The issue
      says "pin all actions to full commit SHAs" → pin all.

## Performance Requirements
- **Response Time**: `/api/health` must add only a short-timeout `SELECT 1` (a few hundred ms cap);
  no other latency-sensitive paths change.
- **Throughput**: Unchanged — no hot-path modifications.
- **Resource Usage**: Unchanged.
- **Availability**: The healthcheck now reflects true availability (503 when the DB is unreachable),
  improving deploy-gating fidelity.

## Security Considerations
- **Supply chain**: `npm audit fix` closes the fixable prod-dep advisories (notably the drizzle-orm
  SQL-injection GHSA-gpj5-g38j-94v9); dependabot keeps them closed.
- **CI integrity**: pinning actions to full commit SHAs defends against mutable-tag hijacks;
  checksum-verifying the gitleaks download defends against a tampered release artifact.
- **No new secrets**: `.env.ci` remains the only CI env source; no repository secrets added.
- **Data privacy**: The healthcheck returns only status/timestamp/service — no DB data leaks in the
  503 path (return a generic failure, not the DB error text).

## Test Scenarios
### Functional Tests
1. **Health — happy path**: with a reachable DB (pglite/mock), `GET /api/health` returns 200 and the
   unchanged shape (`status:'ok'`, `service:'ansari-backend'`, ISO `timestamp`).
2. **Health — DB down**: with the `SELECT 1` throwing/timing out, `GET /api/health` returns 503 and a
   generic non-ok body (no raw DB error leaked).
3. **Login route**: real `POST /api/v2/users/login` against a pglite-backed DB — valid credentials
   return the Ansari token shape; invalid credentials return 401 with the generic message.
4. **Public share route**: `GET /api/v2/share/[id]` returns the snapshot shape for an existing share
   and 404 for a missing one.

### Non-Functional Tests
1. **Lint**: `npm run lint` exits 0 on the current tree.
2. **Coverage**: the CI coverage step runs and emits a summary without gating.
3. **Green gate on Node 22**: `npm run typecheck && npm test && npm run build` pass on Node 22.

## Dependencies
- **External Services**: GitHub Actions (CI), Railway (deploy) — both consume the Node version via
  `node-version-file`.
- **Internal Systems**: `lib/db/index.ts` (pool/`db`/`closeDb`) for the healthcheck query; the
  pglite mock pattern from `tests/token-grace.test.ts`.
- **Libraries/Frameworks**: Next 15.5.x, ESLint 9 flat config + `eslint-config-next` (Next 15),
  `drizzle-orm >= 0.45.2`, `vitest` 4.1.x, `@vitest/coverage-v8`, `pg`, `@electric-sql/pglite`.

## References
- Issue #3 (this repo) — the source batch.
- `tests/token-grace.test.ts` — canonical pglite + `vi.mock('@/lib/db/index')` test pattern.
- `CONTRIBUTING.md` — the checks contract that must stay accurate.
- GHSA-gpj5-g38j-94v9 — drizzle-orm SQL-injection advisory.

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| A dependency bump breaks typecheck/test/build | Medium | Medium | Bump incrementally; run the full gate after each group; back out any bump that isn't non-breaking. |
| Node 22 surfaces a runtime incompatibility | Low | Medium | Verify the green gate on 22 locally before PR; Railway/CI read `.nvmrc`. |
| Lint surfaces many violations tempting drive-by refactors | Medium | Low | Fix trivially or disable the offending rule with a scoped comment; no restructuring (constraint). |
| Healthcheck change alters response shape consumers rely on | Low | High | Keep `status`/`timestamp`/`service` fields identical; only add the 503 status path; test both paths. |
| Removing e2e leaves stale CONTRIBUTING guidance | Medium | Low | Update `CONTRIBUTING.md` in the same commit group as the e2e change. |
| `@vitest/coverage-v8` version mismatch with vitest | Low | Low | Install the matching 4.1.x-compatible coverage package; coverage step is report-only, non-gating. |

## Expert Consultation
**Date**: 2026-08-01
**Models Consulted**: Pending — porch runs the 3-way (Gemini, Codex, Claude) spec consultation.
**Sections Updated**: To be filled after consultation feedback is incorporated.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes
- This is an ASPIR project: spec and plan auto-approve; the PR gate is preserved for human review.
- Two design choices (e2e remove-vs-rewrite, api.test replace-vs-delete) are deliberately deferred to
  the plan; both branches satisfy the issue's constraints, so neither blocks the spec.
