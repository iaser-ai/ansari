-- Spec 300: drop the Better Auth scaffold tables (#59) from the app database.
--
-- The #59 scaffold put singular, text-id tables (user, session, account,
-- verification) in `public`. Better Auth now lives in its own database under
-- the `auth` schema, so any scaffold copy here is dead weight. Whether these
-- tables exist on staging/production at all is an owner `psql \dt` question;
-- on a database without them this migration is a no-op, and it is kept even
-- then because the guard documents the assumption.
--
-- GUARD: the scaffold was never used in production, so every scaffold table
-- must be empty. If any of them holds a row, the whole statement aborts and
-- nothing is dropped. The guard and the drops are ONE statement so they stay
-- atomic under `psql -f` (RELEASE.md), which autocommits each statement and
-- does not stop on error by default. No CASCADE: an unexpected dependent
-- object makes the drop fail loudly instead of disappearing with it.
DO $$
DECLARE
  scaffold text;
  has_rows boolean;
BEGIN
  FOREACH scaffold IN ARRAY ARRAY['user', 'session', 'account', 'verification'] LOOP
    IF to_regclass(format('public.%I', scaffold)) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', scaffold) INTO has_rows;
      IF has_rows THEN
        RAISE EXCEPTION 'scaffold table public.% holds rows; refusing to drop the #59 scaffold', scaffold;
      END IF;
    END IF;
  END LOOP;

  DROP TABLE IF EXISTS public."session", public."account", public."verification", public."user";
END $$;
