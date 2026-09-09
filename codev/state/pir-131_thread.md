# Builder thread — pir-131 (Port legacy ansari-backend → Postgres migration script)

## 2026-09-09 — Plan phase

- Merged `origin/develop` into `builder/pir-131` before planning: the branch base
  (aa53ace) predated migrations 0007 (tool_calls / tool_call_orphans) and 0008
  (model_provider / model_id) that the issue references. Planning against the stale
  schema would have missed four columns.
- Read the full legacy source (`ansari-multisage/scripts/*`, ~1,100 lines) and its
  spec/plan/review. Behaviors to preserve are listed in the plan.
- Two repo constraints reshape the port without changing behavior:
  1. `scripts/**` IS linted here and the #17 guard forbids `process.env.DATABASE_URL`
     outside `lib/config.ts`; `lib/db/index.ts` validates the whole Zod schema at import.
     So the CLI's fail-fast env check goes through `config`, and `MONGO_URL` /
     `MONGO_DB_NAME` join the Zod schema + `turbo.json` globalEnv.
  2. The old DB-touching tests mocked the Drizzle chain; issue + lessons-critical require
     pglite with the current DDL, so those three suites are rewritten.
- Found a latent guard-test trap: `tests/release-doc.test.ts` matches `pnpm migrate…`
  with a `\b` terminator, so `pnpm migrate-users` in RELEASE.md would be read as script
  `migrate` and fail. Plan fixes the terminator.
- Plan written to `codev/plans/131-port-legacy-ansari-backend-pos.md`; at
  `plan-approval` gate.

## 2026-09-09 — Plan revised after issue rewrite

- Issue #131 body was rewritten while the first draft sat at the gate. New framing:
  PARTIAL port (typecheck + lint + pglite tests only; not verified, not for prod), next
  use is ansari-multisage Postgres → Better Auth, so modules split into `source/` (Mongo
  reader — obsolete next) and `target/` (writers — rewritten next) with `types.ts` as
  the seam. Mongo env vars stay on `process.env` (NOT in Zod), declared in turbo globalEnv.
- Hard constraint relayed by the architect and posted on the issue: never execute the
  script in any mode. Test plan is now static checks + vitest only.
- Probed `tsc --noEmit` with `scripts/**` included: exit 0 on the current tree, so the
  plan drops the tsconfig exclusion to make "typechecks" real.
- Dropped from the plan: runbook / RELEASE.md changes, release-doc regex fix, the
  reserved-address skip (behavior change) — the last is ledgered as a known gap instead.

## 2026-09-09 — Implement phase complete, at dev-approval gate

- Ported into `apps/api/scripts/migrate-users/` with `source/` vs `target/` split and
  `types.ts` as the seam; README + entry-point banner mark it PARTIAL / not verified /
  not for prod, with the column inventory (0002–0008 → `TODO(port)`) and a test ledger.
- Script was NEVER executed (hard constraint). Verification = `pnpm lint` (0 errors,
  7 pre-existing warnings elsewhere), `pnpm typecheck` (now covers `scripts/**`),
  full vitest (837 pass; 79 in tests/migration, 74 new), gitleaks clean on tree + commits.
- Surprises: (1) Zod v4 error text is path-based ("Invalid input… path DATABASE_URL"),
  not the custom min(1) message, when the var is absent — test asserts the path.
  (2) pglite's drizzle `delete()` does not populate `rowCount`; switched
  delete-readonly to `.returning({id}).length` (same counts on node-postgres).
- Behavior-neutral port changes are listed in the README "Port changes" section.
