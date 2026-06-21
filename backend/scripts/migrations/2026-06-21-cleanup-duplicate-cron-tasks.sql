-- AR-5 (2026-06-21): 清理 scheduled_tasks 中真重复的 type 行.
--
-- 背景: 11 个 type 在 active 集合里出现 2 行. 其中:
--
--   * 合法重复 (保留): EARNINGS_FORECAST_WATCH (held/watchlist 两模式) /
--     LIVE_RECONCILIATION_GUARD (intraday/eod 两 window) /
--     MARKET_NEWS_SYNC (盘中 / 收盘+prune) /
--     QUANT_DAILY_PIPELINE (open/close 两 session) /
--     PAPER_TRADING_DRAWDOWN_BREAKER_CHECK (评估 + 真卖) /
--     PAPER_TRADING_PER_STOCK_STOP_LOSS_CHECK (评估 + 真卖) /
--     PAPER_TRADING_TRAILING_STOP_CHECK (评估 + 真卖) — 已不算重复因为参数 mode 不同,
--     保留两个对应的 task row.
--
--   * 真重复 (本 migration 删除):
--     id=39 PAPER_TRADING_MARKET_REGIME_CHECK 旧 user_id=4 硬写
--           (id=54 已用 dry_run:false 覆盖盘中场景, 9:00 唯一一次)
--     id=40 PAPER_TRADING_TRAILING_STOP_UPDATE 旧 user_id=4 硬写
--           (id=51 已用 EOD 更新替代)
--     id=42 EQUITY_CURVE_GOVERNOR_DAILY_EVAL 旧 persist:true
--           (id=74 Batch AJ 已是 dry_run:false 标准版)
--     id=43 RESEARCH_INTEGRITY_BATCH_AUDIT 旧周度 since_days:7
--           (id=77 Batch AJ 已升级到每日, 7 天滚动窗已涵盖)
--
-- 不删 (虽然 type 重复但参数语义不同, 业务故意):
--   * id=48/49/50: paper_trading 评估版 — 与真卖版 (52/53/55) 在不同时间
--     做不同 action, 评估 task 不下单, 留作运维 dashboard 数据源.
--
-- 回滚: 见 -rollback.sql.

BEGIN;

DELETE FROM scheduled_tasks WHERE id = 39 AND type = 'PAPER_TRADING_MARKET_REGIME_CHECK';
DELETE FROM scheduled_tasks WHERE id = 40 AND type = 'PAPER_TRADING_TRAILING_STOP_UPDATE';
DELETE FROM scheduled_tasks WHERE id = 42 AND type = 'EQUITY_CURVE_GOVERNOR_DAILY_EVAL';
DELETE FROM scheduled_tasks WHERE id = 43 AND type = 'RESEARCH_INTEGRITY_BATCH_AUDIT';

COMMIT;
