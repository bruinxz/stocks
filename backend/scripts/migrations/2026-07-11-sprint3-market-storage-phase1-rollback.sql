-- Sprint 3 Phase 1 rollback. Drop children before parents and indexes before tables.

BEGIN;

DO $ownership$
DECLARE
  expected_marker CONSTANT TEXT :=
    'migration:2026-07-11-sprint3-market-storage-phase1';
  owned_tables CONSTANT TEXT[] := ARRAY[
    'jpkr_security_master',
    'jpkr_daily_kline',
    'jpkr_disclosure_event',
    'jpkr_financial_snapshot',
    'jpkr_fx_observation',
    'multibagger_universe',
    'multibagger_text_hit',
    'multibagger_candidate_snapshot',
    'backtest_pit_snapshot',
    'backtest_pit_holding'
  ];
  existing_count INTEGER;
  matching_count INTEGER;
BEGIN
  SELECT COUNT(*),
         COUNT(*) FILTER (
           WHERE obj_description(c.oid, 'pg_class') = expected_marker
         )
    INTO existing_count, matching_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relkind = 'r'
    AND c.relname = ANY(owned_tables);

  IF existing_count = 0 THEN
    RAISE EXCEPTION 'Sprint 3 rollback ownership mismatch: no owned tables exist';
  END IF;

  IF existing_count <> cardinality(owned_tables)
     OR matching_count <> cardinality(owned_tables) THEN
    RAISE EXCEPTION
      'Sprint 3 rollback ownership mismatch: existing=%, matching=%, expected=%',
      existing_count, matching_count, cardinality(owned_tables);
  END IF;
END;
$ownership$;

DROP TABLE IF EXISTS backtest_pit_holding;

DROP TABLE IF EXISTS backtest_pit_snapshot;

DROP TABLE IF EXISTS multibagger_candidate_snapshot;

DROP TABLE IF EXISTS multibagger_text_hit;

DROP TABLE IF EXISTS multibagger_universe;

DROP TABLE IF EXISTS jpkr_fx_observation;

DROP TABLE IF EXISTS jpkr_financial_snapshot;

DROP TABLE IF EXISTS jpkr_disclosure_event;

DROP TABLE IF EXISTS jpkr_daily_kline;

DROP TABLE IF EXISTS jpkr_security_master;

COMMIT;
