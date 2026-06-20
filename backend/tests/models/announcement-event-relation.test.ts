/**
 * AnnouncementEventRelation model 单元测试 (US-116 [ANN-008]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/models/announcement-event-relation.test.ts
 *
 * 本 story (ANN-008) 只新增 model schema + migration — 真持久化 (write/read) 由后续:
 *   - ANN-009 RelatedCompanyExtractor (US-117) → bulkUpsert
 *   - ANN-010 AnnouncementDedupeService (US-118) → 读 + 回写
 *
 * 因此测试聚焦:
 *   - schema 字段与 PRD US-116 AC 对齐 (announcement_id + related_stock_code + relation_type + ...)
 *   - JSONB / 数值字段类型签名 + 默认值
 *   - 索引含 (announcement_id, related_stock_code) UNIQUE — idempotent 不变量
 *   - migration up/down 形态 (CREATE/DROP, IF NOT EXISTS / IF EXISTS, BEGIN/COMMIT 完整)
 *   - REFERENCES announcement_summaries(id) ON DELETE CASCADE — 孤儿行预防
 *   - META-GUARD: model 已挂 database.ts + models/index.ts (与 BlackSwanEvent / AIDiaryEntry
 *     同款两处必挂模式)
 *
 * 实现笔记: 沿用 [[black-swan-event.test.ts]] / [[ai-diary-entry.test.ts]] 同款 fs+regex
 * META-GUARD 模式 (backend DB-less + 不依赖 jest + 不连真 sequelize singleton).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const MODEL_PATH = join(ROOT, 'src/models/AnnouncementEventRelation.ts');
const DATABASE_PATH = join(ROOT, 'src/config/database.ts');
const INDEX_PATH = join(ROOT, 'src/models/index.ts');
const MIGRATION_UP_PATH = join(
  ROOT,
  'scripts/migrations/2026-06-20-announcement-event-relations.sql',
);
const MIGRATION_DOWN_PATH = join(
  ROOT,
  'scripts/migrations/2026-06-20-announcement-event-relations-rollback.sql',
);

const modelSrc = readFileSync(MODEL_PATH, 'utf8');
const databaseSrc = readFileSync(DATABASE_PATH, 'utf8');
const indexSrc = readFileSync(INDEX_PATH, 'utf8');
const migrationUpSrc = readFileSync(MIGRATION_UP_PATH, 'utf8');
const migrationDownSrc = readFileSync(MIGRATION_DOWN_PATH, 'utf8');

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

/**
 * 提取 @Column({...}) 对应的 declare <field>: ... 块.
 */
function listColumnDeclarations(src: string): Array<{ block: string; field: string }> {
  const re = /@Column\(\{([\s\S]*?)\}\)\s*declare\s+(\w+)\??:\s*[^;]+;/g;
  const out: Array<{ block: string; field: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({ block: m[1], field: m[2] });
  }
  return out;
}

function columnFor(field: string): { block: string; field: string } | undefined {
  return listColumnDeclarations(modelSrc).find(c => c.field === field);
}

// ---- [1] @Table 配置 -------------------------------------------------------
assert(
  '[1.1] tableName = announcement_event_relations',
  /tableName:\s*'announcement_event_relations'/.test(modelSrc),
);
assert('[1.2] underscored=true', /underscored:\s*true/.test(modelSrc));
assert('[1.3] timestamps=true', /timestamps:\s*true/.test(modelSrc));

// ---- [2] 索引 --------------------------------------------------------------
const tableMatch = modelSrc.match(/@Table\(\{([\s\S]*?)\}\)/m);
const tableBlock = tableMatch ? tableMatch[1] : '';
const indexesMatch = tableBlock.match(/indexes:\s*\[([\s\S]*)\][,\s]*$/m);
const indexesBlock = indexesMatch ? indexesMatch[1] : '';
assert('[2.0] indexes 数组存在', indexesBlock.length > 0);

