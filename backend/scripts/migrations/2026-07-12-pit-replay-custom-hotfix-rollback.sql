-- Roll back only the custom replay restriction; table ownership stays unchanged.

BEGIN;

DO $preflight$
DECLARE
  expected_marker CONSTANT TEXT :=
    'migration:2026-07-11-sprint3-market-storage-phase1';
BEGIN
  IF obj_description('backtest_pit_snapshot'::regclass, 'pg_class')
     IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'PIT replay hotfix rollback ownership mismatch';
  END IF;
END;
$preflight$;

ALTER TABLE backtest_pit_snapshot
  DROP CONSTRAINT ck_backtest_pit_strategy,
  DROP CONSTRAINT ck_backtest_pit_profile_scope,
  ADD CONSTRAINT backtest_pit_snapshot_strategy_check CHECK (strategy IN (
    'us_preferred',
    'multibagger',
    'custom',
    'japan_blue_chip',
    'japan_multibagger',
    'korea_semiconductor_chain',
    'korea_multibagger'
  )),
  ADD CONSTRAINT ck_backtest_pit_profile_scope CHECK (
    (strategy IN ('us_preferred', 'multibagger', 'custom')
      AND market_scope IN ('cn_a', 'us'))
    OR (strategy IN ('japan_blue_chip', 'japan_multibagger')
      AND market_scope = 'jp')
    OR (strategy IN ('korea_semiconductor_chain', 'korea_multibagger')
      AND market_scope = 'kr')
  );

COMMIT;
