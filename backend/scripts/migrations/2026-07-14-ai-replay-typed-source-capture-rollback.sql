-- Ownership-safe rollback for the immutable typed replay source boundary.

BEGIN;

DO $ownership$
DECLARE
  expected_marker CONSTANT TEXT :=
    'migration:2026-07-14-ai-replay-typed-source-capture';
  expected_function_body CONSTANT TEXT :=
    'BEGIN RAISE EXCEPTION USING ERRCODE = ''55000'', MESSAGE = ''ai_replay_typed_source_capture is append-only''; END;';
  table_oid OID;
  function_oid OID;
  trigger_oid OID;
BEGIN
  SELECT c.oid
    INTO table_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relkind = 'r'
    AND c.relname = 'ai_replay_typed_source_capture';

  IF table_oid IS NULL
     OR obj_description(table_oid, 'pg_class') IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'typed source capture rollback table ownership mismatch';
  END IF;

  SELECT p.oid
    INTO function_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = current_schema()
    AND p.proname = 'reject_ai_replay_typed_source_capture_mutation'
    AND pg_get_function_identity_arguments(p.oid) = ''
    AND p.prokind = 'f'
    AND p.prorettype = 'trigger'::regtype
    AND l.lanname = 'plpgsql'
    AND p.provolatile = 'v'
    AND p.proparallel = 'u'
    AND NOT p.prosecdef
    AND NOT p.proleakproof
    AND p.proconfig IS NULL
    AND BTRIM(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g'))
      = expected_function_body;

  IF function_oid IS NULL
     OR obj_description(function_oid, 'pg_proc') IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'typed source capture rollback function ownership mismatch';
  END IF;

  SELECT t.oid
    INTO trigger_oid
  FROM pg_trigger t
  WHERE t.tgrelid = table_oid
    AND t.tgname = 'tr_ai_replay_typed_source_capture_append_only'
    AND NOT t.tgisinternal
    AND t.tgfoid = function_oid
    -- BEFORE + DELETE + UPDATE + TRUNCATE, statement-level (no ROW bit).
    AND t.tgtype = 58
    AND t.tgenabled = 'O'
    AND t.tgnargs = 0
    AND t.tgqual IS NULL
    AND t.tgoldtable IS NULL
    AND t.tgnewtable IS NULL;

  IF trigger_oid IS NULL
     OR obj_description(trigger_oid, 'pg_trigger') IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'typed source capture rollback trigger ownership mismatch';
  END IF;
END;
$ownership$;

DROP TABLE ai_replay_typed_source_capture;
DROP FUNCTION reject_ai_replay_typed_source_capture_mutation();

COMMIT;
