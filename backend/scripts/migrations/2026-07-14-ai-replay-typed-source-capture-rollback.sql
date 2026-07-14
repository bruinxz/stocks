-- Ownership-safe rollback for the immutable typed replay source boundary.

BEGIN;

DO $ownership$
DECLARE
  expected_marker CONSTANT TEXT :=
    'migration:2026-07-14-ai-replay-typed-source-capture';
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
  WHERE n.nspname = current_schema()
    AND p.proname = 'reject_ai_replay_typed_source_capture_mutation'
    AND pg_get_function_identity_arguments(p.oid) = '';

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
    AND t.tgfoid = function_oid;

  IF trigger_oid IS NULL
     OR obj_description(trigger_oid, 'pg_trigger') IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'typed source capture rollback trigger ownership mismatch';
  END IF;
END;
$ownership$;

DROP TABLE ai_replay_typed_source_capture;
DROP FUNCTION reject_ai_replay_typed_source_capture_mutation();

COMMIT;
