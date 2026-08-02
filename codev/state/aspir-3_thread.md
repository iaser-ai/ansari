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
