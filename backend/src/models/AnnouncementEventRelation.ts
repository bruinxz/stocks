import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * AnnouncementEventRelation — L6-AI / US-116 [ANN-008] 公告关联公司
 *
 * 一行 = `(announcement_id, related_stock_code)` 的一条公告 ↔ 关联公司映射。
 * AnnouncementSummary 描述 "某天某公司发布的一条公告" (primary 公司);
 * 本表描述 "这条公告还提到 / 影响 / 牵连的其它公司" (relation: 关联公司),
 * 用于:
 *   - 上下游 / 控股 / 担保链路传染分析 (e.g. A 公司业绩暴雷, 其供应商 B 也会受影响)
 *   - KOL / 黑天鹅模块按事件类型聚合时按 stock_code 反向找命中的公告
 *   - 前端股票详情页 "近 30 天本股出现在哪些公告里" 抽屉
 *
 * **本 story (ANN-008) 只新增 model schema + migration**, 真持久化由后续:
 *   - ANN-009 RelatedCompanyExtractor (US-117): 从 AnnouncementSummary.summary /
 *     entities / original_title 抽出关联公司代码 → bulkUpsert 本表
 *   - ANN-010 AnnouncementDedupeService (US-118): 用本表辅助去重 (同 event 命中多公司
 *     时不重复触发 critical push)
 *
 * **(announcement_id, related_stock_code) 业务唯一**:
 *   - 同一条公告对同一关联公司只该有一行 (cron 重跑 / 手动 replay 走 ON CONFLICT
 *     覆盖最新 relation_type / confidence / extracted_at).
 *   - 同一条公告允许多个关联公司 (e.g. 一份并购公告同时关联 acquirer / target / guarantor 3 家).
 *
 * **announcement_id 外键** (INTEGER → announcement_summaries.id):
 *   - 不在 model 层声明 @ForeignKey + @BelongsTo (避免循环 import / sequelize-typescript
 *     register 顺序坑); migration 层用 REFERENCES announcement_summaries(id) ON DELETE CASCADE
 *     保证父公告删除时本表行同删 (减少孤儿行)
 *   - 软引用而非硬关联: read 侧由 service 层 JOIN 查询 (与既有 AnnouncementSummary 消费方
 *     不强耦合)
 *
 * **related_stock_code 字段** (VARCHAR(10), 6 位纯代码):
 *   - 与 AnnouncementSummary.stock_code 同款语义: 无 sh./sz. 前缀, 与
 *     NorthboundHolding / LimitUpStock 一致, 便于反向查询 "本股近 30 天关联公告"
 *   - 不区分 primary / related: 即使等于 AnnouncementSummary.stock_code 也允许落一行
 *     (relation_type = 'primary'), 让前端按统一表查 "公告 N 关联了哪些股票"
 *
 * **relation_type 五态** —— 关联性质:
 *   - 'primary'      — 公告主体公司 (与 AnnouncementSummary.stock_code 相同)
 *   - 'mentioned'    — 公告正文提到的其它公司 (默认; 弱关联)
 *   - 'subsidiary'   — 子公司 / 控股公司 (强关联, 业绩影响传导)
 *   - 'related_party'— 关联方交易 (担保 / 借款 / 资产置换)
 *   - 'peer'         — 同行业 / 同 supply chain (用于黑天鹅传染分析)
 *   未来扩展走 'other' (避免 enum 收紧导致 migration 灾难)
 *
 * **confidence 字段** (NUMERIC 0..1):
 *   - ANN-009 extractor 给出抽取置信度 (LLM 概率 / 启发式硬命中 1.0 / 模糊匹配 0.5)
 *   - 低于阈值 (e.g. < 0.6) 的 relation 由 service 决定是否展示 / push (model 不过滤)
 *
 * **source 字段** (抽取来源):
 *   - 'extractor_heuristic' — ANN-009 启发式正则 (默认; 标题/摘要中 6 位代码命中)
 *   - 'extractor_llm'       — ANN-009 LLM 抽取 (entities JSONB 含 stock_code)
 *   - 'manual'              — admin 手动录入 (留痕)
 *   - 'dedupe_service'      — ANN-010 dedupe 服务回写 (合并 cluster 时补全)
 *
 * **detail JSONB** — 关系上下文 snapshot:
 *   - matched_text     — 抽取时命中的原文片段 (e.g. "本次交易方包括子公司贵州茅台 600519")
 *   - matched_position — 命中位置 (title / summary / entities[i].name)
 *   - extractor_version— ANN-009 版本号
 *
 * **fail-safe 默认值**:
 *   - relation_type 默认 'mentioned' (弱关联; 减少误传染)
 *   - confidence 默认 0.5 (中间档; 不偏向通过/拒绝)
 *   - source 默认 'extractor_heuristic'
 *   - detail / metadata 默认 '{}'::jsonb
 *
 * 主要消费方 (后续 story 接入):
 *   - ANN-009 RelatedCompanyExtractor (US-117) → bulkUpsert
 *   - ANN-010 AnnouncementDedupeService (US-118) → 读 + 回写
 *   - 前端股票详情页 "近 30 天本股出现在哪些公告" 抽屉
 *   - KOL / 黑天鹅模块按 (event_type, related_stock_code) 联合查询
 *
 * 与既有 AnnouncementSummary (US-059 / ANN-001~007) 边界:
 *   - AnnouncementSummary    = 公告本身 (主体公司维度, 一行一公告)
 *   - 本表 AnnouncementEventRelation = 公告 ↔ 关联公司 (一行一 relation, M:N)
 *
 * 实现笔记: 沿用 [[BlackSwanEvent]] 同款 fail-safe defaults + 字符串枚举不用 ENUM 类型,
 * 沿用 [[ImprovementSuggestion]] 同款 (业务键, JSONB evidence/detail) 落表模式.
 */
