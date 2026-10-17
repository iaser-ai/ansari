-- 02 — import into the AUTH database, as ONE psql session reading the rows
-- 01 writes, from psql's standard input (copy.sh is the pipe).
--
-- The import table is TEMP: it lives only in this session, so every failure
-- path (a guard, a constraint, a dropped pipe) leaves no copy of the hashes
-- behind. The inserts run in one transaction; a failed guard changes nothing.
\set ON_ERROR_STOP on

-- copy.sh passes `-v expected_rows=<n>`, the app's count of the rows 01
-- exports, taken just before the pipe. A pipe that drops mid-stream ends the
-- \copy at an EOF that looks like end-of-data; this count is what refuses the
-- subset.
\if :{?expected_rows}
\else
DO $$ BEGIN RAISE EXCEPTION 'cutover copy: expected_rows is not set; run the copy through copy.sh'; END $$;
\endif
CREATE TEMP TABLE import_expected (n bigint NOT NULL) ON COMMIT PRESERVE ROWS;
INSERT INTO import_expected VALUES (:'expected_rows'::bigint);

CREATE TEMP TABLE import_users (
  id uuid NOT NULL,
  email text NOT NULL,
  first_name text,
  last_name text,
  password_hash text,
  registered_via text,
  created_at timestamptz,
  updated_at timestamptz
) ON COMMIT PRESERVE ROWS;

\copy import_users FROM pstdin

BEGIN;

-- Guards. Each aborts the whole transaction, naming a count, never an address.
DO $$
DECLARE
  n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users) THEN
    RAISE EXCEPTION 'cutover copy: auth.users is not empty; empty the auth database and re-run from the 0000 baseline';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.account) THEN
    RAISE EXCEPTION 'cutover copy: auth.account is not empty; empty the auth database and re-run from the 0000 baseline';
  END IF;
  SELECT count(*) INTO n FROM import_users;
  IF n = 0 THEN
    RAISE EXCEPTION 'cutover copy: the import is empty (did the export run?)';
  END IF;
  IF n <> (SELECT e.n FROM import_expected e) THEN
    RAISE EXCEPTION 'cutover copy: the import holds % row(s), but the app counted % to copy (a dropped pipe?)', n, (SELECT e.n FROM import_expected e);
  END IF;
  SELECT count(*) INTO n FROM (
    SELECT email FROM import_users GROUP BY email HAVING count(*) > 1
  ) dup;
  IF n > 0 THEN
    RAISE EXCEPTION 'cutover copy: % normalized email(s) are held by more than one row; resolve them (00-preflight-app.sql lists the ids)', n;
  END IF;
  SELECT count(*) INTO n FROM import_users WHERE email <> lower(trim(email));
  IF n > 0 THEN
    RAISE EXCEPTION 'cutover copy: % email(s) arrived not normalized', n;
  END IF;
  SELECT count(*) INTO n FROM import_users WHERE password_hash IS NULL OR password_hash = '';
  IF n > 0 THEN
    RAISE EXCEPTION 'cutover copy: % row(s) have no password hash', n;
  END IF;
  -- apps/auth reads a hash as bcrypt only by its $2a$/$2b$ prefix
  -- (packages/auth/src/password.ts); anything else would go to scrypt and
  -- that user could never sign in. The legacy service wrote bcrypt only.
  SELECT count(*) INTO n FROM import_users
  WHERE password_hash !~ '^\$2[ab]\$' OR length(password_hash) <> 60;
  IF n > 0 THEN
    RAISE EXCEPTION 'cutover copy: % row(s) have a hash that is not bcrypt $2a$/$2b$ of length 60; they could not sign in (00-preflight-app.sql shows the formats)', n;
  END IF;
  SELECT count(*) INTO n FROM import_users WHERE created_at IS NULL OR updated_at IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'cutover copy: % row(s) have a NULL created_at or updated_at; timestamps are copied exactly, so decide each before the window (00-preflight-app.sql counts them)', n;
  END IF;
  SELECT count(*) INTO n FROM import_users WHERE email LIKE '%@system.ansari.chat';
  IF n > 0 THEN
    RAISE EXCEPTION 'cutover copy: % row(s) use the reserved system domain', n;
  END IF;
END
$$;

-- Users: the same id; the name better-auth requires, by the rule in
-- packages/auth/src/name.ts (trim(first || ' ' || last), else the email's
-- local part, else 'User'); email_verified = true by decision (migrated users
-- are treated as verified; no verification email is ever sent to them);
-- role 'user' (admins are granted by grant-admin.ts, runbook step 8).
INSERT INTO auth.users (
  id, name, email, email_verified, created_at, updated_at,
  role, banned, first_name, last_name, registered_via
)
SELECT
  i.id,
  COALESCE(
    NULLIF(btrim(coalesce(i.first_name, '') || ' ' || coalesce(i.last_name, ''), E' \t\n\r\f\v'), ''),
    NULLIF(btrim(split_part(i.email, '@', 1), E' \t\n\r\f\v'), ''),
    'User'
  ),
  i.email,
  true,
  i.created_at,
  i.updated_at,
  'user',
  false,
  i.first_name,
  i.last_name,
  i.registered_via
FROM import_users i;

-- One credential account per user, carrying the legacy hash (bcrypt or
-- scrypt; apps/auth verifies both). Re-runnable on its own: the unique
-- (user_id, provider_id) makes a second credential for a user a no-op.
INSERT INTO auth.account (id, account_id, provider_id, user_id, password, created_at, updated_at)
SELECT
  gen_random_uuid(),
  i.id::text,
  'credential',
  i.id,
  i.password_hash,
  i.created_at,
  i.updated_at
FROM import_users i
ON CONFLICT (user_id, provider_id) DO NOTHING;

COMMIT;

DROP TABLE import_users;
DROP TABLE import_expected;
\echo 'cutover copy: committed'
