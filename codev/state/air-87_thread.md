# air-87 — Feedback upsert: dedupe + idempotent POST /api/v2/feedback

## Implement (2026-08-30)

Implemented per issue #87's settled design, no deviations:

- `db/schema/feedback.ts`: unique index `idx_feedback_user_message_class` on
  `(user_id, message_id, feedback_class)` (project `idx_` naming convention).
- `lib/db/feedback.ts`: `createFeedback` renamed to `upsertFeedback` —
  `ON CONFLICT ... DO UPDATE SET comment = COALESCE(NULLIF(excluded.comment, ''), feedback.comment)`.
  Comment guard verified against real pglite; `created_at` untouched on conflict.
  Kept the trailing-`exec` executor pattern.
- Route unchanged on the wire: same schema, same 200/404/422/500, same response
  keys; only difference is repeat POST returns the same `id`. Pinned by test.
- Migration **0006_feedback_dedupe_upsert.sql**: hand-written dedup DELETE
  (keep best row per group: non-empty comment > latest created_at > lowest id)
  then `CREATE UNIQUE INDEX`, one file. drizzle-kit generated it as 0005; I
  renamed tag+file to 0006 because **spec #73 (in flight) owns 0005**. Journal
  entry is idx 5 / tag `0006_feedback_dedupe_upsert`, snapshot is
  `meta/0005_snapshot.json` (idx-named). **Whichever branch merges second
  rebases and regenerates** — if #73 lands first, I regenerate journal idx/
  snapshot on rebase; the SQL filename already avoids collision.
- Migration SQL is executed verbatim from the file by a test
  (`tests/feedback-upsert.test.ts`): seeds duplicate groups without the index,
  runs the DELETE + index, asserts exact survivorship and that the index then
  rejects a re-duplicate.

Fresh grep for `CREATE TABLE feedback` in tests (issue #70 schema-drift lesson):
2 hits, both carry the unique index —
`tests/executor-threads-feedback.test.ts:81`, `tests/feedback-upsert.test.ts:38`.

Verification: new suite 13/13; full `pnpm test` 651 passed / 3 pre-existing
skips; `pnpm typecheck` and `pnpm build` green (CI env loaded per apps/api
CLAUDE.md).

Gotcha hit once: a trimmed pglite `messages` DDL made `findMessageInOwnedThread`
throw 42703 (route 500s) — pglite DDL must mirror the full schema columns.
Used the executor-test DDL verbatim.
