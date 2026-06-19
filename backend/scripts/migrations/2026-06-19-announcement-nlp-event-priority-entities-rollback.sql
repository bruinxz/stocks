-- US-025 ANN-001 2026-06-19 — AnnouncementSummary 三列 + 索引回滚 (down).
--
-- 完全回退 2026-06-19-announcement-nlp-event-priority-entities.sql.
-- 警告: 会丢掉所有已抽取的 event_type / priority / entities (ANN-002~006 输出);
-- raw_payload 不含这些 AI 派生字段, 回滚后需重跑 ANN 系列重新填充.

BEGIN;

DROP INDEX IF EXISTS idx_announcement_summaries_event_type_date;
DROP INDEX IF EXISTS idx_announcement_summaries_priority_date;

ALTER TABLE announcement_summaries DROP COLUMN IF EXISTS entities;
ALTER TABLE announcement_summaries DROP COLUMN IF EXISTS priority;
ALTER TABLE announcement_summaries DROP COLUMN IF EXISTS event_type;

COMMIT;
