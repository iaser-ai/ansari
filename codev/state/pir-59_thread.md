# Builder pir-59 — Build Better Auth (apps/auth + packages/auth)

## Phase: PLAN (iteration 1)

### Investigation findings (2026-08-21)

- **Current workspace = 5 packages**: `@ansari/eslint-config`, `@ansari/tsconfig`,
  `@ansari/types`, `ansari-api`, `ansari-frontend`. Issue's "5 → 7" checkbox means
  **add exactly 2** → `apps/auth` + `packages/auth`. So the scaffold's separate
  `packages/db` and `packages/env` must be **folded into `packages/auth`**, not
  imported as-is (that would be 5→9). This resolves design decisions #1 and #2.
- Scaffold source at `/Users/amrmohamed/repos/testing/ansari`. Signal files:
  `packages/auth/src/index.ts` (34-line Better Auth config), `packages/db/src/schema/auth.ts`
  (user/session/account/verification), `packages/env/src/server.ts` (t3-env),
  `apps/server/src/index.ts` (express + `toNodeHandler(auth)` at `/api/auth{/*path}`).
- Scaffold uses `@ansari/config` + `catalog:` pins for better-auth/zod/dotenv.
  **Our repo uses `@ansari/tsconfig` + `@ansari/eslint-config`** and the workspace
  catalog only pins typescript/eslint/typescript-eslint. Issue says
  **pnpm-workspace.yaml must stay unchanged** → cannot add catalog entries →
  **pin all new deps explicitly** in the new package.jsons (no `catalog:` for
  better-auth/zod/etc). Use `@ansari/tsconfig`/`@ansari/eslint-config`, drop `@ansari/config`.