assert(
  '[2.1] 含 (announcement_id, related_stock_code) UNIQUE 复合索引',
  /fields:\s*\[\s*'announcement_id'\s*,\s*'related_stock_code'\s*\]/.test(indexesBlock) &&
    /name:\s*'announcement_event_relations_ann_code_uniq'/.test(indexesBlock) &&
    /unique:\s*true/.test(indexesBlock),
);
assert(
  '[2.2] 含 announcement_id 单列索引',
  /\{\s*fields:\s*\[\s*'announcement_id'\s*\]\s*\}/m.test(indexesBlock),
);
assert(
  '[2.3] 含 related_stock_code 单列索引',
  /\{\s*fields:\s*\[\s*'related_stock_code'\s*\]\s*\}/m.test(indexesBlock),
);
assert(
  '[2.4] 含 relation_type 单列索引',
  /\{\s*fields:\s*\[\s*'relation_type'\s*\]\s*\}/m.test(indexesBlock),
);
assert(
  '[2.5] 含 source 单列索引',
  /\{\s*fields:\s*\[\s*'source'\s*\]\s*\}/m.test(indexesBlock),
);
assert(
  '[2.6] 含 extracted_at 单列索引',
  /\{\s*fields:\s*\[\s*'extracted_at'\s*\]\s*\}/m.test(indexesBlock),
);

// ---- [3] 列定义 sanity ------------------------------------------------------
const columns = listColumnDeclarations(modelSrc);
const allColumnNames = new Set(columns.map(c => c.field));

const requiredCols = [
  'announcement_id',
  'related_stock_code',
  'related_stock_name',
  'relation_type',
  'confidence',
  'source',
  'detail',
  'metadata',
  'extracted_at',
  'created_at',
  'updated_at',
];
for (const c of requiredCols) {
  assert(`[3.col] ${c} 列存在`, allColumnNames.has(c));
}

// announcement_id INTEGER NOT NULL
{
  const col = columnFor('announcement_id');
  assert(
    '[3.1] announcement_id INTEGER NOT NULL',
    !!col && /type:\s*DataType\.INTEGER/.test(col.block) && /allowNull:\s*false/.test(col.block),
  );
}
// related_stock_code STRING(10) NOT NULL
{
  const col = columnFor('related_stock_code');
  assert(
    '[3.2] related_stock_code STRING(10) NOT NULL',
    !!col &&
      /type:\s*DataType\.STRING\(10\)/.test(col.block) &&
      /allowNull:\s*false/.test(col.block),
  );
}
// related_stock_name STRING nullable
{
  const col = columnFor('related_stock_name');
  assert(
    '[3.3] related_stock_name STRING nullable',
    !!col && /type:\s*DataType\.STRING/.test(col.block) && /allowNull:\s*true/.test(col.block),
  );
}
// relation_type STRING NOT NULL default='mentioned'
{
  const col = columnFor('relation_type');
  assert(
    '[3.4] relation_type STRING NOT NULL default=mentioned',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'mentioned'/.test(col.block),
  );
}
// confidence DECIMAL NOT NULL default=0.5
{
  const col = columnFor('confidence');
  assert(
    '[3.5] confidence DECIMAL NOT NULL default=0.5',
    !!col &&
      /type:\s*DataType\.DECIMAL/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*0\.5/.test(col.block),
  );
}
// source STRING NOT NULL default='extractor_heuristic'
{
  const col = columnFor('source');
  assert(
    '[3.6] source STRING NOT NULL default=extractor_heuristic',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'extractor_heuristic'/.test(col.block),
  );
}
// detail JSONB NOT NULL default={}
{
  const col = columnFor('detail');
  assert(
    '[3.7] detail JSONB NOT NULL default={}',
    !!col &&
      /type:\s*DataType\.JSONB/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*\{\}/.test(col.block),
  );
}
// metadata JSONB NOT NULL default={}
{
  const col = columnFor('metadata');
  assert(
    '[3.8] metadata JSONB NOT NULL default={}',
    !!col &&
      /type:\s*DataType\.JSONB/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*\{\}/.test(col.block),
  );
}
// extracted_at DATE NOT NULL
{
  const col = columnFor('extracted_at');
  assert(
    '[3.9] extracted_at DATE NOT NULL default NOW',
    !!col &&
      /type:\s*DataType\.DATE/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*DataType\.NOW/.test(col.block),
  );
}
// 时间戳装饰
assert(
  '[3.10] created_at @CreatedAt 装饰',
  /@CreatedAt\s+@Column\(\{\s*field:\s*'created_at'\s*\}\)/.test(modelSrc),
);
assert(
  '[3.11] updated_at @UpdatedAt 装饰',
  /@UpdatedAt\s+@Column\(\{\s*field:\s*'updated_at'\s*\}\)/.test(modelSrc),
);

