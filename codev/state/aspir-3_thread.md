# aspir-3 — Open-source readiness (Node 22 + dep sweep, lint, CI, healthcheck, test honesty)

Protocol: ASPIR (strict, porch-driven). Issue #3.

## Specify phase
- Started: read issue #3 (very detailed — essentially a pre-baked spec) and grounded against the real backend.
- Grounding findings:
  - `backend/.nvmrc` = 20; `engines` = `>=20.0.0`. No root `.nvmrc`, no `.editorconfig`, no `.github/dependabot.yml`.
  - `package.json`: `drizzle-kit`, `typescript`, `@types/*` sit in `dependencies`; `mongodb` unused devDep; `eslint-config-next@^16` against `next@^15.5.9`; `drizzle-orm@^0.45.1`; `vitest@^4.0.17`.
  - `lint` script = `next lint` (removed in Next 16); no ESLint config anywhere.
  - CI: `checkout@v4`, `setup-node@v4` (no SHA pins); no `concurrency`, no `timeout-minutes`; gitleaks tarball downloaded without checksum verify; no coverage step.
  - `src/app/api/health/route.ts` returns static `ok` (never touches DB). `tests/health.test.ts` covers only the static path.
  - `tests/api.test.ts` is vacuous (asserts on object literals it constructs). `tests/e2e/{chat,login,registration}.spec.ts` target a nonexistent frontend at localhost:8081.
  - DB access: `lib/db/index.ts` exports `db` (drizzle over `pg` Pool) + `closeDb()`; pglite mock pattern lives in `tests/token-grace.test.ts` (`vi.mock('@/lib/db/index')`).
  - Routes to test: `POST /api/v2/users/login`, public `GET /api/v2/share/[id]`.
- No `## Baked Decisions` heading in the issue, but Constraints are firm (no wire-format/prompt/API changes; healthcheck 503-on-dead-DB excepted; deps must keep typecheck+test+build green).
- Writing spec to `codev/specs/3-open-source-readiness-node-22-.md`.
- 3-way spec review: Gemini APPROVE, Codex + Claude REQUEST_CHANGES. All feedback high-signal and accepted:
  - `npm audit` criterion was unachievable as written — `--force` would downgrade `drizzle-kit` 0.31.8→0.18.1 (breaking). Restated: after `drizzle-kit`→devDeps, `npm audit --omit=dev` = 0; `--force` forbidden.
  - Healthcheck fully specified: unset `DATABASE_URL` must yield 503 (module-scope `getPool()` throws a 500 at import otherwise); 2000 ms raced timeout (pool is 5000 ms); `export const dynamic='force-dynamic'`; exact 200/503 bodies (same field set, `status`→`'error'`).
  - Resolved deferred choices in-spec: e2e → REMOVE (+ `playwright.config.ts` + `@playwright/test`); `api.test.ts` → REPLACE with real login+share route tests. Pin ALL actions to SHAs.
  - Softened Railway Node claim (`railway.toml` has no Node directive); fixed future-dated review; `lint` script → `eslint .`.
- Rebuttal written, spec re-verified, phase auto-advanced (ASPIR, no spec gate).

