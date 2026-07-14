BEGIN;

DO $preflight$
DECLARE
  expected_marker CONSTANT TEXT :=
    'migration:2026-07-11-sprint3-market-storage-phase1';
BEGIN
  IF obj_description('multibagger_candidate_snapshot'::regclass, 'pg_class')
     IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'multibagger classification rollback ownership mismatch';
  END IF;
END;
$preflight$;

ALTER TABLE multibagger_candidate_snapshot
  DROP CONSTRAINT ck_multibagger_classification_reason_codes,
  DROP COLUMN classification_reason_codes,
  DROP COLUMN classification_policy_version;

COMMIT;