- Env validation: scaffold uses `@t3-oss/env-core`. To stay self-contained + avoid a
  new catalog/dep, use a small **zod** env module inside `packages/auth` (mirrors
  apps/api's `lib/config.ts` validated-config pattern). apps/api untouched.
- Migration safety: `packages/auth` gets its **own** `drizzle.config.ts` pointing only
  at its own schema + its own `out` dir → `drizzle-kit generate` sees only the 4 new
  tables → CREATE TABLE only, structurally cannot ALTER/DROP existing tables.
- CI (`.github/workflows/ci.yml`): `api` job = `--filter ansari-api...`, `frontend` job
  runs `--filter ./packages/*` lint+typecheck (would cover `packages/auth` if it has
  those scripts) + builds frontend. **No job covers `apps/auth`** — flag whether to add
  coverage. `turbo.json` needs `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`/`CORS_ORIGIN` in
  `globalEnv` (decision #3, arch-critical strict env). Consider `packages/auth` source in
  `globalDependencies` (workspace:* does not add contents to consumer hash).
- Hard boundary tables (no ALTER/DROP): users, tokens, threads, messages, feedback,
  shares, preferences. apps/api is off-limits entirely (`git diff apps/api` must be empty).

Next: write plan to `codev/plans/59-build-better-auth-in-apps-auth.md`, commit, hit
plan-approval gate.

## Phase: IMPLEMENT (iteration 1)

Plan APPROVED by human (via architect, 2026-08-21). Architect refinements:
- **CI**: `packages/auth` is ALREADY covered by frontend job's `--filter ./packages/*`
  (lint + typecheck ONLY — no build/test). Do NOT duplicate. Add a **third CI job**
  `auth (lint, typecheck, test, build)` mirroring the `api` job, covering `apps/auth`
  (its dep-closure filter `ansari-auth...` also pulls in `@ansari/auth`, so packages/auth
  tests get a home there).
- **Must add a comment in ci.yml above the new job**: the new check is NOT in develop's
  required-checks list (admin-only), so it can fail while PRs merge anyway — "covered but
  not enforcing." Point the comment at #50 (architect adding to #50's admin steps).
- **Correction**: "pnpm-workspace.yaml unchanged" meant the globs already cover us (no edit
  NEEDED), not a prohibition. Explicit pinning still the right call — decision stands.
- Architect endorsed all 4 design decisions. At dev-approval he checks hardest: (1) empty
  `git diff apps/api/`, (2) migration SQL CREATE TABLE only, (3) auth actually authenticates
  with observed evidence (row counts, cookie, sign-out invalidates).

Build order: packages/auth → apps/auth → turbo.json → ci.yml → pnpm install → generate
migration (review SQL) → local PG e2e → root lint/typecheck/build/test.

### IMPLEMENT results (2026-08-21) — all green, dev-approval ready

Built exactly 2 packages (5→7 verified via `pnpm ls -r --depth -1`):
- `packages/auth` (@ansari/auth): schema.ts (4 tables, no env dep), env.ts (lazy zod,
  mirrors lib/config.ts), db.ts, index.ts (`createAuth(db?)` factory — NO import-time
  singleton, so importing the lib opens no DB connection; app entrypoint constructs it),
  drizzle.config.ts (scoped), generated migration, pglite integration test (4 tests).
- `apps/auth` (ansari-auth): Express service, `toNodeHandler(auth)` at /api/auth/*,
  health `/`, `/api/me` via getSession. Port 3100 (env PORT).
- Root: turbo.json globalEnv +3, globalDependencies +packages/auth/src/**, ci.yml new
  `auth` job, pnpm-lock.yaml.

**Migration SQL proof**: `drizzle/0000_better_auth_init.sql` = CREATE TABLE ×4 + 2 ALTER
ADD CONSTRAINT (FKs on NEW account/session → NEW user) + 3 CREATE INDEX. Negative-tested
scan for ALTER/DROP against existing tables (users/tokens/threads/messages/feedback/
shares/preferences) → **0 hits**; scan proven to catch a known-bad `users` line and not
false-positive on singular `user`. NEVER db:push.

**Real Postgres e2e** (docker postgres:16 on :55432, migration applied via drizzle-kit
migrate → 4 tables, real apps/auth service booted, curl):
- sign-up POST /api/auth/sign-up/email → 200, `user` 0→1, `session` 0→1 (auto-session)
- sign-in → 200, Set-Cookie `better-auth.session_token` present, `session` →2
- GET /api/me w/ cookie → 200 (session+user resolved); no cookie → 401
- sign-out (with Origin header, as browsers send) → 200 {"success":true}, session row
  removed; /api/me after → 401. (Curl w/o Origin gets 403 MISSING_OR_NULL_ORIGIN — CSRF
  guard, not a bug; pglite test also proves sign-out invalidates at API level.)

**Full workspace**: `pnpm lint` 5 tasks ✓ (api warnings pre-existing, 0 errors), `pnpm
typecheck` 6 ✓, `pnpm test` — existing suite 623 passed/3 pre-existing skips UNCHANGED +
@ansari/auth 4 ✓, `pnpm build` 4 ✓. `git diff apps/api/` EMPTY. pnpm-workspace.yaml
unchanged. Lockfile: only new subtrees (better-auth/express/kysely); drizzle-orm stays
0.45.2 (peer-hash gained kysely, not a version bump); single zod@4.4.3.

**globalDependencies finding (tested, corrected the comment)**: `packages/auth/src/**` is
NEEDED for apps/auth#typecheck/#lint (their dependsOn has no `^`, so turbo doesn't traverse
internal-dep hashes) but NOT for #build (build.dependsOn has `^build`, caret traverses dep
package hashes → busts on auth edits on its own). Proved both directions per task. Comment
in turbo.json corrected to say exactly this. @ansari/auth's own lint/typecheck/test run on
its own files regardless.

### REVIEW phase — PR #61, consultation + architect REQUEST_CHANGES (iter 2)

3-way consultation: gemini APPROVE, codex REQUEST_CHANGES, claude APPROVE (all after I fixed a
gitleaks CI failure — the fake BETTER_AUTH_SECRET test fixture tripped generic-api-key; allowlisted
the literal in .gitleaks.toml, verified `gitleaks detect` → no leaks over full history). Addressed
claude's 4 non-blocking nits proactively.

Architect then returned **REQUEST_CHANGES** (confirmed 2 of codex's findings independently). Fixed all 3:
1. **`pnpm dev` broke in a clean env** — apps/auth's dev script ran under `turbo run dev` and
   getEnv() throws without auth env (a fresh contributor per CONTRIBUTING only sets apps/api env).
   My "pnpm dev green" earlier passed only because my shell had the vars — the signature failure.
   Reproduced (node dist, vars unset → crash). Fix: excluded apps/auth from default dev
   (`--filter=!ansari-auth`), added `pnpm auth`/`pnpm dev:auth` shortcuts, clearer getEnv error.
   Re-verified from a shell with all 3 vars UNSET → ansari-auth#dev not scheduled.
2. **Wrong Expo scheme** — trusted `ansari://` but app.json scheme is `askansari`. Fixed →
   `askansari://`. Coverage: assert auth.options.trustedOrigins ∋ askansari:// ∌ ansari://
   (negative-tested — reverting fails it). Probed 1.6.27: no HTTP 403 discriminates a custom scheme
   in-process, so config-level assertion is the honest test with teeth.
3. **Secure cookie over http** — hardcoded secure:true/sameSite:none contradicts http://localhost:8081
   (browser drops Secure cookie on http → silent login failure). Fixed: secure iff BETTER_AUTH_URL is
   https, sameSite none-iff-secure else lax. Coverage: HTTP-level Set-Cookie assertions for http (Lax,
   no Secure) and https (Secure, None) — negative-tested.
   @ansari/auth now 8 tests (4 API + 4 HTTP). Full suite green; apps/api 623/3-skip unchanged.

**CI**: added 3rd job `auth (lint, typecheck, test, build)` filtering `ansari-auth...`
(covers @ansari/auth too). packages/auth already lint+typecheck'd by frontend job's
`./packages/*`; its TESTS get a home in the new auth job. Comment above the job warns the
check is NOT yet in develop's required list (admin-only, tracked in #50) — runs but doesn't
gate merges until an admin adds it. apps/auth/.env.ci uses the placeholder-not-a-real-*
convention from apps/api/.env.ci (gitleaks-safe).
