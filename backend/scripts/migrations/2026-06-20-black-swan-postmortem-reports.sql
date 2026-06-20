-- US-101 PR-012 2026-06-20 — 创建 black_swan_postmortem_reports (黑天鹅事件复盘报告) (up).
--
-- 一行 = 一个 BlackSwanEvent 的一次完整 postmortem 输出快照.
--
-- 本 story (PR-012) 只新增 schema + migration. 真持久化 (write/read) 由后续:
--   - PR-013 BlackSwanPostmortemService (US-102): 主入口, 编排 4 段生成 + bulkUpsert 本表
--   - PR-014 CounterfactualBaselineCalculator (US-103): 填 counterfactual_baselines 段
--   - PR-015 EventTimelineReplayer (US-104):           填 event_timeline 段
--   - PR-016 ImprovementSuggestor (US-105):            填 improvement_suggestions 段
--
-- 与既有 model 边界:
--   - BlackSwanEvent (PR-010) = 事件本身 global 视角 (上游 FK 来源).
--   - 本表 = per-event 一次性 postmortem (一对一; cron 重跑 UPSERT 覆盖最新版).
--
-- 字段语义 (与 backend/src/models/BlackSwanPostmortemReport.ts 对齐):
--   - black_swan_event_id INTEGER  — FK BlackSwanEvent.id (业务唯一键)
--   - title VARCHAR(200)           — 报告标题 (≤ 100 字 cap 由 service 守)
--   - summary TEXT                 — ≤ 500 字 heuristic/LLM 摘要
--   - event_summary JSONB          — 4 段第 1 段 (PR-013 主入口填; event_type/severity/scope/...)
--   - counterfactual_baselines JSONB — 4 段第 2 段 (PR-014 填; baselines[]={hold|zero|plan|perfect})
--   - event_timeline JSONB         — 4 段第 3 段 (PR-015 填; lookback_days, timeline[])
--   - improvement_suggestions JSONB — 4 段第 4 段 (PR-016 填; suggestions[]={4 类短板归类})
--   - source VARCHAR(20)           — service_auto / manual / external
--   - status VARCHAR(20)           — pending / ok / partial / failed (fail-OPEN)
--   - reason VARCHAR(200)          — partial / failed 时的简短原因 (nullable)
--   - metadata JSONB               — cron_run_id / errors[] / history[] / 各段版本号
--   - generated_at TIMESTAMPTZ     — 报告生成瞬间 (UPSERT 时更新, 与 created_at 区分)
--
-- 索引:
--   - UNIQUE(black_swan_event_id)  — 一事件一份最新报告 (idempotent UPSERT)
--   - (black_swan_event_id)        — JOIN BlackSwanEvent 时单列覆盖
--   - (status)                     — pending/ok/partial/failed 计数 + 失败列表
--   - (source)                     — service_auto vs manual 区分
--   - (generated_at)               — 按时间排序最近 N 条
--
-- 默认值 (fail-safe — 未跑过 service 的安全态):
--   title / summary 默认 '' (NOT NULL, 让 trivially INSERT 通过)
--   event_summary / counterfactual_baselines / event_timeline /
--     improvement_suggestions / metadata 默认 '{}'::jsonb
--   source 默认 'service_auto'
--   status 默认 'pending' (新报告默认生成中; PR-013 service 跑完再 update ok/partial/failed)
--
-- 回滚: 2026-06-20-black-swan-postmortem-reports-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-black-swan-postmortem-reports.sql

BEGIN;

CREATE TABLE IF NOT EXISTS black_swan_postmortem_reports (
  id                          SERIAL PRIMARY KEY,
  black_swan_event_id         INTEGER NOT NULL,
  title                       VARCHAR(200) NOT NULL DEFAULT '',
  summary                     TEXT NOT NULL DEFAULT '',
  event_summary               JSONB NOT NULL DEFAULT '{}'::jsonb,
  counterfactual_baselines    JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_timeline              JSONB NOT NULL DEFAULT '{}'::jsonb,
  improvement_suggestions     JSONB NOT NULL DEFAULT '{}'::jsonb,
  source                      VARCHAR(20) NOT NULL DEFAULT 'service_auto',
  status                      VARCHAR(20) NOT NULL DEFAULT 'pending',
  reason                      VARCHAR(200),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at                TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 业务唯一键: (black_swan_event_id) — 一事件一份最新报告; idempotent UPSERT
CREATE UNIQUE INDEX IF NOT EXISTS black_swan_postmortem_reports_event_uniq
  ON black_swan_postmortem_reports (black_swan_event_id);

CREATE INDEX IF NOT EXISTS idx_black_swan_postmortem_reports_status
  ON black_swan_postmortem_reports (status);

CREATE INDEX IF NOT EXISTS idx_black_swan_postmortem_reports_source
  ON black_swan_postmortem_reports (source);

CREATE INDEX IF NOT EXISTS idx_black_swan_postmortem_reports_generated_at
  ON black_swan_postmortem_reports (generated_at);

COMMENT ON TABLE black_swan_postmortem_reports IS
  'US-101 PR-012 黑天鹅事件复盘报告 — 一事件一份最新 postmortem; 4 段 JSONB (event_summary / counterfactual_baselines / event_timeline / improvement_suggestions) 由 PR-013/014/015/016 后续填充.';
COMMENT ON COLUMN black_swan_postmortem_reports.black_swan_event_id IS '关联 BlackSwanEvent.id (FK; 业务唯一键 — 一事件一份最新 postmortem)';
COMMENT ON COLUMN black_swan_postmortem_reports.title IS '报告标题 (≤ 100 字; cap 由 service 守)';
COMMENT ON COLUMN black_swan_postmortem_reports.summary IS '≤ 500 字 heuristic / LLM 摘要';
COMMENT ON COLUMN black_swan_postmortem_reports.event_summary IS '4 段第 1 段: 事件 snapshot (PR-013 主入口填; event_type/severity/scope/symbol/duration_minutes/severity_change?/linked_risk_alert_ids[])';
COMMENT ON COLUMN black_swan_postmortem_reports.counterfactual_baselines IS '4 段第 2 段: counterfactual 4 baseline 模拟 (PR-014 填; baselines[]={hold|zero|plan|perfect}, actual{}, calculator_version)';
COMMENT ON COLUMN black_swan_postmortem_reports.event_timeline IS '4 段第 3 段: 事件时间轴 (PR-015 填; lookback_days, timeline[], alert_count_by_level{}, replayer_version)';
COMMENT ON COLUMN black_swan_postmortem_reports.improvement_suggestions IS '4 段第 4 段: 改进建议 (PR-016 填; suggestions[]={detection|response|execution|risk_control 4 类短板归类}, top_findings[], suggestor_version)';
COMMENT ON COLUMN black_swan_postmortem_reports.source IS '触发来源: service_auto / manual / external';
COMMENT ON COLUMN black_swan_postmortem_reports.status IS '生成状态: pending / ok / partial / failed (与 ErrorPatternReport 对齐, fail-OPEN)';
COMMENT ON COLUMN black_swan_postmortem_reports.reason IS 'partial / failed 时的简短原因 (e.g. calculator_threw / no_baseline_data / replayer_no_input)';
COMMENT ON COLUMN black_swan_postmortem_reports.metadata IS '调用 metadata (cron_run_id / service_version / errors[] / history[] 历史版本 snapshot / 各段版本号)';
COMMENT ON COLUMN black_swan_postmortem_reports.generated_at IS '报告生成时间戳 (UPSERT 时更新; 与 created_at 区分: 后者首次 INSERT)';

COMMIT;
