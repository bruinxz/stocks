DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name ~ '[A-Z]'
    LOOP
        EXECUTE format('ALTER TABLE public.%I RENAME COLUMN %I TO %I',
                       r.table_name,
                       r.column_name,
                       lower(regexp_replace(r.column_name, '([A-Z])', '_\1', 'g')));
    END LOOP;
END $$;
