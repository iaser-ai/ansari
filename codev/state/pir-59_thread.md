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
