-- Persist the exact classification policy provenance authenticated by the
-- multibagger candidate fact hash. No legacy row receives an invented value.

BEGIN;

DO $preflight$
DECLARE
  expected_marker CONSTANT TEXT :=
    'migration:2026-07-11-sprint3-market-storage-phase1';
BEGIN
  IF obj_description('multibagger_candidate_snapshot'::regclass, 'pg_class')
     IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'multibagger classification provenance ownership mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM multibagger_candidate_snapshot) THEN
    RAISE EXCEPTION
      'cannot add classification provenance while candidate rows exist';
  END IF;
END;
$preflight$;

ALTER TABLE multibagger_candidate_snapshot
  ADD COLUMN classification_policy_version TEXT NOT NULL,
  ADD COLUMN classification_reason_codes JSONB NOT NULL,
  ADD CONSTRAINT ck_multibagger_classification_reason_codes CHECK (
    CASE jsonb_typeof(classification_reason_codes)
      WHEN 'array' THEN
        jsonb_array_length(classification_reason_codes) > 0
        AND COALESCE(
          NOT jsonb_path_exists(
            classification_reason_codes,
            'strict $[*] ? (@.type() != "string" || @ == "")',
            '{}'::jsonb,
            TRUE
          ),
          FALSE
        )
      ELSE FALSE
    END
  );

COMMIT;
