-- US-116 ANN-008 2026-06-20 — 创建 announcement_event_relations (公告 ↔ 关联公司映射) (up).
--
-- 一行 = `(announcement_id, related_stock_code)` 的一条公告 ↔ 关联公司映射 (M:N).
-- AnnouncementSummary 描述 "某天某公司发布的一条公告" (主体公司);
-- 本表描述 "这条公告还提到 / 影响 / 牵连的其它公司" (关联公司), 用于:
--   - 上下游 / 控股 / 担保链路传染分析
--   - KOL / 黑天鹅模块按事件类型聚合时按 stock_code 反向找命中的公告
--   - 前端股票详情页 "近 30 天本股出现在哪些公告里" 抽屉
--
-- 本 story (ANN-008) 只新增 schema + migration. 真持久化 (write/read) 由后续:
--   - ANN-009 RelatedCompanyExtractor (US-117) → bulkUpsert
--   - ANN-010 AnnouncementDedupeService (US-118) → 读 + 回写
--
-- 字段语义 (与 backend/src/models/AnnouncementEventRelation.ts 对齐):
--   - announcement_id INTEGER     — 父公告 ID (FK → announcement_summaries.id, ON DELETE CASCADE)
--   - related_stock_code VARCHAR(10) — 关联公司股票代码 (6 位纯代码, 无 sh./sz. 前缀)
--   - related_stock_name VARCHAR(50) — 关联公司简称 (抽取时点, UI 用)
--   - relation_type VARCHAR(30)   — primary / mentioned / subsidiary / related_party / peer / other
--   - confidence NUMERIC(4,3)     — 0..1 抽取置信度
--   - source VARCHAR(40)          — extractor_heuristic / extractor_llm / manual / dedupe_service
--   - detail JSONB                — matched_text / matched_position / extractor_version
--   - metadata JSONB              — cron_run_id / linked_dedupe_cluster_id ...
--   - extracted_at TIMESTAMPTZ    — 抽取瞬间 (与 created_at 区分)
--
-- 索引:
--   - UNIQUE(announcement_id, related_stock_code)
--                                 — 同一条公告对同一关联公司只该有一行 (ON CONFLICT 覆盖)
--   - (announcement_id) / (related_stock_code) / (relation_type) / (source) — 多维查询
--   - (extracted_at)              — 按时间排序最近 N 条
--
-- 默认值 (fail-safe — 未跑过 extractor 的安全态):
--   relation_type 默认 'mentioned' (弱关联; 减少误传染)
--   confidence 默认 0.5 (中间档)
--   source 默认 'extractor_heuristic'
--   detail/metadata 默认 '{}'::jsonb
--   extracted_at 默认 NOW()
--
-- 回滚: 2026-06-20-announcement-event-relations-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-announcement-event-relations.sql

BEGIN;

CREATE TABLE IF NOT EXISTS announcement_event_relations (
  id                  SERIAL PRIMARY KEY,
  announcement_id     INTEGER NOT NULL REFERENCES announcement_summaries(id) ON DELETE CASCADE,
  related_stock_code  VARCHAR(10) NOT NULL,
  related_stock_name  VARCHAR(50),
  relation_type       VARCHAR(30) NOT NULL DEFAULT 'mentioned',
  confidence          NUMERIC(4, 3) NOT NULL DEFAULT 0.5,
  source              VARCHAR(40) NOT NULL DEFAULT 'extractor_heuristic',
  detail              JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  extracted_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 业务唯一键: 同一条公告对同一关联公司只一行
CREATE UNIQUE INDEX IF NOT EXISTS announcement_event_relations_ann_code_uniq
  ON announcement_event_relations (announcement_id, related_stock_code);

CREATE INDEX IF NOT EXISTS idx_announcement_event_relations_announcement_id
  ON announcement_event_relations (announcement_id);

CREATE INDEX IF NOT EXISTS idx_announcement_event_relations_related_stock_code
  ON announcement_event_relations (related_stock_code);

CREATE INDEX IF NOT EXISTS idx_announcement_event_relations_relation_type
  ON announcement_event_relations (relation_type);

CREATE INDEX IF NOT EXISTS idx_announcement_event_relations_source
  ON announcement_event_relations (source);

CREATE INDEX IF NOT EXISTS idx_announcement_event_relations_extracted_at
  ON announcement_event_relations (extracted_at);

COMMENT ON TABLE announcement_event_relations IS
  'US-116 ANN-008 公告 ↔ 关联公司映射 (M:N) — 一行 = (announcement_id, related_stock_code); ANN-009 extractor / ANN-010 dedupe 后续接入.';
COMMENT ON COLUMN announcement_event_relations.announcement_id IS '父公告 ID (FK → announcement_summaries.id, ON DELETE CASCADE)';
COMMENT ON COLUMN announcement_event_relations.related_stock_code IS '关联公司股票代码 (6 位纯代码, 无 sh./sz. 前缀; 与 AnnouncementSummary.stock_code 同款)';
COMMENT ON COLUMN announcement_event_relations.related_stock_name IS '关联公司简称 (抽取时点, UI 展示)';
COMMENT ON COLUMN announcement_event_relations.relation_type IS '关联性质: primary / mentioned / subsidiary / related_party / peer / other';
COMMENT ON COLUMN announcement_event_relations.confidence IS '抽取置信度 0..1 (ANN-009 extractor 给出; 默认 0.5 中间档)';
COMMENT ON COLUMN announcement_event_relations.source IS '抽取来源: extractor_heuristic / extractor_llm / manual / dedupe_service';
COMMENT ON COLUMN announcement_event_relations.detail IS '关系上下文 snapshot (matched_text / matched_position / extractor_version 等)';
COMMENT ON COLUMN announcement_event_relations.metadata IS '调用 metadata (cron_run_id / extractor_version / linked_dedupe_cluster_id 等)';
COMMENT ON COLUMN announcement_event_relations.extracted_at IS '抽取瞬间 (ANN-009 extractor 写入时 NOW(); 与 created_at 区分)';

COMMIT;
