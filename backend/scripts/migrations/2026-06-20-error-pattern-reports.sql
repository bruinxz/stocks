-- US-092 PM-021 2026-06-20 — 创建 error_pattern_reports (per-user 90 天错误模式聚合) (up).
--
-- 一行 = 单个用户一个 90 天窗口的 bias / outcome / attribution 模式聚合.
--
-- 数据生产路径 (后续 story 接入):
--   - PM-021 ErrorPatternAggregator.aggregateForUser(user_id, period_end?) 主入口
--     → 取近 90 天 DailyAttributionReport.bias_findings + closed trades + attribution breakdown
--     → 聚合成 patterns JSONB + summary_stats + heuristic summary text
--   - PM-022 WEEKLY_ERROR_PATTERN_AGGREGATE cron 每周日 10:00 触发
--     → 对所有 active user 调 aggregateForUser → upsert 本表
--   - PM-023 ImprovementSuggestionService 读最近一行作 prompt 上下文
--
-- 字段语义 (与 backend/src/models/ErrorPatternReport.ts 对齐):
--   - period_start / period_end / lookback_days — 业务键冗余 (默认 period_end - 90 天)
--   - patterns JSONB           — bias_patterns[] / outcome_patterns[] / attribution_patterns[]
--                                  / top_findings[]
--   - summary_stats JSONB      — total_bias_count / total_outcome_count / win_rate /
--                                  avg_pnl_pct / data_completeness
--   - summary TEXT             — ≤ 500 字 heuristic 文本 (service 守 cap, model 不校验)
--   - source                   — heuristic / llm / manual
--   - status                   — ok / skipped (数据稀疏) / failed (fail-OPEN; skipped 也留痕)
--   - reason                   — skipped/failed 时的简短原因
--   - metadata JSONB           — cron_run_id / data_sources_used[] / errors[]
--   - generated_at             — 落库瞬间时间戳
--
-- 索引:
--   - UNIQUE(user_id, period_end) — 同 user 同 period_end 唯一 (周日重跑 idempotent upsert)
--   - (user_id) / (period_end)    — 按用户列出历史报告 / 按 period 查全平台覆盖率
--   - (status)                    — ops 看板 (skipped/failed 计数)
--   - (generated_at)              — 按时间排序最近 N 条
--
-- 默认值 (fail-safe — 未跑过 service 的安全态):
--   patterns / summary_stats / metadata 默认 '{}'::jsonb
--   summary 默认 '' (NOT NULL, 让 trivially INSERT 通过)
--   source 默认 'heuristic' (LLM 未接入时安全态)
--   status 默认 'ok' (与 DailyAttributionReport 同款 fail-OPEN)
--   lookback_days 默认 90 (PRD AC)
--
-- 回滚: 2026-06-20-error-pattern-reports-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-error-pattern-reports.sql

BEGIN;

CREATE TABLE IF NOT EXISTS error_pattern_reports (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL,
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  lookback_days       INTEGER NOT NULL DEFAULT 90,
  patterns            JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_stats       JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary             TEXT NOT NULL DEFAULT '',
  source              VARCHAR(20) NOT NULL DEFAULT 'heuristic',
  status              VARCHAR(20) NOT NULL DEFAULT 'ok',
  reason              VARCHAR(200),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS error_pattern_reports_user_period_uniq
  ON error_pattern_reports (user_id, period_end);

CREATE INDEX IF NOT EXISTS idx_error_pattern_reports_user_id
  ON error_pattern_reports (user_id);

CREATE INDEX IF NOT EXISTS idx_error_pattern_reports_period_end
  ON error_pattern_reports (period_end);

CREATE INDEX IF NOT EXISTS idx_error_pattern_reports_status
  ON error_pattern_reports (status);

CREATE INDEX IF NOT EXISTS idx_error_pattern_reports_generated_at
  ON error_pattern_reports (generated_at);

COMMENT ON TABLE error_pattern_reports IS
  'US-092 PM-021 错误模式聚合报告 — per user per 90-day window 一行, patterns/summary_stats JSONB 聚合 bias/outcome/attribution. (PM-022 cron / PM-023 suggestion 后续接入)';
COMMENT ON COLUMN error_pattern_reports.period_start IS '聚合窗口起点 (默认 period_end - 90 天)';
COMMENT ON COLUMN error_pattern_reports.period_end IS '聚合窗口终点 (业务键, 周日 cron 时 = 本周日)';
COMMENT ON COLUMN error_pattern_reports.lookback_days IS '聚合窗口天数 (默认 90)';
COMMENT ON COLUMN error_pattern_reports.patterns IS '聚合模式 (bias_patterns[]/outcome_patterns[]/attribution_patterns[]/top_findings[])';
COMMENT ON COLUMN error_pattern_reports.summary_stats IS '聚合统计 (total_bias_count/total_outcome_count/win_rate/avg_pnl_pct/data_completeness)';
COMMENT ON COLUMN error_pattern_reports.summary IS '≤ 500 字 heuristic 摘要 (cap 由 service 守, model 不校验)';
COMMENT ON COLUMN error_pattern_reports.source IS '生成来源: llm / heuristic / manual';
COMMENT ON COLUMN error_pattern_reports.status IS '生成状态: ok / skipped / failed (与 DailyAttributionReport 对齐, fail-OPEN)';
COMMENT ON COLUMN error_pattern_reports.reason IS 'skipped/failed 时的简短原因 (e.g. data_too_sparse / aggregator_threw)';
COMMENT ON COLUMN error_pattern_reports.metadata IS '调用 metadata (cron_run_id / data_sources_used[] / bias_findings_loaded / attribution_days_loaded / errors[])';
COMMENT ON COLUMN error_pattern_reports.generated_at IS '报告生成时间戳 (落库瞬间)';

COMMIT;
