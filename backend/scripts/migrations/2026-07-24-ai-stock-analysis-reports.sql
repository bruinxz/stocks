BEGIN;

CREATE TABLE IF NOT EXISTS ai_stock_analysis_reports (
  id SERIAL PRIMARY KEY,
  report_id VARCHAR(100) NOT NULL,
  user_id INTEGER,
  stock_code VARCHAR(30) NOT NULL,
  stock_name VARCHAR(100),
  dimensions JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT,
  recommendation VARCHAR(50) NOT NULL DEFAULT 'unknown',
  confidence_score NUMERIC(8, 2),
  risk_level VARCHAR(30),
  key_points_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'completed',
  task_id VARCHAR(100),
  target_date VARCHAR(20),
  error TEXT,
  generated_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  engine_variant VARCHAR(40) NOT NULL DEFAULT 'tradingagents_legacy',
  shadow_of_report_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_ai_stock_analysis_reports_status
    CHECK (status IN ('completed', 'partial', 'failed', 'pending'))
);

-- Older development databases may already have the original report table but not the
-- shadow-engine fields introduced later. These additions keep the migration rerunnable.
ALTER TABLE ai_stock_analysis_reports
  ADD COLUMN IF NOT EXISTS engine_variant VARCHAR(40) NOT NULL DEFAULT 'tradingagents_legacy';
ALTER TABLE ai_stock_analysis_reports
  ADD COLUMN IF NOT EXISTS shadow_of_report_id VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS ai_stock_analysis_reports_report_id_uniq
  ON ai_stock_analysis_reports (report_id);
CREATE INDEX IF NOT EXISTS ai_stock_analysis_reports_stock_code_idx
  ON ai_stock_analysis_reports (stock_code);
CREATE INDEX IF NOT EXISTS ai_stock_analysis_reports_stock_generated_idx
  ON ai_stock_analysis_reports (stock_code, generated_at DESC);
CREATE INDEX IF NOT EXISTS ai_stock_analysis_reports_recommendation_idx
  ON ai_stock_analysis_reports (recommendation);
CREATE INDEX IF NOT EXISTS ai_stock_analysis_reports_status_idx
  ON ai_stock_analysis_reports (status);
CREATE INDEX IF NOT EXISTS ai_stock_analysis_reports_user_idx
  ON ai_stock_analysis_reports (user_id);
CREATE INDEX IF NOT EXISTS ai_stock_analysis_reports_task_user_idx
  ON ai_stock_analysis_reports (task_id, user_id);
CREATE INDEX IF NOT EXISTS idx_ai_reports_variant
  ON ai_stock_analysis_reports (engine_variant);
CREATE INDEX IF NOT EXISTS idx_ai_reports_shadow_of
  ON ai_stock_analysis_reports (shadow_of_report_id);

COMMENT ON TABLE ai_stock_analysis_reports IS
  'Audited TradingAgents single-stock research reports and asynchronous task placeholders';
COMMENT ON COLUMN ai_stock_analysis_reports.generated_at IS
  'Report generation timestamp; distinct from the requested historical target_date';

COMMIT;
