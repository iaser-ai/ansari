# bugfix-165 thread — remove messages.documents

## Investigate (2026-09-24)
- develop has not moved since 1551edd (PR #162 merge), so `git revert -m 1 1551edd` should apply cleanly.
- Reproduced without staging access. I wrote `tests/migration/migration-schema-parity.test.ts`, which builds pglite
  ONLY from the real `drizzle/*.sql` files in journal order. It stops at `0008_model_provenance`
  (the last migration applied on staging/prod) and runs the real helpers. Result: `createMessage` fails with
  `column "documents" of relation "messages" does not exist` (42703), which matches the staging outage.
- Root cause: the Drizzle schema declared `documents`, so every INSERT/RETURNING and the thread-view/share
  projections name it. The migration was not applied, and each pglite suite hand-writes DDL that already
  had the column, so no test could see the gap between code and migrations.
- The fix is a revert of the column surface (tests are most of the LOC). BUGFIX scope holds: net deletion, no new design.
- The regression test stays as a permanent guard. Beyond the deployed-state check, it asserts journal↔.sql 1:1 and that every
  schema column is created by some migration.
