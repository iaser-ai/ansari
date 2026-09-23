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

## Fix + PR (2026-09-24)
- Commit d9e3760: `git revert -m 1 1551edd` plus restoring the #66 codev record (specs/plans/reviews/state and `codev/projects/66-*`, which the revert had also deleted).
  apps/api lib/src/db/tests are byte-identical to pre-#162. Full suite green (77 files); probe-column negative control fails all 3 DB checks.
- PR #173. CMAP: codex=APPROVE, claude=APPROVE, gemini=skipped (agy produced no output). NOTE: `consult` needs `--issue 165` inside a builder, or it errors "Multiple projects found".
- Claude follow-ups applied: close the PGlite clients; add a "superseded by #165" banner on the #66 review; document the `DEPLOYED_THROUGH` rule in arch-critical.
  Architect decision surfaced: the guard deliberately red-lights any future migration-adding PR until the constant is bumped. That bump is the deploy-prerequisite flag.
