-- Ownership-safe rollback for multibagger source-version integrity checks.

BEGIN;

DO $ownership$
DECLARE
  phase1_marker CONSTANT TEXT :=
    'migration:2026-07-11-sprint3-market-storage-phase1';
  integrity_marker CONSTANT TEXT :=
    'migration:2026-07-14-multibagger-source-version-integrity';
  universe_oid OID;
  candidate_oid OID;
  universe_constraint_oid OID;
  candidate_constraint_oid OID;
  universe_constraint_definition TEXT;
  candidate_constraint_definition TEXT;
  universe_constraint_validated BOOLEAN;
  candidate_constraint_validated BOOLEAN;
  universe_constraint_no_inherit BOOLEAN;
  candidate_constraint_no_inherit BOOLEAN;
  version_key TEXT;
BEGIN
  SELECT c.oid
    INTO universe_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relkind = 'r'
    AND c.relname = 'multibagger_universe';

  SELECT c.oid
    INTO candidate_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relkind = 'r'
    AND c.relname = 'multibagger_candidate_snapshot';

  IF universe_oid IS NULL
     OR obj_description(universe_oid, 'pg_class') IS DISTINCT FROM phase1_marker THEN
    RAISE EXCEPTION 'multibagger universe rollback table ownership mismatch';
  END IF;
  IF candidate_oid IS NULL
     OR obj_description(candidate_oid, 'pg_class') IS DISTINCT FROM phase1_marker THEN
    RAISE EXCEPTION 'multibagger candidate rollback table ownership mismatch';
  END IF;

  SELECT
    c.oid,
    pg_get_constraintdef(c.oid, TRUE),
    c.convalidated,
    c.connoinherit
    INTO
      universe_constraint_oid,
      universe_constraint_definition,
      universe_constraint_validated,
      universe_constraint_no_inherit
  FROM pg_constraint c
  WHERE c.conrelid = universe_oid
    AND c.contype = 'c'
    AND c.conname = 'ck_multibagger_universe_source_version_ascii';

  SELECT
    c.oid,
    pg_get_constraintdef(c.oid, TRUE),
    c.convalidated,
    c.connoinherit
    INTO
      candidate_constraint_oid,
      candidate_constraint_definition,
      candidate_constraint_validated,
      candidate_constraint_no_inherit
  FROM pg_constraint c
  WHERE c.conrelid = candidate_oid
    AND c.contype = 'c'
    AND c.conname = 'ck_multibagger_candidate_score_source_versions';

  IF universe_constraint_oid IS NULL
     OR obj_description(universe_constraint_oid, 'pg_constraint')
       IS DISTINCT FROM integrity_marker THEN
    RAISE EXCEPTION 'multibagger universe rollback constraint ownership mismatch';
  END IF;
  IF candidate_constraint_oid IS NULL
     OR obj_description(candidate_constraint_oid, 'pg_constraint')
       IS DISTINCT FROM integrity_marker THEN
    RAISE EXCEPTION 'multibagger candidate rollback constraint ownership mismatch';
  END IF;

  IF NOT COALESCE(universe_constraint_validated, FALSE)
     OR COALESCE(universe_constraint_no_inherit, TRUE)
     OR universe_constraint_definition NOT LIKE 'CHECK %'
     OR STRPOS(universe_constraint_definition, 'source_version') = 0
     OR STRPOS(universe_constraint_definition, 'COLLATE "C"') = 0
     OR STRPOS(universe_constraint_definition, '^[!-~]+$') = 0
     OR LENGTH(universe_constraint_definition)
          - LENGTH(REPLACE(
              universe_constraint_definition,
              '^[!-~]+$',
              ''
            )) <> LENGTH('^[!-~]+$') THEN
    RAISE EXCEPTION 'multibagger universe rollback constraint shape mismatch';
  END IF;

  IF NOT COALESCE(candidate_constraint_validated, FALSE)
     OR COALESCE(candidate_constraint_no_inherit, TRUE)
     OR candidate_constraint_definition NOT LIKE 'CHECK %'
     OR STRPOS(candidate_constraint_definition, 'score IS NULL') = 0
     OR STRPOS(candidate_constraint_definition, 'jsonb_typeof') = 0
     OR STRPOS(candidate_constraint_definition, 'source_versions') = 0
     OR STRPOS(candidate_constraint_definition, '?&') = 0
     OR STRPOS(candidate_constraint_definition, '= ''{}''::jsonb') = 0
     OR STRPOS(candidate_constraint_definition, 'COALESCE') = 0
     OR LENGTH(candidate_constraint_definition)
          - LENGTH(REPLACE(
              candidate_constraint_definition,
              '= ''string''',
              ''
            )) <> 6 * LENGTH('= ''string''')
     OR LENGTH(candidate_constraint_definition)
          - LENGTH(REPLACE(
              candidate_constraint_definition,
              'COLLATE "C"',
              ''
            )) <> 6 * LENGTH('COLLATE "C"')
     OR LENGTH(candidate_constraint_definition)
          - LENGTH(REPLACE(
              candidate_constraint_definition,
              '^[!-~]+$',
              ''
            )) <> 6 * LENGTH('^[!-~]+$') THEN
    RAISE EXCEPTION 'multibagger candidate rollback constraint shape mismatch';
  END IF;

  FOREACH version_key IN ARRAY ARRAY[
    'quality_engine',
    'growth_engine',
    'valuation_engine',
    'moat_engine',
    'trend_engine',
    'risk_engine'
  ] LOOP
    IF STRPOS(candidate_constraint_definition, QUOTE_LITERAL(version_key)) = 0 THEN
      RAISE EXCEPTION
        'multibagger candidate rollback constraint shape mismatch';
    END IF;
  END LOOP;
END;
$ownership$;

ALTER TABLE multibagger_universe
  DROP CONSTRAINT ck_multibagger_universe_source_version_ascii;
ALTER TABLE multibagger_candidate_snapshot
  DROP CONSTRAINT ck_multibagger_candidate_score_source_versions;

COMMIT;
