-- US-025 ANN-001 2026-06-19 — AnnouncementSummary 加 event_type / priority / entities 三列 (up).
--
-- 为 ANN-002~007 (US-026~031) 做 schema 准备:
--   - event_type  — classifyEventType (US-026) 输出: 7 大事件分类 (业绩 / 重组 /
--                  减持 / 担保 / 处罚 / 解禁 / 其它); 历史行写 NULL = "未分类",
--                  ANN-002 落地后回填脚本可补.
--   - priority    — computePriority (US-029) 输出: critical / high / medium / low,
--                  critical → ANN-007 (US-031) 5min 飞书 push 入队;
--                  历史行默认 'low' 避免 ANN-007 任务把全量历史扫成 critical.
--   - entities    — extractEntities (US-027) 输出: 人名/角色/持股比例 list,
--                  JSONB array, e.g. [{name:'张三', role:'股东', holding_pct:5.2}].
--
-- 索引:
--   - (priority, announce_date DESC) — ANN-007 / 前端 "今日重要公告" 按优先级倒序;
--   - (event_type, announce_date DESC) — KOL/黑天鹅模块按事件类型聚合.
--
-- 回滚: 2026-06-19-announcement-nlp-event-priority-entities-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-19-announcement-nlp-event-priority-entities.sql

BEGIN;

ALTER TABLE announcement_summaries
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(40) NULL;

ALTER TABLE announcement_summaries
  ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'low';

ALTER TABLE announcement_summaries
  ADD COLUMN IF NOT EXISTS entities JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_announcement_summaries_priority_date
  ON announcement_summaries (priority, announce_date DESC);

CREATE INDEX IF NOT EXISTS idx_announcement_summaries_event_type_date
  ON announcement_summaries (event_type, announce_date DESC);

COMMENT ON COLUMN announcement_summaries.event_type IS
  'AI 事件分类 (US-026 classifyEventType): 业绩|重组|减持|担保|处罚|解禁|其它; NULL=未分类';
COMMENT ON COLUMN announcement_summaries.priority IS
  'AI 优先级 (US-029 computePriority): critical|high|medium|low; critical 触发 5min 飞书 push (US-031)';
COMMENT ON COLUMN announcement_summaries.entities IS
  'AI 实体抽取 (US-027 extractEntities): [{name,role,holding_pct?,...}] JSONB array, 默认 []';

COMMIT;
