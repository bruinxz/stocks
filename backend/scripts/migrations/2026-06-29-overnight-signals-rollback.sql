-- PR-M1 (2026-06-29) — 创建 overnight_signals (隔夜信号矩阵) (rollback).

BEGIN;

DROP INDEX IF EXISTS idx_overnight_signals_collected_desc;
DROP INDEX IF EXISTS uq_overnight_signals_type_collected;
DROP TABLE IF EXISTS overnight_signals;

COMMIT;
