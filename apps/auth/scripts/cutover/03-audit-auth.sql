-- 03 — copy audit, AUTH side. READ-ONLY. The same `key|value` lines as
-- 03-audit-app.sql; copy.sh diffs them. The hash checksum is over the
-- credential accounts' password column, ordered by user id, so a hash altered
-- or truncated in transit fails the audit before the app migration runs.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
BEGIN TRANSACTION READ ONLY;
WITH c AS (
  SELECT user_id, password FROM auth.account WHERE provider_id = 'credential'
)
SELECT 'rows|' || count(*) FROM auth.users
UNION ALL SELECT 'id_checksum|' || coalesce(md5(string_agg(id::text, ',' ORDER BY id)), '') FROM auth.users
UNION ALL SELECT 'email_checksum|' || coalesce(md5(string_agg(email, ',' ORDER BY id)), '') FROM auth.users
UNION ALL SELECT 'hash_checksum|' || coalesce(md5(string_agg(password, '' ORDER BY user_id)), '') FROM c
UNION ALL SELECT 'credentials|' || count(*) FROM c
UNION ALL SELECT 'system_domain_rows|' || count(*) FROM auth.users WHERE email LIKE '%@system.ansari.chat';
COMMIT;
