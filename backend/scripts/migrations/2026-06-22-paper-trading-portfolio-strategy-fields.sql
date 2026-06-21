-- AT-1 2026-06-22 — paper_trading_portfolios 增加 description / strategy_keys /
-- enabled_factors / risk_profile_overrides / auto_trade_enabled (up).
--
-- 用户原话: "现在的模拟盘我都不知道它是什么策略，用的是什么因子，
-- 而且我也没法自己新建、更新、删除模拟盘等操作"
--
-- 现在 paper_trading_portfolios 只有 7 列 (id/user_id/name/initial_capital/
-- current_cash/total_value/is_active). 没有 "这个盘绑什么策略 / 用什么因子 /
-- 是否参与自动跟单" 字段, 用户无法在 portfolio 级别配置或感知.
--
-- 字段语义:
--   - description TEXT — 模拟盘描述 (用户自由填写, "我的低波动测试盘" 之类)
--   - strategy_keys JSONB — ["multi_factor_alpha","dragon_head_momentum",...] (NOT NULL default [])
--       空数组 = 该盘接所有 active 策略 (legacy 行为, 向后兼容)
--       非空数组 = 该盘只接收数组里出现的 strategy_key 信号
--   - enabled_factors JSONB — ["value","momentum",...] (NOT NULL default [])
--       空数组 = 用策略层默认 factor 权重
--       非空数组 = 对 MultiFactorAlpha 等接受 factor weights 的策略, 只启用这些 factor
--   - risk_profile_overrides JSONB — { stop_loss_pct?: 0.05, max_position_pct?: 0.15, ... }
--       per-portfolio 风控 override; 缺省 = 用 user.risk_config / 全局默认
--   - auto_trade_enabled BOOLEAN — 默认 false (反向兼容: 升级后所有盘默认暂停自动跟单)
--       仅 auto_trade_enabled=true 的 portfolio 才被 PAPER_TRADING_AUTO_SYNC cron 跟单
--       用户主动 opt-in 才下单; 防止用户被动失血
--
-- 索引:
--   - (user_id, auto_trade_enabled) WHERE is_active=true — runAutoSync per-user fan-out 高频查
--
-- 回滚: 2026-06-22-paper-trading-portfolio-strategy-fields-rollback.sql
--
-- 升级后行为变更 (重要):
--   - 默认 auto_trade_enabled=false 让所有历史 portfolio 自动停止跟单
--   - 部署后立刻跑 backend/scripts/migrations/2026-06-22-admin-keep-auto-trade.sql
--     把 user_id=4 (admin) 现有盘恢复 auto_trade_enabled=true, 保持 prod 现状
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-22-paper-trading-portfolio-strategy-fields.sql

BEGIN;

ALTER TABLE paper_trading_portfolios
  ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE paper_trading_portfolios
  ADD COLUMN IF NOT EXISTS strategy_keys JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE paper_trading_portfolios
  ADD COLUMN IF NOT EXISTS enabled_factors JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE paper_trading_portfolios
  ADD COLUMN IF NOT EXISTS risk_profile_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE paper_trading_portfolios
  ADD COLUMN IF NOT EXISTS auto_trade_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN paper_trading_portfolios.description IS
  'AT-1 (2026-06-22): 模拟盘描述 (用户自由填写)';

COMMENT ON COLUMN paper_trading_portfolios.strategy_keys IS
  'AT-1 (2026-06-22): 该模拟盘绑定的策略 key 列表 ["multi_factor_alpha","dragon_head_momentum",...]. 空数组 = 所有 active 策略 (legacy 行为)';

COMMENT ON COLUMN paper_trading_portfolios.enabled_factors IS
  'AT-1 (2026-06-22): 该模拟盘启用的因子 key 列表 (用于 MultiFactorAlpha 等接受 factor weights 的策略). 空数组 = 策略默认';

COMMENT ON COLUMN paper_trading_portfolios.risk_profile_overrides IS
  'AT-1 (2026-06-22): per-portfolio 风控参数 override (空对象 = 用 user.risk_config / 全局默认)';

COMMENT ON COLUMN paper_trading_portfolios.auto_trade_enabled IS
  'AT-1 (2026-06-22): 是否参与 PAPER_TRADING_AUTO_SYNC cron 自动跟单. 默认 false 防误操作; 用户主动开';

CREATE INDEX IF NOT EXISTS idx_paper_trading_portfolios_auto_trade
  ON paper_trading_portfolios(user_id, auto_trade_enabled) WHERE is_active = true;

COMMIT;
