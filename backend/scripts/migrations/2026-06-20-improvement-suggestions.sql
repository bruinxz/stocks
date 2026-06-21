-- US-094 PM-023 2026-06-20 — 创建 improvement_suggestions (per-user 改进建议) (up).
--
-- 一行 = 单个用户 + 一条改进建议. 由 ImprovementSuggestionService.generateForUser
-- (PM-023 同 story) 读最近 1 行 ErrorPatternReport.top_findings / bias / outcome
-- / attribution 各自展开生成. (user_id, period_end, category, key) 业务唯一.
--
-- 数据生产路径:
--   - PM-023 ImprovementSuggestionService.generateForUser → bulkUpsert 本表
--   - PM-024 (US-188) apply route: POST /api/me/improvement-suggestions/:id/apply
--     更新 status='applied' + applied_at
--   - 前端 SettingsWorkspace 待办建议 tab 后续接入 (PM-024 之后)
--
-- 字段语义 (与 backend/src/models/ImprovementSuggestion.ts 对齐):
--   - period_start / period_end — 来自 ErrorPatternReport, 冗余便于 UI read
--   - category                  — bias / outcome / attribution / top
--   - key                       — bias_type / outcome_type / dimension (cat 下唯一)
--   - title VARCHAR(200)        — 一行摘要 (≤ 60 字, cap 由 service 守)
--   - body TEXT                 — 具体建议 (≤ 500 字, cap 由 service 守)
--   - priority INTEGER          — 0..100, 高 = 优先 (cron 排序用)
--   - evidence JSONB            — error_pattern_report_id / sample_items / metric
--   - action JSONB              — apply 路径可执行参数 (默认 {"type":"noop"})
--   - source                    — heuristic / llm / manual
--   - status                    — open / applied / dismissed / expired
--   - metadata JSONB            — cron_run_id / heuristic_engine / etc
--   - generated_at              — service 跑的瞬间
--   - applied_at / dismissed_at — apply route 标 (PM-024); 默认 NULL
--
-- 索引:
--   - UNIQUE(user_id, period_end, category, key) — 业务键, idempotent upsert
--   - (user_id)                  — 按用户列出建议历史
--   - (period_end)               — 按周期 ops 看板
--   - (category)                 — 按类型过滤
--   - (status)                   — open/applied 计数
--   - (priority)                 — 排序列表
--   - (generated_at)             — 按时间排序最近 N 条
--
-- 默认值 (fail-safe — 未跑过 service 的安全态):
--   title / body 默认 '' (NOT NULL, 让 trivially INSERT 通过)
--   evidence / metadata 默认 '{}'::jsonb
--   action 默认 '{"type":"noop"}'::jsonb (apply route 永远有效 payload)
--   source 默认 'heuristic' (LLM 未接入时安全态)
--   status 默认 'open' (新建议默认待办)
--   priority 默认 0
--
-- 回滚: 2026-06-20-improvement-suggestions-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-improvement-suggestions.sql

BEGIN;

CREATE TABLE IF NOT EXISTS improvement_suggestions (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL,
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  category            VARCHAR(20) NOT NULL,
  key                 VARCHAR(80) NOT NULL,
  title               VARCHAR(200) NOT NULL DEFAULT '',
  body                TEXT NOT NULL DEFAULT '',
  priority            INTEGER NOT NULL DEFAULT 0,
  evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
  action              JSONB NOT NULL DEFAULT '{"type":"noop"}'::jsonb,
  source              VARCHAR(20) NOT NULL DEFAULT 'heuristic',
  status              VARCHAR(20) NOT NULL DEFAULT 'open',
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  applied_at          TIMESTAMP WITH TIME ZONE,
  dismissed_at        TIMESTAMP WITH TIME ZONE,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS improvement_suggestions_user_period_cat_key_uniq
  ON improvement_suggestions (user_id, period_end, category, key);

CREATE INDEX IF NOT EXISTS idx_improvement_suggestions_user_id
  ON improvement_suggestions (user_id);

CREATE INDEX IF NOT EXISTS idx_improvement_suggestions_period_end
  ON improvement_suggestions (period_end);

CREATE INDEX IF NOT EXISTS idx_improvement_suggestions_category
  ON improvement_suggestions (category);

CREATE INDEX IF NOT EXISTS idx_improvement_suggestions_status
  ON improvement_suggestions (status);

CREATE INDEX IF NOT EXISTS idx_improvement_suggestions_priority
  ON improvement_suggestions (priority);

CREATE INDEX IF NOT EXISTS idx_improvement_suggestions_generated_at
  ON improvement_suggestions (generated_at);

COMMENT ON TABLE improvement_suggestions IS
  'US-094 PM-023 改进建议 — per user per (period_end, category, key) 一行; ErrorPatternReport patterns 展开生成; PM-024 apply route 后续接入.';
COMMENT ON COLUMN improvement_suggestions.period_start IS '建议依据窗口起点 (来自 ErrorPatternReport.period_start, 冗余)';
COMMENT ON COLUMN improvement_suggestions.period_end IS '建议依据窗口终点 (业务键)';
COMMENT ON COLUMN improvement_suggestions.category IS '建议分类: bias / outcome / attribution / top';
COMMENT ON COLUMN improvement_suggestions.key IS '同 category 下唯一标识 (bias_type / outcome_type / dimension / "cat:key")';
COMMENT ON COLUMN improvement_suggestions.title IS '一行摘要 (≤ 60 字, cap 由 service 守)';
COMMENT ON COLUMN improvement_suggestions.body IS '具体改进建议 (≤ 500 字, cap 由 service 守)';
COMMENT ON COLUMN improvement_suggestions.priority IS '0..100 优先级, 高 = 优先';
COMMENT ON COLUMN improvement_suggestions.evidence IS '证据 snapshot (error_pattern_report_id / sample_items / metric)';
COMMENT ON COLUMN improvement_suggestions.action IS 'apply 路径可执行参数 (默认 {"type":"noop"}; PM-024 后续填实际动作)';
COMMENT ON COLUMN improvement_suggestions.source IS '生成来源: heuristic / llm / manual';
COMMENT ON COLUMN improvement_suggestions.status IS '生命周期: open / applied / dismissed / expired';
COMMENT ON COLUMN improvement_suggestions.metadata IS '调用 metadata (cron_run_id / heuristic_engine / etc)';
COMMENT ON COLUMN improvement_suggestions.generated_at IS '建议生成时间戳';
COMMENT ON COLUMN improvement_suggestions.applied_at IS 'apply route (PM-024) 标记时间戳; 默认 NULL';
COMMENT ON COLUMN improvement_suggestions.dismissed_at IS 'dismiss 时间戳; 默认 NULL';

COMMIT;
