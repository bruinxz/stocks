-- Make the DataPipeline TextHit fact lossless and independently authenticated.
-- Existing rows are rejected because source_version cannot be reconstructed.

BEGIN;

DO $preflight$
DECLARE
  expected_marker CONSTANT TEXT :=
    'migration:2026-07-11-sprint3-market-storage-phase1';
BEGIN
  IF obj_description('multibagger_text_hit'::regclass, 'pg_class')
     IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'multibagger text-hit provenance ownership mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM multibagger_text_hit) THEN
    RAISE EXCEPTION
      'cannot add text-hit provenance while legacy rows exist';
  END IF;
END;
$preflight$;

ALTER TABLE multibagger_text_hit
  ADD COLUMN source_version TEXT NOT NULL,
  ADD COLUMN hit_fact_hash TEXT NOT NULL,
  ADD CONSTRAINT ck_multibagger_text_hit_source_version CHECK (
    source_version COLLATE "C" ~ '^[!-~]+$'
  ),
  ADD CONSTRAINT ck_multibagger_text_hit_fact_hash CHECK (
    hit_fact_hash ~ '^[0-9a-f]{64}$'
  );

CREATE INDEX ix_multibagger_text_hit_fact_hash
  ON multibagger_text_hit (hit_fact_hash);

COMMIT;
