-- GAMMA 2026-06-18 — analysis-engine v1 shadow mode schema migration (up).
--
-- 新增 2 列 + 2 索引到 ai_stock_analysis_reports;
-- ai_investment_signals.source_type 用 VARCHAR (无 enum), 仅注释更新.
--
-- 回滚见 2026-06-18-analysis-engine-shadow-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-18-analysis-engine-shadow.sql

BEGIN;

ALTER TABLE ai_stock_analysis_reports
  ADD COLUMN IF NOT EXISTS engine_variant VARCHAR(40) NOT NULL DEFAULT 'tradingagents_legacy';

ALTER TABLE ai_stock_analysis_reports
  ADD COLUMN IF NOT EXISTS shadow_of_report_id VARCHAR(100) NULL;

CREATE INDEX IF NOT EXISTS idx_ai_reports_variant
  ON ai_stock_analysis_reports (engine_variant);

CREATE INDEX IF NOT EXISTS idx_ai_reports_shadow_of
  ON ai_stock_analysis_reports (shadow_of_report_id);

-- ai_investment_signals.source_type 当前是 VARCHAR (无 enum 约束),
-- 新值 'analysis_engine' 无需 ALTER, 仅更新列注释让 schema doc 同步.
COMMENT ON COLUMN ai_investment_signals.source_type IS
  '来源: daily_screener|tradingagents|quant_recommendation|manual_analysis|analysis_engine';

COMMIT;
