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
