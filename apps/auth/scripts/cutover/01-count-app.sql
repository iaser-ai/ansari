-- 01-count — the number of rows 01-export-app.sql exports, from the APP
-- database. READ-ONLY. copy.sh passes it to 02 as `expected_rows`, so a
-- stream cut short is refused. The filter must stay 01's (a test pins it).
SELECT count(*) FROM public.users WHERE system_key IS NULL;
