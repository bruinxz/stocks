-- US-116 ANN-008 2026-06-20 — 回滚 announcement_event_relations (down).
--
-- 删除全表 + 所有 6 个索引. ON DELETE CASCADE 配置随表 DROP 一并清理.
-- 上游 ANN-009/010 (US-117/118) 持久化逻辑会失去落库目标但不会报错 (本表是新增).

BEGIN;

DROP INDEX IF EXISTS announcement_event_relations_ann_code_uniq;
DROP INDEX IF EXISTS idx_announcement_event_relations_announcement_id;
DROP INDEX IF EXISTS idx_announcement_event_relations_related_stock_code;
DROP INDEX IF EXISTS idx_announcement_event_relations_relation_type;
DROP INDEX IF EXISTS idx_announcement_event_relations_source;
DROP INDEX IF EXISTS idx_announcement_event_relations_extracted_at;

DROP TABLE IF EXISTS announcement_event_relations;

COMMIT;
