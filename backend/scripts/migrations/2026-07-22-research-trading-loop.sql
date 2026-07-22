BEGIN;

CREATE TABLE IF NOT EXISTS runtime_data_migrations (
  migration_key VARCHAR(160) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE paper_trading_portfolios
  ADD COLUMN IF NOT EXISTS portfolio_type VARCHAR(32) NOT NULL DEFAULT 'research_loop';

COMMENT ON COLUMN paper_trading_portfolios.portfolio_type IS
  '组合用途；当前产品只保留 research_loop 单一研究闭环模拟盘';

CREATE TABLE IF NOT EXISTS research_trading_loop_runs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id INTEGER NOT NULL REFERENCES paper_trading_portfolios(id) ON DELETE CASCADE,
  trading_day DATE NOT NULL,
  research_day DATE NOT NULL,
  status VARCHAR(20) NOT NULL,
  morning_snapshot_id UUID,
  multibagger_as_of TIMESTAMPTZ,
  target_count INTEGER NOT NULL DEFAULT 0,
  buy_count INTEGER NOT NULL DEFAULT 0,
  hold_count INTEGER NOT NULL DEFAULT 0,
  sell_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_research_trading_loop_run UNIQUE (user_id, trading_day),
  CONSTRAINT ck_research_trading_loop_run_status
    CHECK (status IN ('running', 'completed', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS ix_research_trading_loop_runs_portfolio_day
  ON research_trading_loop_runs (portfolio_id, trading_day DESC);

CREATE TABLE IF NOT EXISTS research_trading_loop_decisions (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES research_trading_loop_runs(id) ON DELETE CASCADE,
  portfolio_id INTEGER NOT NULL REFERENCES paper_trading_portfolios(id) ON DELETE CASCADE,
  signal_id INTEGER REFERENCES ai_investment_signals(id) ON DELETE SET NULL,
  trade_id INTEGER REFERENCES paper_trading_trades(id) ON DELETE SET NULL,
  symbol VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  action VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL,
  combined_score NUMERIC(8, 2),
  target_weight_pct NUMERIC(8, 2),
  reference_price NUMERIC(12, 4),
  quantity INTEGER,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_research_trading_loop_decision UNIQUE (run_id, symbol),
  CONSTRAINT ck_research_trading_loop_decision_action CHECK (action IN ('BUY', 'HOLD', 'SELL')),
  CONSTRAINT ck_research_trading_loop_decision_status
    CHECK (status IN ('planned', 'executed', 'held', 'skipped', 'failed'))
);

CREATE INDEX IF NOT EXISTS ix_research_trading_loop_decisions_portfolio
  ON research_trading_loop_decisions (portfolio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_research_trading_loop_decisions_symbol
  ON research_trading_loop_decisions (symbol, created_at DESC);

-- 用户已明确授权抛弃所有历史模拟盘。这个重置必须只执行一次；否则每次部署都会
-- 再次清空研究闭环交易。CASCADE 只清理 paper-trading 账本依赖，不触碰研究快照、
-- 行情、用户或回测结果。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM runtime_data_migrations
     WHERE migration_key = '2026-07-22-research-trading-loop-reset-v1'
  ) THEN
    IF to_regclass('public.feishu_notification_outbox') IS NOT NULL THEN
      EXECUTE $cleanup$
        DELETE FROM feishu_notification_outbox
         WHERE kind IN (
           'morning_risk_checkup',
           'morning_risk_checkup_correction',
           'paper_trade_executed',
           'paper_trade_correction',
           'recommendation_summary',
           'daily_trading_digest'
         )
            OR metadata ? 'portfolio_id'
      $cleanup$;
    END IF;

    IF to_regclass('public.risk_alerts') IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'risk_alerts'
            AND column_name = 'metadata'
       ) THEN
      EXECUTE $cleanup$
        DELETE FROM risk_alerts
         WHERE metadata ? 'portfolio_id'
            OR COALESCE(rule_id, '') LIKE 'paper_trading%'
      $cleanup$;
    END IF;

    IF to_regclass('public.paper_trading_data_corrections') IS NOT NULL THEN
      EXECUTE 'TRUNCATE TABLE paper_trading_data_corrections RESTART IDENTITY';
    END IF;

    TRUNCATE TABLE paper_trading_portfolios RESTART IDENTITY CASCADE;

    INSERT INTO paper_trading_portfolios (
      user_id, name, initial_capital, current_cash, total_value, is_active,
      description, strategy_keys, enabled_factors, risk_profile_overrides,
      auto_trade_enabled, portfolio_type, created_at, updated_at
    )
    SELECT
      id, '研究闭环模拟盘', 200000, 200000, 200000, TRUE,
      'A股早报 + 高倍潜力每日联合决策；只由研究闭环执行器维护。',
      '[]'::jsonb, '[]'::jsonb,
      '{"max_positions": 6, "max_single_weight_pct": 12, "hard_stop_loss_pct": 8}'::jsonb,
      TRUE, 'research_loop', NOW(), NOW()
    FROM users;

    INSERT INTO runtime_data_migrations (migration_key, details)
    VALUES (
      '2026-07-22-research-trading-loop-reset-v1',
      jsonb_build_object('portfolio_count', (SELECT COUNT(*) FROM paper_trading_portfolios))
    );
  END IF;
END $$;

-- 不保留软删/旧用途组合；闭环账户是产品中的唯一组合形态。
DELETE FROM paper_trading_portfolios
 WHERE portfolio_type <> 'research_loop' OR is_active = FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_loop_active_portfolio_per_user
  ON paper_trading_portfolios (user_id)
  WHERE portfolio_type = 'research_loop' AND is_active = TRUE;

-- 后续新注册用户也必须自动获得同一规格的唯一账户；这一段每次部署都可安全重跑。
INSERT INTO paper_trading_portfolios (
  user_id, name, initial_capital, current_cash, total_value, is_active,
  description, strategy_keys, enabled_factors, risk_profile_overrides,
  auto_trade_enabled, portfolio_type, created_at, updated_at
)
SELECT
  u.id, '研究闭环模拟盘', 200000, 200000, 200000, TRUE,
  'A股早报 + 高倍潜力每日联合决策；只由研究闭环执行器维护。',
  '[]'::jsonb, '[]'::jsonb,
  '{"max_positions": 6, "max_single_weight_pct": 12, "hard_stop_loss_pct": 8}'::jsonb,
  TRUE, 'research_loop', NOW(), NOW()
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM paper_trading_portfolios p
   WHERE p.user_id = u.id AND p.portfolio_type = 'research_loop' AND p.is_active = TRUE
)
ON CONFLICT DO NOTHING;

-- 旧自动跟单、实验盘、历史风控退出任务不再参与“我的持仓”。
UPDATE scheduled_tasks
   SET is_active = FALSE,
       last_run_status = 'SKIPPED',
       updated_at = NOW()
 WHERE type IN (
   'PAPER_TRADING_AUTO_SYNC',
   'PAPER_TRADING_RISK_CHECK',
   'PAPER_TRADING_TRAILING_STOP_UPDATE',
   'PAPER_TRADING_TRAILING_STOP_CHECK',
   'PAPER_TRADING_INDUSTRY_CONCENTRATION_CHECK',
   'PAPER_TRADING_DRAWDOWN_BREAKER_CHECK',
   'PAPER_TRADING_PER_STOCK_STOP_LOSS_CHECK',
   'PAPER_TRADING_DAILY_PLAN',
   'PAPER_TRADING_ATTRIBUTION_REPORT',
   'RECOMMENDATION_TRADE_OUTCOME_REFRESH'
 );

-- 历史 stock 日报固定引用已被清空的 portfolio_id，并会与新的全用户通用日报
-- 重复调度。只退役带旧组合作用域/旧名称的行，保留新版“飞书当日交易日报”。
UPDATE scheduled_tasks
   SET is_active = FALSE,
       last_run_status = 'SKIPPED',
       updated_at = NOW()
 WHERE type = 'PAPER_TRADING_DAILY_DIGEST'
   AND (
     name <> '飞书当日交易日报'
     OR parameters ? 'portfolio_id'
     OR parameters ? 'portfolio_name'
   );

-- 闭环保留的唯一常规用户通知：不绑定历史组合的全用户交易日报。
-- 历史环境里这条任务可能曾被人工停用；本次彻底重构明确恢复它。
UPDATE scheduled_tasks
   SET is_active = TRUE,
       updated_at = NOW()
 WHERE type = 'PAPER_TRADING_DAILY_DIGEST'
   AND name = '飞书当日交易日报'
   AND NOT (parameters ? 'portfolio_id')
   AND NOT (parameters ? 'portfolio_name');

COMMIT;
