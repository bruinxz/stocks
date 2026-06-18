-- GAMMA 2026-06-18 — analysis-engine v1 shadow mode schema rollback (down).
--
-- 完全回退 2026-06-18-analysis-engine-shadow.sql.
-- 警告: 会丢掉所有 multi_dim_v1 历史 shadow rows 的可识别字段;
-- 仍可通过 metadata.engine_variant 找回 (落库时同时也写到 metadata).

BEGIN;

DROP INDEX IF EXISTS idx_ai_reports_shadow_of;
DROP INDEX IF EXISTS idx_ai_reports_variant;

ALTER TABLE ai_stock_analysis_reports DROP COLUMN IF EXISTS shadow_of_report_id;
ALTER TABLE ai_stock_analysis_reports DROP COLUMN IF EXISTS engine_variant;

-- 恢复 source_type 注释 (枚举值集合)
COMMENT ON COLUMN ai_investment_signals.source_type IS
  '来源: daily_screener|tradingagents|quant_recommendation|manual_analysis';

COMMIT;
