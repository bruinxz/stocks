-- 回滚: 移除 §2.2 Signal atom 列 (2026-07-03-signal-atom-columns.sql 的逆操作)
-- 警告: 若已有 ETF 轮动/卫星信号写入这些列, DROP 会丢数据。仅在确需回退 schema 时执行。

ALTER TABLE ai_investment_signals
  DROP COLUMN IF EXISTS action,
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS lifecycle_id,
  DROP COLUMN IF EXISTS theme_id,
  DROP COLUMN IF EXISTS rebalance_id,
  DROP COLUMN IF EXISTS target_pct,
  DROP COLUMN IF EXISTS expected_value,
  DROP COLUMN IF EXISTS recommended_size_pct,
  DROP COLUMN IF EXISTS entry_price_strategy,
  DROP COLUMN IF EXISTS stop_loss_pct,
  DROP COLUMN IF EXISTS take_profit_pct,
  DROP COLUMN IF EXISTS cooldown_until,
  DROP COLUMN IF EXISTS gate_pass,
  DROP COLUMN IF EXISTS gate_reason;
