-- Rollback (2026-07-09): 删除 trading_calendar 表 · §D4.G2 Migration 反向
-- 触发条件: 契约变更或采集器故障需回滚。
-- 注意: 若 §D4.1 α 降级已切用 trading_calendar 需先切回日历日近似再回滚。
-- 幂等: IF EXISTS · 重复执行安全。

DROP INDEX IF EXISTS idx_trading_calendar_is_half;
DROP INDEX IF EXISTS idx_trading_calendar_is_open;
DROP TABLE IF EXISTS trading_calendar;
