-- Keep historical replay time separate from the actual ingestion timestamp.
-- available_at_utc remains the moment the row first entered this system; the
-- replay timestamp only certifies the market-information cutoff used by an
-- audited, reproducible historical recomputation.

ALTER TABLE factor_scores
  ADD COLUMN IF NOT EXISTS pit_replay_as_of_utc TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_factor_scores_pit_replay
  ON factor_scores (trade_date, pit_replay_as_of_utc, factor_name)
  WHERE pit_replay_as_of_utc IS NOT NULL;

COMMENT ON COLUMN factor_scores.pit_replay_as_of_utc IS
  'Historical information cutoff used by an audited PIT replay; NULL for ordinary live computations.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'ck_factor_scores_pit_replay_source'
       AND conrelid = 'factor_scores'::regclass
  ) THEN
    ALTER TABLE factor_scores
      ADD CONSTRAINT ck_factor_scores_pit_replay_source
      CHECK (
        pit_replay_as_of_utc IS NULL
        OR (
          source = 'historical_pit_replay@1.0.0'
          AND pit_replay_as_of_utc <= available_at_utc
          AND (pit_replay_as_of_utc AT TIME ZONE 'UTC')::date = trade_date
        )
      );
  END IF;
END $$;
