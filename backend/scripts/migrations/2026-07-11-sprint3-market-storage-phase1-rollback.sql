-- Sprint 3 Phase 1 rollback. Drop children before parents and indexes before tables.

BEGIN;

DROP INDEX IF EXISTS ix_pit_holding_ticker;
DROP INDEX IF EXISTS ix_pit_holding_snapshot;
DROP TABLE IF EXISTS backtest_pit_holding;

DROP INDEX IF EXISTS ix_pit_snapshot_day;
DROP INDEX IF EXISTS ix_pit_strategy_as_of;
DROP TABLE IF EXISTS backtest_pit_snapshot;

DROP INDEX IF EXISTS ix_multibagger_candidate_filters;
DROP INDEX IF EXISTS ix_multibagger_candidate_as_of;
DROP TABLE IF EXISTS multibagger_candidate_snapshot;

DROP INDEX IF EXISTS ix_multibagger_text_hit_source;
DROP INDEX IF EXISTS ix_multibagger_text_hit_ticker;
DROP TABLE IF EXISTS multibagger_text_hit;

DROP INDEX IF EXISTS ix_multibagger_source_kind;
DROP INDEX IF EXISTS ix_multibagger_ticker;
DROP INDEX IF EXISTS ix_multibagger_as_of;
DROP TABLE IF EXISTS multibagger_universe;

DROP INDEX IF EXISTS ix_jpkr_fx_pit;
DROP INDEX IF EXISTS ix_jpkr_fx_pair_day;
DROP TABLE IF EXISTS jpkr_fx_observation;

DROP INDEX IF EXISTS ix_jpkr_financial_pit;
DROP INDEX IF EXISTS ix_jpkr_financial_ticker_period;
DROP TABLE IF EXISTS jpkr_financial_snapshot;

DROP INDEX IF EXISTS ix_jpkr_disclosure_pit;
DROP INDEX IF EXISTS ix_jpkr_disclosure_ticker_time;
DROP TABLE IF EXISTS jpkr_disclosure_event;

DROP INDEX IF EXISTS ix_jpkr_kline_pit;
DROP INDEX IF EXISTS ix_jpkr_kline_ticker_day;
DROP INDEX IF EXISTS ix_jpkr_kline_exchange_day;
DROP TABLE IF EXISTS jpkr_daily_kline;

DROP INDEX IF EXISTS ix_jpkr_security_active;
DROP INDEX IF EXISTS ix_jpkr_security_lookup;
DROP TABLE IF EXISTS jpkr_security_master;

COMMIT;