@Table({
  tableName: 'announcement_event_relations',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['announcement_id', 'related_stock_code'],
      unique: true,
      name: 'announcement_event_relations_ann_code_uniq',
    },
    { fields: ['announcement_id'] },
    { fields: ['related_stock_code'] },
    { fields: ['relation_type'] },
    { fields: ['source'] },
    { fields: ['extracted_at'] },
  ],
})
export class AnnouncementEventRelation extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'announcement_id',
    comment:
      '父公告 ID (软外键 → announcement_summaries.id; migration 层用 REFERENCES ON DELETE CASCADE)',
  })
  declare announcement_id: number;

  @Column({
    type: DataType.STRING(10),
    allowNull: false,
    field: 'related_stock_code',
    comment:
      '关联公司股票代码 (6 位纯代码, 无 sh./sz. 前缀; 与 AnnouncementSummary.stock_code 同款语义)',
  })
  declare related_stock_code: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'related_stock_name',
    comment: '关联公司简称 (抽取时点, 便于 UI 展示无需 JOIN)',
  })
  declare related_stock_name: string | null;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    field: 'relation_type',
    defaultValue: 'mentioned',
    comment:
      '关联性质: primary / mentioned / subsidiary / related_party / peer / other (默认 mentioned 弱关联)',
  })
  declare relation_type: string;

  @Column({
    type: DataType.DECIMAL(4, 3),
    allowNull: false,
    field: 'confidence',
    defaultValue: 0.5,
    comment: '抽取置信度 0..1 (ANN-009 extractor 给出; 默认 0.5 中间档不偏向通过/拒绝)',
  })
  declare confidence: number;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    field: 'source',
    defaultValue: 'extractor_heuristic',
    comment:
      '抽取来源: extractor_heuristic / extractor_llm / manual / dedupe_service (默认 heuristic)',
  })
  declare source: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'detail',
    defaultValue: {},
    comment:
      '关系上下文 snapshot (matched_text / matched_position / extractor_version 等; per-relation_type schema)',
  })
  declare detail: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'metadata',
    defaultValue: {},
    comment:
      '调用 metadata (cron_run_id / extractor_version / raw_payload_hash / linked_dedupe_cluster_id 等)',
  })
  declare metadata: Record<string, unknown>;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'extracted_at',
    defaultValue: DataType.NOW,
    comment: '抽取瞬间时间戳 (与 created_at 区分: 后者是 ORM 落库时刻; 默认 NOW())',
  })
  declare extracted_at: Date;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
