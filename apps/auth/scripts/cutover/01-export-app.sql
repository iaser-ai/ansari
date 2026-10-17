-- 01 — export from the APP database to psql's standard output. READ-ONLY.
-- Never run on its own: copy.sh pipes it straight into 02-import-auth.sql, so
-- the rows (password hashes included) never touch a file.
-- System accounts are never exported; emails are normalized on the way out.
\set ON_ERROR_STOP on
\copy (SELECT id, lower(trim(email)), first_name, last_name, password_hash, registered_via, created_at, updated_at FROM public.users WHERE system_key IS NULL ORDER BY id) TO pstdout
