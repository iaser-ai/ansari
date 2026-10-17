-- 00 — preflight on the APP database. READ-ONLY. Run before the window and again
-- at its start:
--   psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 00-preflight-app.sql
-- Prints ids, counts and admin addresses only; never a password hash.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

\echo '== Case audit: rows whose email is not lower(trim(email)) (all rows: 0011 normalizes every one; the copy normalizes the non-system ones)'
SELECT count(*) AS not_normalized,
       count(*) FILTER (WHERE system_key IS NOT NULL) AS of_which_system
FROM public.users
WHERE email <> lower(trim(email));

\echo '== Collisions: rows sharing a normalized email, system rows included (0011 ABORTS on any; the copy on any among non-system rows; decide each before the window)'
SELECT count(*) AS rows_in_group,
       array_agg(id ORDER BY created_at, id) AS ids,
       array_agg(coalesce(system_key, '-') ORDER BY created_at, id) AS system_keys
FROM public.users
GROUP BY lower(trim(email))
HAVING count(*) > 1
ORDER BY 1 DESC;

\echo '== Rows the copy cannot carry (no legacy password hash): must be zero'
SELECT count(*) AS no_password_hash
FROM public.users
WHERE system_key IS NULL AND password_hash IS NULL;

\echo '== Hash formats: prefix and length per non-system row, counts only, never a hash (apps/auth verifies bcrypt only as $2a$/$2b$; the copy ABORTS on any row that is not $2a$/$2b$ of length 60)'
SELECT substr(password_hash, 1, 4) AS prefix,
       length(password_hash) AS length,
       count(*) AS rows
FROM public.users
WHERE system_key IS NULL
GROUP BY 1, 2
ORDER BY 3 DESC, 1, 2;

\echo '== Rows whose hash is not bcrypt $2a$/$2b$ of length 60: must be zero (they could not sign in after the window)'
SELECT count(*) AS not_bcrypt
FROM public.users
WHERE system_key IS NULL
  AND (password_hash IS NULL OR password_hash !~ '^\$2[ab]\$' OR length(password_hash) <> 60);

\echo '== Rows with a NULL timestamp: must be zero (the copy aborts on any; it copies timestamps exactly)'
SELECT count(*) FILTER (WHERE created_at IS NULL) AS null_created_at,
       count(*) FILTER (WHERE updated_at IS NULL) AS null_updated_at
FROM public.users
WHERE system_key IS NULL;

\echo '== Guests by their exact shape: guest_ + 10 alphanumerics @askansari.ai or @ansari.chat, named Welcome Guest (informational; migrated as-is)'
SELECT count(*) AS guests
FROM public.users
WHERE system_key IS NULL
  AND lower(trim(email)) ~ '^guest_[a-z0-9]{10}@(askansari\.ai|ansari\.chat)$'
  AND first_name = 'Welcome' AND last_name = 'Guest';

\echo '== Legacy admin inventory (is_admin): compare with the owner-approved list'
SELECT id, lower(trim(email)) AS email
FROM public.users
WHERE is_admin
ORDER BY 2;

\echo '== System accounts (never copied)'
SELECT id, system_key
FROM public.users
WHERE system_key IS NOT NULL
ORDER BY system_key;

\echo '== Rows to copy'
SELECT count(*) AS to_copy FROM public.users WHERE system_key IS NULL;

\echo '== B-1: sign-ups per minute and per hour over 90 days (peak and p99), all and guest-shaped'
WITH rows AS (
  SELECT created_at,
         lower(trim(email)) ~ '^guest_[a-z0-9]{10}@(askansari\.ai|ansari\.chat)$'
           AND first_name = 'Welcome' AND last_name = 'Guest' AS guest
  FROM public.users
  WHERE system_key IS NULL AND created_at >= now() - interval '90 days'
),
per_minute AS (
  SELECT date_trunc('minute', created_at) AS t, count(*) AS n, count(*) FILTER (WHERE guest) AS g
  FROM rows GROUP BY 1
),
per_hour AS (
  SELECT date_trunc('hour', created_at) AS t, count(*) AS n, count(*) FILTER (WHERE guest) AS g
  FROM rows GROUP BY 1
)
SELECT 'minute' AS bucket,
       max(n) AS peak, percentile_disc(0.99) WITHIN GROUP (ORDER BY n) AS p99,
       max(g) AS guest_peak, percentile_disc(0.99) WITHIN GROUP (ORDER BY g) AS guest_p99
FROM per_minute
UNION ALL
SELECT 'hour', max(n), percentile_disc(0.99) WITHIN GROUP (ORDER BY n),
       max(g), percentile_disc(0.99) WITHIN GROUP (ORDER BY g)
FROM per_hour;

\echo '== B-4: sign-ins and refreshes per minute (legacy tokens rows, inside their retention)'
WITH per_minute AS (
  SELECT date_trunc('minute', created_at) AS t, count(*) AS n
  FROM public.tokens
  WHERE token_type IN ('access', 'refresh')
  GROUP BY 1
)
SELECT max(n) AS peak, percentile_disc(0.99) WITHIN GROUP (ORDER BY n) AS p99,
       min(t) AS oldest_minute, max(t) AS newest_minute
FROM per_minute;

COMMIT;
