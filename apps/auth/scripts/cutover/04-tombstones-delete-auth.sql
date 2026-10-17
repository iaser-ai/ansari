-- 04b — complete pending deletions, AUTH side. Deletes the users directly;
-- the foreign-key cascade removes their sessions and accounts (amendment C).
-- It never calls the delete endpoint. Needs -v ids='{...}' from 04a.
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM auth.users WHERE id = ANY(:'ids'::uuid[]);
COMMIT;
