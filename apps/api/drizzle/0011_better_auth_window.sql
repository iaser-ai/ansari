-- Spec 300: the app-database window migration, applied in the offline cutover
-- window after the cross-database copy and its audits pass. It does exactly
-- two things, and nothing else:
--   1. normalize users.email to lower(trim(email)), the same normalization the
--      copy into auth.users uses, so both databases hold the same address;
--   2. drop NOT NULL from users.password_hash (credentials now live in
--      apps/auth; new app rows carry no hash).
-- Both are backward-compatible with the legacy apps/api code. The foreign
-- keys from threads, preferences and feedback to users are not touched.
--
-- GUARD: abort if any two rows collide on lower(trim(email)). The owner
-- decides every collision before the window (the pre-window audit lists each
-- pair), so in the window this guard finds none. The error names no address.
--
-- ONE statement, so the guard, the update and the ALTER are atomic under
-- `psql -f` (RELEASE.md), which autocommits each statement and does not stop
-- on error by default.
DO $$
DECLARE
  collisions bigint;
BEGIN
  SELECT count(*) INTO collisions FROM (
    SELECT lower(trim(email)) FROM public.users GROUP BY 1 HAVING count(*) > 1
  ) colliding;
  IF collisions > 0 THEN
    RAISE EXCEPTION '% normalized email(s) are held by more than one users row; resolve them before the window', collisions;
  END IF;

  UPDATE public.users SET email = lower(trim(email)) WHERE email <> lower(trim(email));

  ALTER TABLE public.users ALTER COLUMN password_hash DROP NOT NULL;
END $$;
