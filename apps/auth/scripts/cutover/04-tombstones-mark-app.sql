-- 04c — mark the completed deletions, APP side. Needs -v ids='{...}' from 04a.
\set ON_ERROR_STOP on
BEGIN;
UPDATE public.deleted_users SET auth_deleted_at = now()
WHERE id = ANY(:'ids'::uuid[]) AND auth_deleted_at IS NULL;
COMMIT;
