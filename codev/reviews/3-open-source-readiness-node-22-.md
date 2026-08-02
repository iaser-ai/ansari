# Review: Open-Source Readiness — Node 22, Dependency Sweep, Working Lint, CI Hardening, DB Healthcheck, Test-Suite Honesty

## Metadata
- **ID**: review-2026-08-01-open-source-readiness
- **Spec**: [codev/specs/3-open-source-readiness-node-22-.md](../specs/3-open-source-readiness-node-22-.md)
- **Plan**: [codev/plans/3-open-source-readiness-node-22-.md](../plans/3-open-source-readiness-node-22-.md)
- **Protocol**: ASPIR
- **Status**: implementation complete; PR opened for human `pr` gate

## Summary
All six open-source-readiness areas from issue #3 are implemented as six themed commits on
`builder/aspir-3`, plus one review-fix commit. No product-behavior changes except the intended
healthcheck 503-on-dead-DB. The full gate is green on Node 22 throughout:
`lint 0 · typecheck 0 · 470 passed / 3 skipped · build compiles · npm audit --omit=dev = 0`.

3-way reviews at every phase: spec (Gemini APPROVE, Codex+Claude REQUEST_CHANGES → all addressed),
plan (iter1 REQUEST_CHANGES → revised → iter2 APPROVE/COMMENT/COMMENT), implementation (Gemini APPROVE,
Claude APPROVE, Codex COMMENT — comments addressed).

## What shipped, by area

| # | Area | Key outcomes |
|---|------|--------------|
| 1 | Runtime & deps | `.nvmrc`/`engines` → Node 22; `drizzle-kit`/`typescript`/`@types/*` → devDeps; `mongodb` removed; `drizzle-orm 0.45.2` (SQLi GHSA-gpj5-g38j-94v9), `next 15.5.22`, `vitest 4.1.10`; **`npm audit --omit=dev` = 0** via `overrides` (postcss 8.5.25, sharp 0.35.3); `.github/dependabot.yml`; Node-20→22 in 4 docs |
| 2 | Working lint | flat `eslint.config.mjs` (FlatCompat + `@eslint/eslintrc`, Next 15); `eslint-config-next` → 15.5.22; `lint` = `eslint .`; `next.config.ts` `ignoreDuringBuilds`; lint exits 0 |
| 3 | CI hardening | actions SHA-pinned (`checkout` v7.0.1, `setup-node` v7.0.0) + version comments; gitleaks tarball checksum-verified; `concurrency` + `timeout-minutes`; lint + coverage steps (`@vitest/coverage-v8`, report-only); CONTRIBUTING checks contract |
| 4 | Test honesty | vacuous `api.test.ts` → real `login` + public `share` route tests (pglite/mock, FK-seeded users→threads→shares); e2e suite + `playwright.config.ts` + `@playwright/test` removed; all Playwright/e2e doc/config refs cleaned |
| 5 | Healthcheck | `SELECT 1` raced at 2000 ms; 503 on failure/timeout/unset `DATABASE_URL`; `force-dynamic`; lazy db import (avoids import-time 500); unhandled-rejection guard; 4 test cases; response field set unchanged |
| 6 | Polish | `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md`, root `.nvmrc`, root `.editorconfig` |

## Key decisions & deviations

1. **`npm audit` = 0 achieved via `overrides`, not `--force` (the highlight).** The issue claimed all 31
   prod-dep vulns had non-breaking fixes; in reality `npm audit fix` left 3 highs (`postcss`, `sharp`)
   whose only offered fix was a breaking `next@9.3.3` downgrade. I refused `--force` (spec constraint),
   flagged it to the architect, and — per the architect's suggested middle path — added npm `overrides`
   pinning `postcss ^8.5.25` and `sharp ^0.35.3`. These beat next's transitive ranges without touching
   next; the gate stayed green and prod audit reached **0**. The residual dev-only advisories (the
   esbuild/@esbuild-kit chain under `drizzle-kit`) are `--force`-only and correctly left in place.

2. **Phase reorder (test-honesty before healthcheck).** The plan review (Claude) caught that
   `tests/api.test.ts` imported the health route unmocked and asserted 200/`ok`; making the route run
   `SELECT 1` would have turned it red. Test-honesty was sequenced first so it deletes that case before
   the healthcheck lands — preserving the per-phase green-gate invariant.

3. **All `ci.yml` edits consolidated into Phase 3.** Issue area 2 lists "add a lint step to CI"; to touch
   the workflow exactly once, the lint config/script live in Phase 2 while the CI lint step lands in
   Phase 3. Documented as an intentional commit-grouping deviation.

4. **Coverage invoked via `npm run test:coverage`, not bare `vitest`** (a project-local binary isn't on
   a plain workflow shell's PATH — Codex plan review).

5. **`tests/**` left out of lint scope** (consistent with tsconfig excluding it), a conscious decision
   to avoid vitest-globals churn and drive-by changes.

## Lessons learned

- **Verify the issue's factual claims against reality before treating them as ground truth.** "All 31
  vulns have non-breaking fixes" was inaccurate; measuring the actual `npm audit` output surfaced the
  postcss/sharp `--force`-only residual, and npm `overrides` turned an apparent dead-end into a clean 0.
- **npm `overrides` is the right tool for a vulnerable transitive under a framework you can't bump.** It
  pins the fixed version without forcing a breaking parent downgrade — worth reaching for before
  documenting a residual.
- **Per-phase green-gate ordering is a real constraint, not bookkeeping.** An unmocked cross-test
  (`api.test.ts` asserting on the health route) meant the naïve phase order would have shipped a red
  intermediate commit; the review caught it and the reorder fixed it cheaply.
- **The module-scope DB pool is a landmine for healthchecks.** `lib/db/index.ts` throws at *import* time
  when `DATABASE_URL` is unset; a lazy `await import` inside the handler is what turns that into the
  intended 503 rather than a 500 — the exact misconfiguration the probe exists to catch.
- **`next build` runs ESLint once a flat config exists** — `eslint.ignoreDuringBuilds: true` keeps the
  build gate decoupled from lint (which runs as its own CI step).

## Known issues / follow-ups

- **Porch phase-transition quirk (mechanics, not code).** Porch did not ingest the plan's phases JSON
  into `status.yaml` (`plan_phases: []`), so the implement phase would not auto-advance to review. The
  architect rolled back to plan and re-advanced; the JSON is valid and all plan checks pass, but
  `plan_phases` remained empty on re-entry. Per the architect's pre-authorized fallback, the PR was
  opened directly (the `pr` gate remains the human checkpoint). This is a porch orchestration issue with
  no impact on the delivered code.
- **`eslint .` has no `--max-warnings`** (8 pre-existing `no-unused-vars` warnings pass silently). Left
  as a deliberate follow-up — the spec pinned the script value and forbade drive-by refactors.
- **Hand-written pglite DDL in tests can drift from `db/schema/`** — the established `token-grace.test.ts`
  pattern; a schema change won't fail these tests. Out of scope to re-architect here.
- **Runtime healthcheck against a real DB is verified post-deploy** (Railway `healthcheckPath=/api/health`,
  `restartPolicyMaxRetries=3`) — the one change that turns the probe into a live deploy gate.

## Verification
- `npm run lint` → exit 0
- `npm run typecheck` → exit 0
- `npm test` → 470 passed, 3 skipped
- `npm run build` → compiled; `/api/health` is `ƒ (Dynamic)`
- `npm audit --omit=dev` → 0 vulnerabilities
- gitleaks download+checksum+extract flow validated locally; CI YAML validated
