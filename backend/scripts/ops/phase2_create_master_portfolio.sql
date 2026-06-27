-- Phase 2 — 综合策略主盘 (Codex综合主盘 20W)
--
-- 目标: 用户登录后只看到 1 个盘. 配置融合 DA-0 报告里 16 个 active 盘的最优策略.
-- DA-0 关键发现:
--   - 21 盘里 17 个共享同一 22 因子, 无独家因子优势 → 保留全部 22 因子作 ranking 输入
--   - 99 笔 5% 硬止损全亏 -11k 元, 而 4 笔 trailing_take_profit + 1 take_profit 净 +736
--     → 硬止损放宽 5→6, 硬止盈 10→12, 关键引入 trailing_stop_pct=4
--   - 综合 4 维评分 #29 (Codex均值回归 lym) 最佳, 但 #29 自己也 sharpe=-1.63
--     → 不基于 #29 改, 新建一个干净盘, 融合 10 个策略 (4 均值回归 + 4 动量 +
--       volume_price_confirmation + dragon_head_momentum)
--   - DA-0 弃用: multi_factor_alpha / breakout_* / turtle_* /
--     low_volatility_quality 等 (0 胜率)
--
-- owner: stock(user_id=4) — 这是 prod paper trading 实际跑的系统账号 (与
-- PaperTradingAutomationService cron 一致). lym(user_id=2) 作为副本无意义.
--
-- 使用 (生产, 由 phase2_run_consolidation.ts --apply 包裹):
--   psql 不可用 (ops/deploy 账号无权限) → 走 sequelize 节点脚本
--   node backend/dist/scripts/ops/phase2_run_consolidation.js --apply

BEGIN;

-- 1. 前置校验: 不能已存在同名盘 (幂等性保护)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM paper_trading_portfolios WHERE name = '综合策略主盘'
  ) THEN
    RAISE EXCEPTION '综合策略主盘 已存在, 拒绝重复创建 (改用 UPDATE 或先 DELETE)';
  END IF;
END $$;

-- 2. 插入综合主盘
INSERT INTO paper_trading_portfolios (
  user_id,
  name,
  description,
  initial_capital,
  current_cash,
  total_value,
  is_active,
  auto_trade_enabled,
  strategy_keys,
  enabled_factors,
  risk_profile_overrides,
  created_at,
  updated_at
) VALUES (
  4,
  '综合策略主盘',
  'Phase 2 (2026-06-27) 单盘整合 — 融合 16 个 active 盘的最优 10 策略 + 全 22 因子 + DA-0 数据驱动的风控升级 (trailing 4% + DD 熔断 3% + 止损放宽到 6%).',
  200000.00,
  200000.00,
  200000.00,
  true,
  true,
  -- DA-0 推荐 10 策略 (4 均值回归 + 4 动量 + 1 量价 + 1 龙头)
  '["bollinger_reversion","rsi_reversion","left_side_reversal","trend_pullback_reentry","dual_momentum_rotation","cta100_momentum","sector_rotation_leader","relative_strength_momentum","volume_price_confirmation","dragon_head_momentum"]'::jsonb,
  -- 全 22 因子 (DA-0 证实 17 盘共享同一集, 不裁剪)
  '["value","quality","quality_high","growth","momentum","momentum_reversal","low_vol","liquidity","money_flow","northbound","dragon_tiger","analyst_consensus","earnings_surprise","fund_consensus","industry_momentum","gradual_breakout","insider_trade","margin_flow","east_money_qa","shareholder_concentration","block_trade_signal","concept_heat"]'::jsonb,
  -- 风控覆盖 (DA-0 数据驱动)
  '{
    "stop_loss_percent": 6,
    "take_profit_percent": 12,
    "trailing_stop_pct": 4,
    "single_stock_max_weight": 0.10,
    "max_industry_weight": 0.30,
    "max_positions": 8,
    "drawdown_breaker": {
      "threshold_pct": 3,
      "cooldown_days": 2
    }
  }'::jsonb,
  NOW(),
  NOW()
);

-- 3. 显示新盘 id 供后续步骤使用
SELECT id, name, user_id, is_active, auto_trade_enabled,
       jsonb_array_length(strategy_keys) AS n_strategies,
       jsonb_array_length(enabled_factors) AS n_factors
FROM paper_trading_portfolios
WHERE name = '综合策略主盘'
ORDER BY id DESC
LIMIT 1;

COMMIT;
