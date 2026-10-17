-- 05 — admin audit, AUTH side, after grant-admin.ts (runbook step 8). READ-ONLY.
-- The printed set must equal the owner-approved admin list exactly.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
BEGIN TRANSACTION READ ONLY;
SELECT email FROM auth.users WHERE role = 'admin' ORDER BY email;
COMMIT;
