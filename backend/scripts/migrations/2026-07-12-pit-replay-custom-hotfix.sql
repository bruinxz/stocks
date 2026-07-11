-- P0 follow-up: custom is not replayable until exact weights are persisted.
-- Score.WeightsProfile custom remains valid outside backtest_pit_snapshot.

BEGIN;

DO $preflight$
DECLARE
  expected_marker CONSTANT TEXT :=
    'migration:2026-07-11-sprint3-market-storage-phase1';
BEGIN
  IF obj_description('backtest_pit_snapshot'::regclass, 'pg_class')
     IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'PIT replay hotfix ownership mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM backtest_pit_snapshot WHERE strategy = 'custom'
  ) THEN
    RAISE EXCEPTION
      'PIT replay hotfix cannot remove custom while custom snapshots exist';
  END IF;
END;
$preflight$;

ALTER TABLE backtest_pit_snapshot
  DROP CONSTRAINT backtest_pit_snapshot_strategy_check,
  DROP CONSTRAINT ck_backtest_pit_profile_scope,
  ADD CONSTRAINT ck_backtest_pit_strategy CHECK (strategy IN (
    'us_preferred',
    'multibagger',
    'japan_blue_chip',
    'japan_multibagger',
    'korea_semiconductor_chain',
    'korea_multibagger'
  )),
  ADD CONSTRAINT ck_backtest_pit_profile_scope CHECK (
    (strategy IN ('us_preferred', 'multibagger')
      AND market_scope IN ('cn_a', 'us'))
    OR (strategy IN ('japan_blue_chip', 'japan_multibagger')
      AND market_scope = 'jp')
    OR (strategy IN ('korea_semiconductor_chain', 'korea_multibagger')
      AND market_scope = 'kr')
  );

COMMIT;