// ---- [4] 所有业务列都带 comment -----------------------------------------------
for (const c of columns) {
  if (c.field === 'id') continue;
  if (c.field === 'created_at' || c.field === 'updated_at') continue;
  assert(`[4] ${c.field} 含 comment`, /comment:\s*['"]/.test(c.block), `field=${c.field}`);
}

// ---- [5] PRD US-116 AC: model OK + 公告关联公司语义 ----
{
  // AC: id PK
  assert(
    '[5.1] AC: id primaryKey autoIncrement',
    /primaryKey:\s*true[\s\S]*autoIncrement:\s*true/.test(modelSrc),
  );
  // AC: announcement_id INTEGER 必须存在 (外键到 AnnouncementSummary)
  {
    const col = columnFor('announcement_id');
    assert(
      '[5.2] AC: announcement_id INTEGER (软外键 → announcement_summaries)',
      !!col && /type:\s*DataType\.INTEGER/.test(col.block),
    );
  }
  // AC: related_stock_code 必须存在 (本表核心)
  {
    const col = columnFor('related_stock_code');
    assert(
      '[5.3] AC: related_stock_code STRING (公告关联公司)',
      !!col && /type:\s*DataType\.STRING/.test(col.block),
    );
  }
  // AC: relation_type 必须存在 (relation 性质)
  {
    const col = columnFor('relation_type');
    assert(
      '[5.4] AC: relation_type STRING (primary/mentioned/subsidiary/...)',
      !!col && /type:\s*DataType\.STRING/.test(col.block),
    );
  }
}

// ---- [6] META-GUARD: model 已挂到 database.ts + models/index.ts ----------
assert(
  '[6.1] database.ts 含 AnnouncementEventRelation import',
  /import\s*{\s*AnnouncementEventRelation\s*}\s*from\s*'\.\.\/models\/AnnouncementEventRelation';/.test(
    databaseSrc,
  ),
);
assert(
  '[6.2] database.ts models 数组含 AnnouncementEventRelation',
  /models:\s*\[[\s\S]*AnnouncementEventRelation[\s\S]*\]/.test(databaseSrc),
);
assert(
  "[6.3] models/index.ts 含 export * from './AnnouncementEventRelation'",
  /export\s+\*\s+from\s+'\.\/AnnouncementEventRelation';/.test(indexSrc),
);
assert('[6.4] model 含 ANN-008 / US-116 标识', /ANN-008|US-116/.test(modelSrc));
assert(
  '[6.5] model 含 tableName: announcement_event_relations',
  /announcement_event_relations/.test(modelSrc),
);
assert(
  '[6.6] model 注释含与 AnnouncementSummary 边界说明',
  /AnnouncementSummary/.test(modelSrc),
);
assert(
  '[6.7] model 注释含 ANN-009 / ANN-010 接入清单',
  /ANN-009/.test(modelSrc) && /ANN-010/.test(modelSrc),
);
assert(
  '[6.8] model 注释含 relation_type 5+ 枚举 (primary/mentioned/subsidiary/related_party/peer)',
  /primary/.test(modelSrc) &&
    /mentioned/.test(modelSrc) &&
    /subsidiary/.test(modelSrc) &&
    /related_party/.test(modelSrc) &&
    /peer/.test(modelSrc),
);

// ---- [7] migration up/down 双 SQL 形态 ------------------------------------
assert('[7.0a] migration up 文件存在', existsSync(MIGRATION_UP_PATH));
assert('[7.0b] migration down 文件存在', existsSync(MIGRATION_DOWN_PATH));

// up
assert('[7.1] up 含 BEGIN', /BEGIN;/.test(migrationUpSrc));
assert('[7.2] up 含 COMMIT', /COMMIT;/.test(migrationUpSrc));
assert(
  '[7.3] up 含 CREATE TABLE IF NOT EXISTS announcement_event_relations',
  /CREATE TABLE IF NOT EXISTS announcement_event_relations/i.test(migrationUpSrc),
);
// 关键: REFERENCES announcement_summaries(id) ON DELETE CASCADE — 防孤儿行
assert(
  '[7.4] up 含 announcement_id INTEGER NOT NULL REFERENCES announcement_summaries(id) ON DELETE CASCADE',
  /announcement_id\s+INTEGER\s+NOT NULL\s+REFERENCES\s+announcement_summaries\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i.test(
    migrationUpSrc,
  ),
);
assert(
  '[7.5] up 含 related_stock_code VARCHAR(10) NOT NULL',
  /related_stock_code\s+VARCHAR\(10\)\s+NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.6] up 含 related_stock_name VARCHAR (nullable)',
  /related_stock_name\s+VARCHAR/i.test(migrationUpSrc),
);
assert(
  '[7.7] up 含 relation_type VARCHAR NOT NULL DEFAULT mentioned',
  /relation_type\s+VARCHAR\(\d+\)\s+NOT NULL\s+DEFAULT\s+'mentioned'/i.test(migrationUpSrc),
);
assert(
  '[7.8] up 含 confidence NUMERIC NOT NULL DEFAULT 0.5',
  /confidence\s+NUMERIC\([\d,\s]+\)\s+NOT NULL\s+DEFAULT\s+0\.5/i.test(migrationUpSrc),
);
assert(
  '[7.9] up 含 source VARCHAR NOT NULL DEFAULT extractor_heuristic',
  /source\s+VARCHAR\(\d+\)\s+NOT NULL\s+DEFAULT\s+'extractor_heuristic'/i.test(migrationUpSrc),
);
assert('[7.10] up 含 detail JSONB NOT NULL', /detail\s+JSONB\s+NOT NULL/i.test(migrationUpSrc));
assert(
  '[7.11] up 含 metadata JSONB NOT NULL',
  /metadata\s+JSONB\s+NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.12] up 含 extracted_at TIMESTAMP NOT NULL DEFAULT NOW',
  /extracted_at\s+TIMESTAMP[\s\S]*?NOT NULL[\s\S]*?DEFAULT\s+NOW/i.test(migrationUpSrc),
);
// UNIQUE INDEX
assert(
  '[7.13] up 含 UNIQUE INDEX announcement_event_relations_ann_code_uniq (announcement_id, related_stock_code)',
  /CREATE UNIQUE INDEX IF NOT EXISTS announcement_event_relations_ann_code_uniq[\s\S]*?\(\s*announcement_id\s*,\s*related_stock_code\s*\)/i.test(
    migrationUpSrc,
  ),
);
assert(
  '[7.14] up 含 5 个普通索引',
  /idx_announcement_event_relations_announcement_id/.test(migrationUpSrc) &&
    /idx_announcement_event_relations_related_stock_code/.test(migrationUpSrc) &&
    /idx_announcement_event_relations_relation_type/.test(migrationUpSrc) &&
    /idx_announcement_event_relations_source/.test(migrationUpSrc) &&
    /idx_announcement_event_relations_extracted_at/.test(migrationUpSrc),
);
assert(
  '[7.15] up 含 COMMENT ON TABLE',
  /COMMENT ON TABLE announcement_event_relations IS/i.test(migrationUpSrc),
);

// down
assert('[7.30] down 含 BEGIN', /BEGIN;/.test(migrationDownSrc));
assert('[7.31] down 含 COMMIT', /COMMIT;/.test(migrationDownSrc));
assert(
  '[7.32] down 含 DROP TABLE IF EXISTS announcement_event_relations',
  /DROP TABLE IF EXISTS announcement_event_relations/i.test(migrationDownSrc),
);
assert(
  '[7.33] down 含 DROP INDEX IF EXISTS (全 6 个索引)',
  /DROP INDEX IF EXISTS announcement_event_relations_ann_code_uniq/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_announcement_event_relations_announcement_id/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_announcement_event_relations_related_stock_code/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_announcement_event_relations_relation_type/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_announcement_event_relations_source/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_announcement_event_relations_extracted_at/i.test(migrationDownSrc),
);

// ---- summary ---------------------------------------------------------------
console.log(`\nannouncement-event-relation model: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
