/**
 * BlackSwanPostmortemReport model 单元测试 (US-101 [PR-012]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/models/black-swan-postmortem-report.test.ts
 *
 * 本 story (PR-012) 只新增 model schema + migration — 真持久化 (write/read) 由后续:
 *   - PR-013 BlackSwanPostmortemService (US-102) 主入口 bulkUpsert
 *   - PR-014 CounterfactualBaselineCalculator (US-103) 填 counterfactual_baselines 段
 *   - PR-015 EventTimelineReplayer (US-104) 填 event_timeline 段
 *   - PR-016 ImprovementSuggestor (US-105) 填 improvement_suggestions 段
 *
 * 因此测试聚焦:
 *   - schema 字段与 PRD US-101 AC (报告模型 + 4 段 JSONB 字段) 对齐
 *   - 4 段 JSONB 字段 (event_summary / counterfactual_baselines / event_timeline /
 *     improvement_suggestions) 类型签名 + 默认值
 *   - 索引含 UNIQUE(black_swan_event_id) — 一事件一份最新报告不变量
 *   - FK 到 BlackSwanEvent (@ForeignKey + @BelongsTo)
 *   - migration up/down 形态 (CREATE/DROP, IF NOT EXISTS / IF EXISTS, BEGIN/COMMIT)
 *   - META-GUARD: model 已挂 database.ts + models/index.ts (与 BlackSwanEvent 同款两处必挂)
 *
 * 实现笔记: 沿用 [[black-swan-event.test.ts]] 同款 fs+regex META-GUARD 模式.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const MODEL_PATH = join(ROOT, 'src/models/BlackSwanPostmortemReport.ts');
const DATABASE_PATH = join(ROOT, 'src/config/database.ts');
const INDEX_PATH = join(ROOT, 'src/models/index.ts');
const MIGRATION_UP_PATH = join(
  ROOT,
  'scripts/migrations/2026-06-20-black-swan-postmortem-reports.sql',
);
const MIGRATION_DOWN_PATH = join(
  ROOT,
  'scripts/migrations/2026-06-20-black-swan-postmortem-reports-rollback.sql',
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
  '[1.1] tableName = black_swan_postmortem_reports',
  /tableName:\s*'black_swan_postmortem_reports'/.test(modelSrc),
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
  '[2.1] 含 UNIQUE(black_swan_event_id) 索引 — 一事件一份最新报告',
  /fields:\s*\[\s*'black_swan_event_id'\s*\][\s\S]*?unique:\s*true/.test(indexesBlock) &&
    /name:\s*'black_swan_postmortem_reports_event_uniq'/.test(indexesBlock),
);
assert(
  '[2.2] 含 status 单列索引',
  /\{\s*fields:\s*\[\s*'status'\s*\]\s*\}/m.test(indexesBlock),
);
assert(
  '[2.3] 含 source 单列索引',
  /\{\s*fields:\s*\[\s*'source'\s*\]\s*\}/m.test(indexesBlock),
);
assert(
  '[2.4] 含 generated_at 单列索引',
  /\{\s*fields:\s*\[\s*'generated_at'\s*\]\s*\}/m.test(indexesBlock),
);

// ---- [3] 列定义 sanity ------------------------------------------------------
const columns = listColumnDeclarations(modelSrc);
const allColumnNames = new Set(columns.map(c => c.field));

// 必须存在的字段全清单
const requiredCols = [
  'black_swan_event_id',
  'title',
  'summary',
  'event_summary',
  'counterfactual_baselines',
  'event_timeline',
  'improvement_suggestions',
  'source',
  'status',
  'reason',
  'metadata',
  'generated_at',
  'created_at',
  'updated_at',
];
for (const c of requiredCols) {
  assert(`[3.col] ${c} 列存在`, allColumnNames.has(c));
}

// black_swan_event_id INTEGER NOT NULL + @ForeignKey
{
  const col = columnFor('black_swan_event_id');
  assert(
    '[3.1] black_swan_event_id INTEGER NOT NULL',
    !!col && /type:\s*DataType\.INTEGER/.test(col.block) && /allowNull:\s*false/.test(col.block),
  );
  assert(
    '[3.1b] black_swan_event_id 有 @ForeignKey(() => BlackSwanEvent)',
    /@ForeignKey\(\(\)\s*=>\s*BlackSwanEvent\)\s*@Column\(\{[\s\S]*?field:\s*'black_swan_event_id'/.test(
      modelSrc,
    ),
  );
  assert(
    '[3.1c] 有 @BelongsTo(() => BlackSwanEvent) declare black_swan_event',
    /@BelongsTo\(\(\)\s*=>\s*BlackSwanEvent\)\s*declare\s+black_swan_event/.test(modelSrc),
  );
}
// title STRING NOT NULL default=''
{
  const col = columnFor('title');
  assert(
    '[3.2] title STRING NOT NULL default=""',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*''/.test(col.block),
  );
}
// summary TEXT NOT NULL default=''
{
  const col = columnFor('summary');
  assert(
    '[3.3] summary TEXT NOT NULL default=""',
    !!col &&
      /type:\s*DataType\.TEXT/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*''/.test(col.block),
  );
}
// 4 段 JSONB 字段 — PRD US-101 AC 核心要求
const fourSections = [
  'event_summary',
  'counterfactual_baselines',
  'event_timeline',
  'improvement_suggestions',
];
fourSections.forEach((field, idx) => {
  const col = columnFor(field);
  assert(
    `[3.4.${idx + 1}] 4 段 JSONB: ${field} NOT NULL default={}`,
    !!col &&
      /type:\s*DataType\.JSONB/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*\{\}/.test(col.block),
  );
});

// source STRING NOT NULL default='service_auto'
{
  const col = columnFor('source');
  assert(
    '[3.5] source STRING NOT NULL default=service_auto',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'service_auto'/.test(col.block),
  );
}
// status STRING NOT NULL default='pending'
{
  const col = columnFor('status');
  assert(
    '[3.6] status STRING NOT NULL default=pending',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'pending'/.test(col.block),
  );
}
// reason STRING nullable
{
  const col = columnFor('reason');
  assert(
    '[3.7] reason STRING nullable',
    !!col && /type:\s*DataType\.STRING/.test(col.block) && /allowNull:\s*true/.test(col.block),
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
// generated_at DATE NOT NULL
{
  const col = columnFor('generated_at');
  assert(
    '[3.9] generated_at DATE NOT NULL',
    !!col && /type:\s*DataType\.DATE/.test(col.block) && /allowNull:\s*false/.test(col.block),
  );
}
// 自动管理时间戳
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

// ---- [5] PRD US-101 AC: "报告模型 + 4 段 JSONB 字段" ----------------------------
{
  // AC: id PK
  assert(
    '[5.1] AC: id primaryKey autoIncrement',
    /primaryKey:\s*true[\s\S]*autoIncrement:\s*true/.test(modelSrc),
  );
  // AC: 4 段 JSONB 字段都存在
  fourSections.forEach((field, idx) => {
    const col = columnFor(field);
    assert(
      `[5.2.${idx + 1}] AC: ${field} JSONB`,
      !!col && /type:\s*DataType\.JSONB/.test(col.block),
    );
  });
  // AC: 与 BlackSwanEvent 关联 (FK)
  assert(
    '[5.3] AC: FK 到 BlackSwanEvent',
    /@ForeignKey\(\(\)\s*=>\s*BlackSwanEvent\)/.test(modelSrc),
  );
}

// ---- [6] META-GUARD: model 已挂到 database.ts + models/index.ts ----------
assert(
  '[6.1] database.ts 含 BlackSwanPostmortemReport import',
  /import\s*{\s*BlackSwanPostmortemReport\s*}\s*from\s*'\.\.\/models\/BlackSwanPostmortemReport';/.test(
    databaseSrc,
  ),
);
assert(
  '[6.2] database.ts models 数组含 BlackSwanPostmortemReport',
  /models:\s*\[[\s\S]*BlackSwanPostmortemReport[\s\S]*\]/.test(databaseSrc),
);
assert(
  "[6.3] models/index.ts 含 export * from './BlackSwanPostmortemReport'",
  /export\s+\*\s+from\s+'\.\/BlackSwanPostmortemReport';/.test(indexSrc),
);
assert('[6.4] model 含 PR-012 / US-101 标识', /PR-012|US-101/.test(modelSrc));
assert(
  '[6.5] model 含 tableName: black_swan_postmortem_reports',
  /black_swan_postmortem_reports/.test(modelSrc),
);
assert(
  '[6.6] model 注释含 PR-013/014/015/016 接入清单 (4 段各自填充)',
  /PR-013/.test(modelSrc) &&
    /PR-014/.test(modelSrc) &&
    /PR-015/.test(modelSrc) &&
    /PR-016/.test(modelSrc),
);
assert(
  '[6.7] model 注释含与 BlackSwanEvent (PR-010) 边界说明',
  /BlackSwanEvent/.test(modelSrc) && /PR-010/.test(modelSrc),
);
assert(
  '[6.8] model 注释含 4 段语义 (event_summary / counterfactual_baselines / event_timeline / improvement_suggestions)',
  /event_summary/.test(modelSrc) &&
    /counterfactual_baselines/.test(modelSrc) &&
    /event_timeline/.test(modelSrc) &&
    /improvement_suggestions/.test(modelSrc),
);
// PRD US-103 4 baseline 语义在 model 注释中应留痕
assert(
  '[6.9] model 注释含 4 baseline 类型 (hold/zero/plan/perfect)',
  /hold/.test(modelSrc) &&
    /zero/.test(modelSrc) &&
    /plan/.test(modelSrc) &&
    /perfect/.test(modelSrc),
);
// PRD US-105 4 类短板归类
assert(
  '[6.10] model 注释含 4 类短板 (detection/response/execution/risk_control)',
  /detection/.test(modelSrc) &&
    /response/.test(modelSrc) &&
    /execution/.test(modelSrc) &&
    /risk_control/.test(modelSrc),
);

// ---- [7] migration up/down 双 SQL 形态 ------------------------------------
assert('[7.0a] migration up 文件存在', existsSync(MIGRATION_UP_PATH));
assert('[7.0b] migration down 文件存在', existsSync(MIGRATION_DOWN_PATH));

// up
assert('[7.1] up 含 BEGIN', /BEGIN;/.test(migrationUpSrc));
assert('[7.2] up 含 COMMIT', /COMMIT;/.test(migrationUpSrc));
assert(
  '[7.3] up 含 CREATE TABLE IF NOT EXISTS black_swan_postmortem_reports',
  /CREATE TABLE IF NOT EXISTS black_swan_postmortem_reports/i.test(migrationUpSrc),
);
assert(
  '[7.4] up 含 black_swan_event_id INTEGER NOT NULL',
  /black_swan_event_id\s+INTEGER\s+NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.5] up 含 title VARCHAR NOT NULL',
  /title\s+VARCHAR\(\d+\)\s+NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.6] up 含 summary TEXT NOT NULL',
  /summary\s+TEXT\s+NOT NULL/i.test(migrationUpSrc),
);
// 4 段 JSONB NOT NULL
fourSections.forEach((field, idx) => {
  assert(
    `[7.7.${idx + 1}] up 含 ${field} JSONB NOT NULL`,
    new RegExp(`${field}\\s+JSONB\\s+NOT NULL`, 'i').test(migrationUpSrc),
  );
});
assert(
  '[7.8] up 含 source VARCHAR NOT NULL DEFAULT service_auto',
  /source\s+VARCHAR\(\d+\)\s+NOT NULL\s+DEFAULT\s+'service_auto'/i.test(migrationUpSrc),
);
assert(
  '[7.9] up 含 status VARCHAR NOT NULL DEFAULT pending',
  /status\s+VARCHAR\(\d+\)\s+NOT NULL\s+DEFAULT\s+'pending'/i.test(migrationUpSrc),
);
assert(
  '[7.10] up 含 reason VARCHAR (nullable)',
  /reason\s+VARCHAR/i.test(migrationUpSrc),
);
assert(
  '[7.11] up 含 metadata JSONB NOT NULL',
  /metadata\s+JSONB\s+NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.12] up 含 generated_at TIMESTAMP',
  /generated_at\s+TIMESTAMP/i.test(migrationUpSrc),
);
assert(
  '[7.13] up 含 UNIQUE INDEX black_swan_postmortem_reports_event_uniq',
  /CREATE UNIQUE INDEX IF NOT EXISTS black_swan_postmortem_reports_event_uniq[\s\S]*?\(black_swan_event_id\)/i.test(
    migrationUpSrc,
  ),
);
assert(
  '[7.14] up 含 status / source / generated_at 单列索引',
  /idx_black_swan_postmortem_reports_status/.test(migrationUpSrc) &&
    /idx_black_swan_postmortem_reports_source/.test(migrationUpSrc) &&
    /idx_black_swan_postmortem_reports_generated_at/.test(migrationUpSrc),
);
assert(
  '[7.15] up 含 COMMENT ON TABLE',
  /COMMENT ON TABLE black_swan_postmortem_reports IS/i.test(migrationUpSrc),
);
// 4 段 default '{}'::jsonb
fourSections.forEach((field, idx) => {
  assert(
    `[7.16.${idx + 1}] up ${field} 默认 '{}'::jsonb`,
    new RegExp(`${field}\\s+JSONB\\s+NOT NULL\\s+DEFAULT\\s+'\\{\\}'::jsonb`, 'i').test(
      migrationUpSrc,
    ),
  );
});

// down
assert('[7.30] down 含 BEGIN', /BEGIN;/.test(migrationDownSrc));
assert('[7.31] down 含 COMMIT', /COMMIT;/.test(migrationDownSrc));
assert(
  '[7.32] down 含 DROP TABLE IF EXISTS black_swan_postmortem_reports',
  /DROP TABLE IF EXISTS black_swan_postmortem_reports/i.test(migrationDownSrc),
);
assert(
  '[7.33] down 含 DROP INDEX IF EXISTS (全 4 个索引)',
  /DROP INDEX IF EXISTS black_swan_postmortem_reports_event_uniq/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_black_swan_postmortem_reports_status/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_black_swan_postmortem_reports_source/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_black_swan_postmortem_reports_generated_at/i.test(migrationDownSrc),
);

// ---- summary ---------------------------------------------------------------
console.log(`\nblack-swan-postmortem-report model: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
