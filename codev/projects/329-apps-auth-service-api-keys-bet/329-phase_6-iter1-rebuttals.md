# Phase 6, iteration 1: response to review

## Codex (REQUEST_CHANGES): the boot check does not bind the constraint to `auth.account` or its columns

**Accepted and fixed.** `hasAuthUniqueConstraint(db, table, name, columns)` now requires the unique constraint `name` to be on `auth.<table>` and to cover exactly `columns`, in order (from `pg_constraint.conkey` with ordinality, joined to `pg_attribute`). `assertSchema` passes `account`, `account_provider_id_account_id_unique` and `['provider_id', 'account_id']`. The columns go in as one parameter (`string_to_array`), not as interpolated SQL.

New tests in `apps/auth/tests/boot.test.ts`. The real constraint is dropped, then a spoof is created; each case must refuse:
- the same name on another `auth` table (`auth.decoy`);
- the same name on `auth.account` over other columns (`account_id, user_id`);
- the same name on `auth.account` with the right columns in the other order.

Negative control: with the old name-only query restored, all three fail (3 failed, 6 passed); with the fix, 9/9 pass. The production-shaped run on Postgres 18.6 was rerun with the new query: 13/13, boot check true on the full schema (step 1a).

## Gemini

Skipped (agy exit 3), non-blocking, as in earlier phases.
