-- 上线部署 (2026-07-03): 补齐 ai_investment_signals 的 §2.2 Signal atom 列
-- 背景: Signal-First 重构 (批5/批6) 给 AIInvestmentSignal model 新增了 14 个 "Signal atom" 列
--       (action / confidence / lifecycle_id / theme_id / rebalance_id / target_pct /
--        expected_value / recommended_size_pct / entry_price_strategy / stop_loss_pct /
--        take_profit_pct / cooldown_until / gate_pass / gate_reason)。
--       生产库 ai_investment_signals 表在 DB 清洗后是存量结构, 缺这些列; 且生产不跑
--       sequelize.sync (仅 development)。ETFRotationService.persistSignal findOrCreate 时
--       SELECT 引用 action 列 → "column action does not exist" → 月度再平衡无法落 Core 信号。
-- 本脚本: 幂等补齐这 14 列, 类型与 model @Column 定义一一对应。
-- 幂等: ADD COLUMN IF NOT EXISTS, 重复执行安全。生产 / staging / DR 重建后均可跑。

ALTER TABLE ai_investment_signals
  ADD COLUMN IF NOT EXISTS action varchar(20),
  ADD COLUMN IF NOT EXISTS confidence numeric(5,4),
  ADD COLUMN IF NOT EXISTS lifecycle_id varchar(80),
  ADD COLUMN IF NOT EXISTS theme_id varchar(80),
  ADD COLUMN IF NOT EXISTS rebalance_id varchar(40),
  ADD COLUMN IF NOT EXISTS target_pct numeric(6,2),
  ADD COLUMN IF NOT EXISTS expected_value numeric(10,4),
  ADD COLUMN IF NOT EXISTS recommended_size_pct numeric(6,2),
  ADD COLUMN IF NOT EXISTS entry_price_strategy varchar(20),
  ADD COLUMN IF NOT EXISTS stop_loss_pct numeric(6,2),
  ADD COLUMN IF NOT EXISTS take_profit_pct numeric(6,2),
  ADD COLUMN IF NOT EXISTS cooldown_until timestamptz,
  ADD COLUMN IF NOT EXISTS gate_pass boolean,
  ADD COLUMN IF NOT EXISTS gate_reason text;
