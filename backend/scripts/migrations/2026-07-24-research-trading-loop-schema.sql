BEGIN;

-- 研究闭环的运行账本必须可以独立、安全地初始化。这个迁移只补结构，
-- 不创建、删除或重置任何模拟组合，也不改调度任务。
ALTER TABLE paper_trading_portfolios
  ADD COLUMN IF NOT EXISTS portfolio_type VARCHAR(32) NOT NULL DEFAULT 'research_loop';

COMMENT ON COLUMN paper_trading_portfolios.portfolio_type IS
  '组合用途；research_loop 表示早报与高倍潜力联合决策模拟盘';

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

COMMENT ON TABLE research_trading_loop_runs IS
  'migration:2026-07-24-research-trading-loop-schema';
COMMENT ON TABLE research_trading_loop_decisions IS
  'migration:2026-07-24-research-trading-loop-schema';

COMMIT;