## Plan phase
- 6 phases = the issue's 6 numbered areas, one atomic commit each. Order dependency-driven: (1) Node22+deps → (2) lint → (3) CI → (4) healthcheck → (5) test honesty → (6) contributor polish.
- Deliberate deviation: ALL `ci.yml` edits consolidated into Phase 3 (workflow touched once), so area 2's "add lint step to CI" lands in Phase 3 while lint config/script land in Phase 2. Documented in plan Notes.
- Plan written to `codev/plans/3-open-source-readiness-node-22-.md`; running checks + 3-way plan review.
- 3-way plan review: Gemini APPROVE, Codex + Claude REQUEST_CHANGES. All verified against tree + accepted:
  - **Load-bearing fix**: swapped Phase 4 & 5. `tests/api.test.ts:21` imports the health route UNMOCKED and asserts 200/`ok`; making the route run `SELECT 1` would turn it red. Test-honesty (deletes that case) now runs BEFORE healthcheck → per-phase gate stays green.
  - Named every stale doc: Node-20 refs (README:33,39,44 / AGENTS:17 / CLAUDE:17 / self-hosting:8) → Phase 1; Playwright refs (README:39 / AGENTS:34 / CLAUDE:34 / tsconfig:33 exclude / .gitignore:8-9) → Phase 4.
  - Phase 2 ESLint: use `FlatCompat` + `@eslint/eslintrc` (Next 15 has no native flat spread), verify-then-install. tests/** left unlinted = conscious decision.
  - Phase 3 coverage: `test:coverage` npm script + `npm run test:coverage` (bare vitest not on CI PATH).
  - Phase 4 share test: `shares.thread_id` is notNull FK → seed users→threads→shares in order.
  - Phase 5 healthcheck tests: 2000ms timeout via fake timers; unset-DATABASE_URL via throwing mock factory (honesty note: exercises route try/catch, not real import-time throw). Railway `/api/health` becomes a real deploy gate (`restartPolicyMaxRetries=3`) → post-deploy probe check added.
- Rebuttal written. Re-verify triggered iter2 re-consultation.
- 3-way plan re-review (iter2): Gemini APPROVE, Codex COMMENT, Claude COMMENT — no blockers. 3 minor comments folded in:
  - Phase 2: `tests/**` → flat config global `ignores` (was contradictory: `eslint .` would lint all ~45 test files).
  - Phase 2: `next.config.ts` → `eslint.ignoreDuringBuilds: true` (else `next build` runs ESLint once config exists).
  - Phase 3: `CONTRIBUTING.md:26-33` "CI runs exactly these" gains `npm run lint`.
- iter2 rebuttal written. Plan is implementation-ready. Advancing toward Implement (ASPIR, no plan gate).

## Implement phase
- Porch runs Implement as ONE unit (build+tests gate; per-phase placeholders unrendered). Doing all 6 plan phases as 6 grouped commits on `builder/aspir-3`, then `porch done` → 3-way impl review.
- Env: Node **26.3.1** (satisfies >=22); `npm ci` OK (allow-scripts wrapper deferred native builds but bcrypt/esbuild prebuilds work). Baseline gate GREEN: typecheck clean, **471 passed / 3 skipped / 45 files**.
- Audit confirms review: 31 prod vulns incl. drizzle-orm GHSA-gpj5-g38j-94v9; esbuild/@esbuild-kit chain under drizzle-kit is the `--force`-only one (→ leaves prod graph once drizzle-kit→devDeps). Target versions: next 15.5.22, vitest 4.1.10, drizzle-orm 0.45.2, eslint-config-next 15.5.22, @vitest/coverage-v8 4.1.10.
- Phase 1 DONE: `.nvmrc`→22, `engines`→>=22.0.0; drizzle-kit/typescript/@types/* → devDeps; mongodb removed; drizzle-orm→0.45.2, next→15.5.22, vitest→4.1.10; dependabot.yml (npm /backend weekly + github-actions); doc Node bumps (README:33,44 / AGENTS:17 / CLAUDE:17 / self-hosting:8). Gate GREEN (typecheck, 471 tests, build).
- ⚠️ **AUDIT FINDING → RESOLVED via npm overrides**: issue said "31 prod vulns, all non-breaking". Reality: `npm audit fix` (non-breaking) got prod 31→3; the 3 residual highs (`postcss`, `sharp`, both transitive under `next@15.5.22`) were only `--force`-fixable via `next@9.3.3` (catastrophic Next 15→9). Notified architect; architect endorsed no-force and suggested trying **npm `overrides`** as a middle path. Did so: `overrides: {postcss ^8.5.25, sharp ^0.35.3}` → they beat next's transitive ranges WITHOUT touching next. Result: **`npm audit --omit=dev` = 0**, and the full gate stays GREEN (typecheck, 471 tests, build compiles on sharp 0.35.3 + postcss 8.5.25). Kept the overrides (folded into the Phase 1 commit). Remaining 5 total-audit vulns are all dev-only (esbuild chain under drizzle-kit) — correctly left, `--force`-only.
- Phase 2 DONE: `eslint.config.mjs` (flat, FlatCompat + `@eslint/eslintrc`, extends `next/core-web-vitals` + `next/typescript`, ignores tests/** + build output); `eslint-config-next`→^15.5.22; `+@eslint/eslintrc ^3.3.1`; `lint`→`eslint .`; `next.config.ts` `eslint.ignoreDuringBuilds:true`. `npm run lint` EXIT 0 (0 errors, 8 pre-existing `no-unused-vars` warnings — left per no-drive-by-refactors; warnings don't fail lint). Gate green (typecheck, build compiles, audit still 0).
- Phase 4 DONE: rewrote `tests/api.test.ts` — replaced 9 vacuous object-literal cases with 6 REAL route tests (pglite + `vi.mock('@/lib/db/index')`): login valid→token shape+2 tokens persisted, wrong-pw→401, unknown-email→401, malformed→422; public share found→snapshot (single text block collapsed to string), missing→404. Seeds users→threads→shares in FK order (real bcrypt hash via `hashPassword`). Removed `tests/e2e/` (3 specs), `playwright.config.ts`, `@playwright/test` devDep; cleaned Playwright refs in README:39, AGENTS:34, CLAUDE:34, tsconfig exclude, `.gitignore` (test-results/playwright-report), CONTRIBUTING paragraph. Playwright sweep CLEAN (2 lockfile hits are next's own optional peerDep, not ours). Gate green: lint 0, typecheck 0, **468 passed/3 skipped** (−3 net from 9→6 cases), audit 0.
- Phase 3 DONE: hardened `.github/workflows/ci.yml` — `concurrency` (cancel-in-progress per ref); `timeout-minutes` (backend 15, gitleaks 10); actions SHA-pinned w/ version comments: checkout@3d3c42e…#v7.0.1, setup-node@82076278…#v7.0.0; gitleaks tarball now checksum-verified (sha256 9991e0b2…) before extract; added `Lint` step; `Test (with coverage)` step via `npm run test:coverage` (single run does tests+coverage, report-only). Added `@vitest/coverage-v8 ^4.1.10` + `test:coverage` script. Coverage runs locally (83.37% stmts). `CONTRIBUTING.md` checks block now lists `npm run lint` (4 checks). YAML valid; gitleaks download+checksum+extract flow tested end-to-end. Note: setup-node/checkout v7 behavior only fully verifiable on the PR CI run.
