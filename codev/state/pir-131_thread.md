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
