-- US-146 PM-027 2026-06-21 — improvement_suggestions 增加 effect_metrics + effect_tracked_at (up).
--
-- PM-024 (US-126) 落 apply route 后, PM-027 在 apply 满 30 天 (window 可调) 后采集
-- 该用户的实盘归因 metrics (pnl 累计 / pnl_pct 平均 / 简易 sharpe / 样本天数),
-- 写回到 improvement_suggestions.effect_metrics JSONB. 给前端展示"建议 apply 后实际效果"
-- 并辅助 ops 评估 ErrorPatternAggregator + ImprovementSuggestion heuristic 质量.
--
-- 字段语义 (与 ImprovementSuggestion.ts 同步):
--   - effect_metrics JSONB  — 默认 '{}'::jsonb (未跟踪态); 跑过后填:
--       { window_days, sample_days, total_pnl_sum, total_pnl_pct_avg,
--         total_pnl_pct_sharpe, trade_count_sum, start_date, end_date,
--         portfolios_covered, source }
--   - effect_tracked_at TIMESTAMPTZ — 跟踪写入时间戳; NULL = 未跟踪.
--
-- 索引:
--   - (status, effect_tracked_at) — tracker cron 高频按 status='applied' AND
--     effect_tracked_at IS NULL 的 partial 列表查询用.
--
-- 默认值 (fail-safe — 已有行 ALTER 后):
--   effect_metrics 默认 '{}'::jsonb (NOT NULL)
--   effect_tracked_at 默认 NULL (allowNull)
--
-- 回滚: 2026-06-21-improvement-suggestions-effect-metrics-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-21-improvement-suggestions-effect-metrics.sql

BEGIN;

ALTER TABLE improvement_suggestions
  ADD COLUMN IF NOT EXISTS effect_metrics JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE improvement_suggestions
  ADD COLUMN IF NOT EXISTS effect_tracked_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_improvement_suggestions_status_tracked
  ON improvement_suggestions (status, effect_tracked_at);

COMMENT ON COLUMN improvement_suggestions.effect_metrics IS
  'US-146 PM-027 apply 后效果指标 (window_days / sample_days / total_pnl_sum / total_pnl_pct_avg / sharpe / etc); 默认 {} = 未跟踪';
COMMENT ON COLUMN improvement_suggestions.effect_tracked_at IS
  'US-146 PM-027 跟踪写入时间戳; NULL = 未跑过 effect tracker';

COMMIT;
