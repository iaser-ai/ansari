-- Rollback (docs/cutover/rollback.md step 2), APP database. Valid only until
-- cutover_at + 24h. Users created at or after the recorded cutover time have
-- no legacy password and cannot sign in to the legacy code; they are removed,
-- with their threads, preferences and feedback (the public.users cascade).
--
-- Dry run (prints the count, changes nothing):
--   psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v cutover_at='<recorded ISO time>' -f rollback-remove-post-cutover-users.sql
-- Delete (after reading the dry-run count):
--   psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v cutover_at='<recorded ISO time>' -v confirm=yes -f rollback-remove-post-cutover-users.sql
\set ON_ERROR_STOP on
\if :{?cutover_at}
\else
  DO $$ BEGIN RAISE EXCEPTION 'rollback: set -v cutover_at=<the recorded cutover time>'; END $$;
\endif

SELECT count(*) AS post_cutover_users
FROM public.users
WHERE created_at >= :'cutover_at'::timestamptz AND system_key IS NULL;

\if :{?confirm}
\else
  \set confirm off
\endif
\if :confirm
  BEGIN;
  DELETE FROM public.users
  WHERE created_at >= :'cutover_at'::timestamptz AND system_key IS NULL;
  COMMIT;
  \echo 'rollback: post-cutover users removed'
\else
  \echo 'rollback: dry run only; re-run with -v confirm=yes to delete'
\endif
