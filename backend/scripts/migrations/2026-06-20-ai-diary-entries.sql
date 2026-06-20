-- US-089 PM-018 2026-06-20 — 创建 ai_diary_entries (per-user per-date AI 投资日记) (up).
--
-- 一行 = 单个用户一个交易日的 AI 生成日记 (≤ 500 字 cap, 由 service 层守约, 不在 DB 强制).
--
-- 数据生产路径 (后续 story 接入):
--   - PM-019 AIDiaryService.generateForUser(user_id, date) 主入口
--     → LLM (TradingAgents / OpenAI) 主路径 + heuristic fallback
--   - PM-020 AI_DIARY_GENERATE cron 每日 18:00 工作日触发
--     → 对所有 active user 调 generateForUser → upsert 本表
--
-- 字段语义 (与 backend/src/models/AIDiaryEntry.ts 对齐):
--   - text                  — AI 生成日记正文 (≤ 500 字 cap 由 service enforce)
--   - evidence JSONB        — 证据 snapshot (daily_attribution_report_id / total_pnl /
--                              bias_findings_count / best_trades_codes / worst_trades_codes /
--                              factor_review_id / data_sources[])
--   - source                — llm / heuristic / manual
--   - status                — ok / skipped / failed (fail-OPEN; skipped 也留痕)
--   - reason                — skipped/failed 时的简短原因
--   - metadata JSONB        — 调用 metadata (llm_engine / llm_latency_ms / prompt_version / cron_run_id ...)
--   - generated_at          — 落库瞬间时间戳
--
-- 索引:
--   - UNIQUE(user_id, date) — 同 user 同日唯一; bulkCreate updateOnDuplicate 直接刷
--   - (user_id) / (date)    — 按用户列日记 / 按日期看全平台覆盖率
--   - (status) / (source)   — ops 看板 (skipped/failed 计数 / llm vs heuristic 占比)
--   - (generated_at)        — 按时间排序最近 N 条
--
-- 默认值 (fail-safe — 未跑过 service 的安全态):
--   text 默认 '' (NOT NULL, 让 trivially INSERT 通过)
--   evidence / metadata 默认 '{}'::jsonb
--   source 默认 'heuristic' (LLM 未接入时安全态)
--   status 默认 'ok' (与 DailyAttributionReport 同款 fail-OPEN, 未跑也算 ok 留痕)
--
-- 回滚: 2026-06-20-ai-diary-entries-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-ai-diary-entries.sql

BEGIN;

CREATE TABLE IF NOT EXISTS ai_diary_entries (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL,
  date                DATE NOT NULL,
  text                TEXT NOT NULL DEFAULT '',
  evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
  source              VARCHAR(20) NOT NULL DEFAULT 'heuristic',
  status              VARCHAR(20) NOT NULL DEFAULT 'ok',
  reason              VARCHAR(200),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_diary_entries_user_date_uniq
  ON ai_diary_entries (user_id, date);

CREATE INDEX IF NOT EXISTS idx_ai_diary_entries_user_id
  ON ai_diary_entries (user_id);

CREATE INDEX IF NOT EXISTS idx_ai_diary_entries_date
  ON ai_diary_entries (date);

CREATE INDEX IF NOT EXISTS idx_ai_diary_entries_status
  ON ai_diary_entries (status);

CREATE INDEX IF NOT EXISTS idx_ai_diary_entries_source
  ON ai_diary_entries (source);

CREATE INDEX IF NOT EXISTS idx_ai_diary_entries_generated_at
  ON ai_diary_entries (generated_at);

COMMENT ON TABLE ai_diary_entries IS
  'US-089 PM-018 AI 投资日记 — per user per date 一行, evidence JSONB 引证当日 attribution / bias / trades. (PM-019 service / PM-020 cron 后续接入)';
COMMENT ON COLUMN ai_diary_entries.text IS 'AI 生成日记正文 (≤ 500 字 cap 由 service 守, model 不校验)';
COMMENT ON COLUMN ai_diary_entries.evidence IS '证据 snapshot (daily_attribution_report_id / total_pnl / bias_findings_count / best_trades_codes / worst_trades_codes / factor_review_id / data_sources[])';
COMMENT ON COLUMN ai_diary_entries.source IS '生成来源: llm / heuristic / manual';
COMMENT ON COLUMN ai_diary_entries.status IS '生成状态: ok / skipped / failed (与 DailyAttributionReport 对齐, fail-OPEN)';
COMMENT ON COLUMN ai_diary_entries.reason IS 'skipped/failed 时的简短原因 (e.g. no_attribution_today / llm_timeout / heuristic_failed)';
COMMENT ON COLUMN ai_diary_entries.metadata IS '调用 metadata (llm_engine / llm_latency_ms / prompt_version / cron_run_id / heuristic_fallback_reason ...)';
COMMENT ON COLUMN ai_diary_entries.generated_at IS '日记生成时间戳 (落库瞬间)';

COMMIT;
