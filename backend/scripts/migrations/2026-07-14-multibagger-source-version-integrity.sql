-- Enforce the printable-ASCII source-version contract at the physical
-- multibagger source and Strategy-candidate boundaries.

BEGIN;

DO $preflight$
DECLARE
  phase1_marker CONSTANT TEXT :=
    'migration:2026-07-11-sprint3-market-storage-phase1';
  universe_oid OID;
  candidate_oid OID;
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
    RAISE EXCEPTION 'multibagger universe phase1 ownership mismatch';
  END IF;
  IF candidate_oid IS NULL
     OR obj_description(candidate_oid, 'pg_class') IS DISTINCT FROM phase1_marker THEN
    RAISE EXCEPTION 'multibagger candidate phase1 ownership mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE (c.conrelid = universe_oid
           AND c.conname = 'ck_multibagger_universe_source_version_ascii')
       OR (c.conrelid = candidate_oid
           AND c.conname = 'ck_multibagger_candidate_score_source_versions')
  ) THEN
    RAISE EXCEPTION 'multibagger source-version constraint name collision';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM multibagger_universe
    WHERE NOT (source_version COLLATE "C" ~ '^[!-~]+$')
  ) THEN
    RAISE EXCEPTION 'legacy multibagger universe source_version is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM multibagger_candidate_snapshot
    WHERE NOT (
      CASE
        WHEN score IS NULL THEN TRUE
        WHEN jsonb_typeof(score) <> 'object' THEN FALSE
        WHEN jsonb_typeof(score->'source_versions') <> 'object' THEN FALSE
        ELSE COALESCE(
          (score->'source_versions') ?& ARRAY[
            'quality_engine',
            'growth_engine',
            'valuation_engine',
            'moat_engine',
            'trend_engine',
            'risk_engine'
          ]
          AND ((score->'source_versions')
            - 'quality_engine'
            - 'growth_engine'
            - 'valuation_engine'
            - 'moat_engine'
            - 'trend_engine'
            - 'risk_engine') = '{}'::JSONB
          AND jsonb_typeof(score->'source_versions'->'quality_engine') = 'string'
          AND (score->'source_versions'->>'quality_engine') COLLATE "C" ~ '^[!-~]+$'
          AND jsonb_typeof(score->'source_versions'->'growth_engine') = 'string'
          AND (score->'source_versions'->>'growth_engine') COLLATE "C" ~ '^[!-~]+$'
          AND jsonb_typeof(score->'source_versions'->'valuation_engine') = 'string'
          AND (score->'source_versions'->>'valuation_engine') COLLATE "C" ~ '^[!-~]+$'
          AND jsonb_typeof(score->'source_versions'->'moat_engine') = 'string'
          AND (score->'source_versions'->>'moat_engine') COLLATE "C" ~ '^[!-~]+$'
          AND jsonb_typeof(score->'source_versions'->'trend_engine') = 'string'
          AND (score->'source_versions'->>'trend_engine') COLLATE "C" ~ '^[!-~]+$'
          AND jsonb_typeof(score->'source_versions'->'risk_engine') = 'string'
          AND (score->'source_versions'->>'risk_engine') COLLATE "C" ~ '^[!-~]+$',
          FALSE
        )
      END
    )
  ) THEN
    RAISE EXCEPTION 'legacy multibagger candidate score.source_versions is invalid';
  END IF;
END;
$preflight$;

ALTER TABLE multibagger_universe
  ADD CONSTRAINT ck_multibagger_universe_source_version_ascii CHECK (
    source_version COLLATE "C" ~ '^[!-~]+$'
  );

ALTER TABLE multibagger_candidate_snapshot
  ADD CONSTRAINT ck_multibagger_candidate_score_source_versions CHECK (
    CASE
      WHEN score IS NULL THEN TRUE
      WHEN jsonb_typeof(score) <> 'object' THEN FALSE
      WHEN jsonb_typeof(score->'source_versions') <> 'object' THEN FALSE
      ELSE COALESCE(
        (score->'source_versions') ?& ARRAY[
          'quality_engine',
          'growth_engine',
          'valuation_engine',
          'moat_engine',
          'trend_engine',
          'risk_engine'
        ]
        AND ((score->'source_versions')
          - 'quality_engine'
          - 'growth_engine'
          - 'valuation_engine'
          - 'moat_engine'
          - 'trend_engine'
          - 'risk_engine') = '{}'::JSONB
        AND jsonb_typeof(score->'source_versions'->'quality_engine') = 'string'
        AND (score->'source_versions'->>'quality_engine') COLLATE "C" ~ '^[!-~]+$'
        AND jsonb_typeof(score->'source_versions'->'growth_engine') = 'string'
        AND (score->'source_versions'->>'growth_engine') COLLATE "C" ~ '^[!-~]+$'
        AND jsonb_typeof(score->'source_versions'->'valuation_engine') = 'string'
        AND (score->'source_versions'->>'valuation_engine') COLLATE "C" ~ '^[!-~]+$'
        AND jsonb_typeof(score->'source_versions'->'moat_engine') = 'string'
        AND (score->'source_versions'->>'moat_engine') COLLATE "C" ~ '^[!-~]+$'
        AND jsonb_typeof(score->'source_versions'->'trend_engine') = 'string'
        AND (score->'source_versions'->>'trend_engine') COLLATE "C" ~ '^[!-~]+$'
        AND jsonb_typeof(score->'source_versions'->'risk_engine') = 'string'
        AND (score->'source_versions'->>'risk_engine') COLLATE "C" ~ '^[!-~]+$',
        FALSE
      )
    END
  );

COMMENT ON CONSTRAINT ck_multibagger_universe_source_version_ascii
  ON multibagger_universe IS
  'migration:2026-07-14-multibagger-source-version-integrity';
COMMENT ON CONSTRAINT ck_multibagger_candidate_score_source_versions
  ON multibagger_candidate_snapshot IS
  'migration:2026-07-14-multibagger-source-version-integrity';

COMMIT;
