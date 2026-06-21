-- AL-3 2026-06-21 — paper_trading_trades 增加 trade_reason JSONB + trade_reason_summary (up).
--
-- 用户原话: "当你买入卖出的时候，你需要额外补充上原因，你是怎么判断的要进行这个操作的。"
--
-- 现在 6+ 处写 paper_trading_trades (facade BUY/SELL × 2, automation
-- createBuyTrade / createSellTrade × 2, GuardSellExecutor → facade 透传) 都只
-- 写 symbol/price/qty/amount/commission, 没人记录"为什么这笔交易发生".
-- UI 列表 / 周报 / 复盘 全部看到空 ("一堆 trade 不知道哪一笔是哪个策略 / 哪个 guard 触发的").
--
-- 字段语义:
--   - trade_reason JSONB — 默认 '{}'::jsonb (NOT NULL). 结构 (与 TradeReason TS 类型对齐):
--       {
--         source: 'manual' | 'auto_buy_from_signals' | 'analysis_engine_hard' |
--                 'rebalance' | 'trailing_stop' | 'drawdown_breaker' |
--                 'industry_concentration' | 'per_stock_stop_loss' | 'black_swan' |
--                 'restricted_share' | 'market_regime_alert' | 'kill_switch' |
--                 'close_position' | 'unknown',
--         strategy_key?: string,
--         signal_id?: number,
--         ai_report_id?: string,
--         evidence: Array<{ label: string; detail?: string; weight?: number }>,
--         confidence?: number,
--         key_reasons: string[],
--         risk_trigger?: { type: string; threshold?: number; actual?: number },
--         ai_summary?: string
--       }
--   - trade_reason_summary TEXT — 一句话总结, UI 列表 / 周报展示, 详情看 JSONB.
--
-- 索引:
--   - (trade_reason->>'source') — 按来源筛 (例如周报"本周自动跟单 12 笔 / 风控强平 3 笔")
--
-- 默认值 (fail-safe):
--   - trade_reason 默认 '{}'::jsonb → 历史 trade ALTER 后是空 obj, UI 显示 "—" 即可
--   - trade_reason_summary 默认 NULL → 历史 trade UI 显示 "—"
--
-- 回滚: 2026-06-21-paper-trading-trade-reason-rollback.sql
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-21-paper-trading-trade-reason.sql

BEGIN;

ALTER TABLE paper_trading_trades
  ADD COLUMN IF NOT EXISTS trade_reason JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE paper_trading_trades
  ADD COLUMN IF NOT EXISTS trade_reason_summary TEXT;

COMMENT ON COLUMN paper_trading_trades.trade_reason IS
  'AL-3 (2026-06-21): 操作理由 JSONB { source, strategy_key?, signal_id?, ai_report_id?, evidence[], confidence?, key_reasons[], risk_trigger?, ai_summary? }';

COMMENT ON COLUMN paper_trading_trades.trade_reason_summary IS
  'AL-3 (2026-06-21): 一句话总结 (UI 列表展示, 详情看 trade_reason JSONB)';

CREATE INDEX IF NOT EXISTS idx_paper_trading_trades_reason_source
  ON paper_trading_trades((trade_reason->>'source'));

COMMIT;
