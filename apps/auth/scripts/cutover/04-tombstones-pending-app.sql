-- 04a — pending deletions, APP side. READ-ONLY. Prints one psql array literal
-- of the tombstoned ids whose auth-side delete has not completed (an
-- apps/auth failure during DELETE /v2/users/me). complete-tombstones.sh feeds
-- it to 04b and 04c.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SELECT '{' || coalesce(string_agg(id::text, ',' ORDER BY deleted_at, id), '') || '}'
FROM public.deleted_users
WHERE auth_deleted_at IS NULL;
