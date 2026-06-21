# src/services/announcement/

L6-AI 公告处理子模块 — 围绕 [[AnnouncementSummary]] (已落库公告) 与
[[AnnouncementEventRelation]] (公告 ↔ 关联公司 M:N) 两张表做：
- 关联公司启发式抽取 ([[RelatedCompanyExtractor]] / US-117 ANN-009)
- 同事件/同公司 多次公告去重 ([[AnnouncementDedupeService]] / US-118 ANN-010)

## 共同设计约束

所有本目录下的 service **必须** 遵守以下契约 (Sprint 27/28/29 L8 教训):

1. **DataSource DI seam** — 主入口接 `XxxDataSource` interface, 默认走 PRODUCTION
   单例 (lazy-require model + try/catch fail-OPEN 转 [] / 0 / null). DB-less 单测
   通过 fake DataSource 全覆盖.
2. **pure-function-first** — 抽取 / 聚类 / 排序逻辑全 export 成 pure function (无
   model/DB 依赖), service class 只是薄 wrapper. 单测 ≥ 80% 跑 pure path, < 20%
   测 service class wiring.
3. **fail-OPEN 三层** — pure 主入口 unexpected throw 返"安全态" (extractor: []; 
   dedupe: trivial cluster); list 失败返 []; persist 失败返 0 不抛. 上游 caller
   永远拿到结构化结果, 不被本 service 阻塞.
4. **持久化不动父表** — 给 AnnouncementSummary 加新列触发 migration + 历史回填,
   一律走 AnnouncementEventRelation.metadata 留痕 (per-service 字段命名:
   - extractor → metadata.extractor_version
   - dedupe → metadata.{linked_dedupe_cluster_id, is_canonical, duplicate_of}
   ).
5. **批处理 cap** — runBatch 必须有 limit / MAX_ROWS 兜底 (extractor 5000;
   dedupe 5000), 防大批量 OOM.

## 新加 service 检查表 (5 步)

1. 在本目录新增 `XxxService.ts`, 沿用 [[RelatedCompanyExtractor]] / 
   [[AnnouncementDedupeService]] 同款 6 段结构 (jsdoc / 公开常量 / 公开类型 /
   pure helpers / DataSource interface + PRODUCTION / Service class + singleton).
2. 在 `tests/services/announcement/<service>.test.ts` 新建对应单测, 沿用
   announcement-dedupe-service.test.ts 同款 7 段编号 (`[N.M]` 风格 + IIFE 测异步
   + `setTimeout(100, exit)` 等异步 assertion enqueue).
3. AC 含 "≥ N%" 类百分比验收 — 反向数学算样本: 
   `success_count = total × N/100`, 设计标注集让"恰好满足"成立 (留 0-5% buffer).
4. 写库走 AnnouncementEventRelation.bulkCreate + updateOnDuplicate, **必须**列
   `metadata` 字段在 updateOnDuplicate 否则 re-sync 同行不更新 metadata.
5. 不要在本目录文件顶层 `import sequelize` — 让单测进程能 `require()` 本 service
   不被拽起 DB. PRODUCTION_DATASOURCE 内部 lazy require model.

## 持久化 placeholder 字段约定

`AnnouncementEventRelation.related_stock_code` 是 UNIQUE 组合 (announcement_id,
related_stock_code) 的一部分, 必须非空. 当 service 写入的是"关于本公告的
service-level metadata"而非"关联的真实股票"时, 用 placeholder 占位:
- dedupe service → `_DEDUPE_`
- 未来新 service → `_<SERVICE_NAME>_` (全大写下划线)

避免占位字符串撞真股票代码 (真代码是 6 位数字).
