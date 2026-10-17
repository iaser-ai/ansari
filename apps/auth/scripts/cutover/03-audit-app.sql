-- 03 — copy audit, APP side. READ-ONLY. Prints `key|value` lines that
-- 03-audit-auth.sql prints for the auth side; copy.sh diffs the two and fails
-- on any difference. Counts and md5 checksums only.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
BEGIN TRANSACTION READ ONLY;
WITH u AS (
  SELECT id, lower(trim(email)) AS email, password_hash
  FROM public.users
  WHERE system_key IS NULL
)
SELECT 'rows|' || count(*) FROM u
UNION ALL SELECT 'id_checksum|' || coalesce(md5(string_agg(id::text, ',' ORDER BY id)), '') FROM u
UNION ALL SELECT 'email_checksum|' || coalesce(md5(string_agg(email, ',' ORDER BY id)), '') FROM u
UNION ALL SELECT 'hash_checksum|' || coalesce(md5(string_agg(password_hash, '' ORDER BY id)), '') FROM u
UNION ALL SELECT 'credentials|' || count(password_hash) FROM u
UNION ALL SELECT 'system_domain_rows|' || count(*) FROM u WHERE email LIKE '%@system.ansari.chat';
COMMIT;
