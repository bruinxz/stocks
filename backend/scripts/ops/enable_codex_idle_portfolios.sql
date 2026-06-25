-- CB-4 (2026/06/25) — 启用 4 个闲置 Codex 模拟盘并配置策略
--
-- 现状 (prod): pid=61/62/63/64 auto_trade_enabled=false, strategy_keys=[],
-- 4 个组合都是空仓闲置.
--
-- 用户决策: "启用并配置合适策略"
--
-- 策略配置:
--   pid=61 (user=4) Codex自主荐股        → ['multi_factor_alpha']
--   pid=62 (user=4) Codex量化Agent融合   → ['multi_factor_alpha', 'dragon_head_momentum', 'breakout_strategy']
--   pid=63 (user=4) Codex Agent独立      → ['multi_factor_alpha']
--   pid=64 (user=2) Codex自主荐股        → ['multi_factor_alpha']
--
-- 注: AC 原指定 'ai_advisor_signals' 不是合法 strategy_key (查 backend/src/quant/strategies/
-- 所有 *.ts: 无此 key). 改用 'multi_factor_alpha' 作 AI 推荐兜底
-- (MultiFactorAlphaStrategy 是项目主力 12 因子 multi-factor strategy, 与
-- AIAdvisorService 配合输出"AI 推荐"语义最接近).
--
-- 使用 (生产):
--   psql $DATABASE_URL -f backend/scripts/ops/enable_codex_idle_portfolios.sql

BEGIN;

-- 1. dry-run: 校验 4 行存在 + 当前 auto_trade=false / strategy_keys=[]
\echo '[CB-4] BEFORE update — 现状校验'
SELECT id, user_id, name, auto_trade_enabled, strategy_keys
FROM paper_trading_portfolios
WHERE id IN (61, 62, 63, 64)
ORDER BY id;

-- 2. UPDATE 4 行
UPDATE paper_trading_portfolios SET
  auto_trade_enabled = true,
  strategy_keys = '["multi_factor_alpha"]'::jsonb
WHERE id = 61;

UPDATE paper_trading_portfolios SET
  auto_trade_enabled = true,
  strategy_keys = '["multi_factor_alpha", "dragon_head_momentum", "breakout_strategy"]'::jsonb
WHERE id = 62;

UPDATE paper_trading_portfolios SET
  auto_trade_enabled = true,
  strategy_keys = '["multi_factor_alpha"]'::jsonb
WHERE id = 63;

UPDATE paper_trading_portfolios SET
  auto_trade_enabled = true,
  strategy_keys = '["multi_factor_alpha"]'::jsonb
WHERE id = 64;

-- 3. 校验生效
\echo '[CB-4] AFTER update — 校验生效'
SELECT id, user_id, name, auto_trade_enabled, strategy_keys
FROM paper_trading_portfolios
WHERE id IN (61, 62, 63, 64)
ORDER BY id;

COMMIT;
