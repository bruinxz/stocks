BEGIN;

DO $preflight$
DECLARE
  expected_marker CONSTANT TEXT :=
    'migration:2026-07-11-sprint3-market-storage-phase1';
BEGIN
  IF obj_description('multibagger_text_hit'::regclass, 'pg_class')
     IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'multibagger text-hit rollback ownership mismatch';
  END IF;
END;
$preflight$;

DROP INDEX ix_multibagger_text_hit_fact_hash;

ALTER TABLE multibagger_text_hit
  DROP CONSTRAINT ck_multibagger_text_hit_fact_hash,
  DROP CONSTRAINT ck_multibagger_text_hit_source_version,
  DROP COLUMN hit_fact_hash,
  DROP COLUMN source_version;

COMMIT;
