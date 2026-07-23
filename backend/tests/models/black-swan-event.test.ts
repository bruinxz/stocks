/**
 * BlackSwanEvent model 单元测试 (US-099 [PR-010]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/models/black-swan-event.test.ts
 *
 * 本 story (PR-010) 只新增 model schema + migration — 真持久化 (write/read) 由后续:
 *   - PR-011 BlackSwanDetector cron (US-100) → bulkCreate
 *   - PR-012 BlackSwanPostmortemReport (US-101) → FK 本表
 *   - PR-013 BlackSwanPostmortemService (US-102)
 *
 * 因此测试聚焦:
 *   - schema 字段与 PRD US-099 AC ((id, detected_at, event_type, severity, scope)) 对齐
 *   - JSONB 字段类型签名 + 默认值
 *   - 索引含 (event_type, signature, detected_at) UNIQUE — idempotent 不变量
 *   - migration up/down 形态 (CREATE/DROP, IF NOT EXISTS / IF EXISTS, BEGIN/COMMIT 完整)
 *   - 固定 Asia/Shanghai 日界线的表达式索引真生效 (与 BlackSwanWatchdog 30min cron 兼容)
 *   - META-GUARD: model 已挂 database.ts + models/index.ts (与 AIDiaryEntry / DailyAttributionReport
 *     同款两处必挂模式)
 *
 * 实现笔记: 沿用 [[ai-diary-entry.test.ts]] 同款 fs+regex META-GUARD 模式 (backend DB-less +
 * 不依赖 jest + 不连真 sequelize singleton).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const MODEL_PATH = join(ROOT, 'src/models/BlackSwanEvent.ts');
const DATABASE_PATH = join(ROOT, 'src/config/database.ts');
const INDEX_PATH = join(ROOT, 'src/models/index.ts');
const MIGRATION_UP_PATH = join(ROOT, 'scripts/migrations/2026-06-20-black-swan-events.sql');
const MIGRATION_DOWN_PATH = join(
  ROOT,
  'scripts/migrations/2026-06-20-black-swan-events-rollback.sql',
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
assert('[1.1] tableName = black_swan_events', /tableName:\s*'black_swan_events'/.test(modelSrc));
assert('[1.2] underscored=true', /underscored:\s*true/.test(modelSrc));
assert('[1.3] timestamps=true', /timestamps:\s*true/.test(modelSrc));

// ---- [2] 索引 --------------------------------------------------------------
const tableMatch = modelSrc.match(/@Table\(\{([\s\S]*?)\}\)/m);
const tableBlock = tableMatch ? tableMatch[1] : '';
const indexesMatch = tableBlock.match(/indexes:\s*\[([\s\S]*)\][,\s]*$/m);
const indexesBlock = indexesMatch ? indexesMatch[1] : '';
assert('[2.0] indexes 数组存在', indexesBlock.length > 0);

assert(
  '[2.1] 含 (event_type, signature, detected_at) UNIQUE 复合索引',
  /fields:\s*\[\s*'event_type'\s*,\s*'signature'\s*,\s*'detected_at'\s*\]/.test(indexesBlock) &&
    /name:\s*'black_swan_events_type_sig_detected_uniq'/.test(indexesBlock) &&
    /unique:\s*true/.test(indexesBlock),
);
assert(
  '[2.2] 含 event_type 单列索引',
  /\{\s*fields:\s*\[\s*'event_type'\s*\]\s*\}/m.test(indexesBlock),
);
assert(
  '[2.3] 含 severity 单列索引',
  /\{\s*fields:\s*\[\s*'severity'\s*\]\s*\}/m.test(indexesBlock),
);
assert('[2.4] 含 scope 单列索引', /\{\s*fields:\s*\[\s*'scope'\s*\]\s*\}/m.test(indexesBlock));
assert('[2.5] 含 status 单列索引', /\{\s*fields:\s*\[\s*'status'\s*\]\s*\}/m.test(indexesBlock));
assert('[2.6] 含 symbol 单列索引', /\{\s*fields:\s*\[\s*'symbol'\s*\]\s*\}/m.test(indexesBlock));
assert(
  '[2.7] 含 detected_at 单列索引',
  /\{\s*fields:\s*\[\s*'detected_at'\s*\]\s*\}/m.test(indexesBlock),
);

// ---- [3] 列定义 sanity ------------------------------------------------------
const columns = listColumnDeclarations(modelSrc);
const allColumnNames = new Set(columns.map(c => c.field));

// 必须存在的字段全清单
const requiredCols = [
  'detected_at',
  'event_type',
  'severity',
  'scope',
  'symbol',
  'signature',
  'title',
  'description',
  'detail',
  'scope_detail',
  'source',
  'status',
  'resolved_at',
  'resolved_reason',
  'metadata',
  'created_at',
  'updated_at',
];
for (const c of requiredCols) {
  assert(`[3.col] ${c} 列存在`, allColumnNames.has(c));
}

// detected_at DATE NOT NULL
{
  const col = columnFor('detected_at');
  assert(
    '[3.1] detected_at DATE NOT NULL',
    !!col && /type:\s*DataType\.DATE/.test(col.block) && /allowNull:\s*false/.test(col.block),
  );
}
// event_type STRING NOT NULL
{
  const col = columnFor('event_type');
  assert(
    '[3.2] event_type STRING(40) NOT NULL',
    !!col &&
      /type:\s*DataType\.STRING\(40\)/.test(col.block) &&
      /allowNull:\s*false/.test(col.block),
  );
}
// severity STRING NOT NULL default='medium'
{
  const col = columnFor('severity');
  assert(
    '[3.3] severity STRING NOT NULL default=medium',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'medium'/.test(col.block),
  );
}
// scope STRING NOT NULL default='symbol'
{
  const col = columnFor('scope');
  assert(
    '[3.4] scope STRING NOT NULL default=symbol',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'symbol'/.test(col.block),
  );
}
// symbol STRING nullable
{
  const col = columnFor('symbol');
  assert(
    '[3.5] symbol STRING nullable',
    !!col && /type:\s*DataType\.STRING/.test(col.block) && /allowNull:\s*true/.test(col.block),
  );
}
// signature STRING NOT NULL default=''
{
  const col = columnFor('signature');
  assert(
    '[3.6] signature STRING NOT NULL default=""',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*''/.test(col.block),
  );
}
// title STRING NOT NULL default=''
{
  const col = columnFor('title');
  assert(
    '[3.7] title STRING NOT NULL default=""',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*''/.test(col.block),
  );
}
// description TEXT NOT NULL default=''
{
  const col = columnFor('description');
  assert(
    '[3.8] description TEXT NOT NULL default=""',
    !!col &&
      /type:\s*DataType\.TEXT/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*''/.test(col.block),
  );
}
// detail JSONB NOT NULL default={}
{
  const col = columnFor('detail');
  assert(
    '[3.9] detail JSONB NOT NULL default={}',
    !!col &&
      /type:\s*DataType\.JSONB/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*\{\}/.test(col.block),
  );
}
// scope_detail JSONB NOT NULL default={}
{
  const col = columnFor('scope_detail');
  assert(
    '[3.10] scope_detail JSONB NOT NULL default={}',
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
    '[3.11] metadata JSONB NOT NULL default={}',
    !!col &&
      /type:\s*DataType\.JSONB/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*\{\}/.test(col.block),
  );
}
// source STRING NOT NULL default='detector_cron'
{
  const col = columnFor('source');
  assert(
    '[3.12] source STRING NOT NULL default=detector_cron',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'detector_cron'/.test(col.block),
  );
}
// status STRING NOT NULL default='open'
{
  const col = columnFor('status');
  assert(
    '[3.13] status STRING NOT NULL default=open',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'open'/.test(col.block),
  );
}
// resolved_at DATE nullable
{
  const col = columnFor('resolved_at');
  assert(
    '[3.14] resolved_at DATE nullable',
    !!col && /type:\s*DataType\.DATE/.test(col.block) && /allowNull:\s*true/.test(col.block),
  );
}
// resolved_reason STRING nullable
{
  const col = columnFor('resolved_reason');
  assert(
    '[3.15] resolved_reason STRING nullable',
    !!col && /type:\s*DataType\.STRING/.test(col.block) && /allowNull:\s*true/.test(col.block),
  );
}
// 自动管理时间戳
assert(
  '[3.16] created_at @CreatedAt 装饰',
  /@CreatedAt\s+@Column\(\{\s*field:\s*'created_at'\s*\}\)/.test(modelSrc),
);
assert(
  '[3.17] updated_at @UpdatedAt 装饰',
  /@UpdatedAt\s+@Column\(\{\s*field:\s*'updated_at'\s*\}\)/.test(modelSrc),
);

// ---- [4] 所有业务列都带 comment -----------------------------------------------
for (const c of columns) {
  if (c.field === 'id') continue;
  if (c.field === 'created_at' || c.field === 'updated_at') continue;
  assert(`[4] ${c.field} 含 comment`, /comment:\s*['"]/.test(c.block), `field=${c.field}`);
}

// ---- [5] PRD US-099 AC: (id, detected_at, event_type, severity, scope) ----
{
  // AC: id PK
  assert('[5.1] AC: id primaryKey autoIncrement', /primaryKey:\s*true[\s\S]*autoIncrement:\s*true/.test(modelSrc));
  // AC: detected_at 字段存在 + DATE 类型
  {
    const col = columnFor('detected_at');
    assert(
      '[5.2] AC: detected_at DATE',
      !!col && /type:\s*DataType\.DATE/.test(col.block),
    );
  }
  // AC: event_type 字段存在 STRING
  {
    const col = columnFor('event_type');
    assert(
      '[5.3] AC: event_type STRING',
      !!col && /type:\s*DataType\.STRING/.test(col.block),
    );
  }
  // AC: severity 字段存在 STRING
  {
    const col = columnFor('severity');
    assert(
      '[5.4] AC: severity STRING',
      !!col && /type:\s*DataType\.STRING/.test(col.block),
    );
  }
  // AC: scope 字段存在 STRING
  {
    const col = columnFor('scope');
    assert(
      '[5.5] AC: scope STRING',
      !!col && /type:\s*DataType\.STRING/.test(col.block),
    );
  }
}

// ---- [6] META-GUARD: model 已挂到 database.ts + models/index.ts ----------
assert(
  '[6.1] database.ts 含 BlackSwanEvent import',
  /import\s*{\s*BlackSwanEvent\s*}\s*from\s*'\.\.\/models\/BlackSwanEvent';/.test(databaseSrc),
);
assert(
  '[6.2] database.ts models 数组含 BlackSwanEvent',
  /models:\s*\[[\s\S]*BlackSwanEvent[\s\S]*\]/.test(databaseSrc),
);
assert(
  "[6.3] models/index.ts 含 export * from './BlackSwanEvent'",
  /export\s+\*\s+from\s+'\.\/BlackSwanEvent';/.test(indexSrc),
);
assert('[6.4] model 含 PR-010 / US-099 标识', /PR-010|US-099/.test(modelSrc));
assert('[6.5] model 含 tableName: black_swan_events', /black_swan_events/.test(modelSrc));
assert(
  '[6.6] model 注释含与 BlackSwanWatchdog 边界说明',
  /BlackSwanWatchdog/.test(modelSrc) && /US-053/.test(modelSrc),
);
assert(
  '[6.7] model 注释含 PR-011/012/013/014/015/016 接入清单',
  /PR-011/.test(modelSrc) &&
    /PR-012/.test(modelSrc) &&
    /PR-013/.test(modelSrc) &&
    /PR-014/.test(modelSrc) &&
    /PR-015/.test(modelSrc) &&
    /PR-016/.test(modelSrc),
);

// ---- [7] migration up/down 双 SQL 形态 ------------------------------------
assert('[7.0a] migration up 文件存在', existsSync(MIGRATION_UP_PATH));
assert('[7.0b] migration down 文件存在', existsSync(MIGRATION_DOWN_PATH));

// up
assert('[7.1] up 含 BEGIN', /BEGIN;/.test(migrationUpSrc));
assert('[7.2] up 含 COMMIT', /COMMIT;/.test(migrationUpSrc));
assert(
  '[7.3] up 含 CREATE TABLE IF NOT EXISTS black_swan_events',
  /CREATE TABLE IF NOT EXISTS black_swan_events/i.test(migrationUpSrc),
);
assert(
  '[7.4] up 含 detected_at TIMESTAMP NOT NULL',
  /detected_at\s+TIMESTAMP[\s\S]*?NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.5] up 含 event_type VARCHAR NOT NULL',
  /event_type\s+VARCHAR\(\d+\)\s+NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.6] up 含 severity VARCHAR',
  /severity\s+VARCHAR/i.test(migrationUpSrc),
);
assert('[7.7] up 含 scope VARCHAR', /scope\s+VARCHAR/i.test(migrationUpSrc));
assert('[7.8] up 含 symbol VARCHAR', /symbol\s+VARCHAR/i.test(migrationUpSrc));
assert('[7.9] up 含 signature VARCHAR NOT NULL', /signature\s+VARCHAR[\s\S]*?NOT NULL/i.test(migrationUpSrc));
assert('[7.10] up 含 title VARCHAR NOT NULL', /title\s+VARCHAR[\s\S]*?NOT NULL/i.test(migrationUpSrc));
assert('[7.11] up 含 description TEXT NOT NULL', /description\s+TEXT\s+NOT NULL/i.test(migrationUpSrc));
assert('[7.12] up 含 detail JSONB NOT NULL', /detail\s+JSONB\s+NOT NULL/i.test(migrationUpSrc));
assert(
  '[7.13] up 含 scope_detail JSONB NOT NULL',
  /scope_detail\s+JSONB\s+NOT NULL/i.test(migrationUpSrc),
);
assert('[7.14] up 含 source VARCHAR', /source\s+VARCHAR/i.test(migrationUpSrc));
assert('[7.15] up 含 status VARCHAR', /status\s+VARCHAR/i.test(migrationUpSrc));
assert(
  '[7.16] up 含 resolved_at TIMESTAMP (nullable)',
  /resolved_at\s+TIMESTAMP/i.test(migrationUpSrc),
);
assert(
  '[7.17] up 含 resolved_reason VARCHAR (nullable)',
  /resolved_reason\s+VARCHAR/i.test(migrationUpSrc),
);
assert('[7.18] up 含 metadata JSONB NOT NULL', /metadata\s+JSONB\s+NOT NULL/i.test(migrationUpSrc));
// 关键: 先固定 Asia/Shanghai 再取 date；TIMESTAMPTZ 直接 ::date 不是 immutable，
// PostgreSQL 会拒绝创建表达式索引。
assert(
  '[7.19] up 含 UNIQUE INDEX black_swan_events_type_sig_detected_uniq with Asia/Shanghai date 表达式',
  /CREATE UNIQUE INDEX IF NOT EXISTS black_swan_events_type_sig_detected_uniq[\s\S]*?event_type,[\s\S]*?signature,[\s\S]*?detected_at AT TIME ZONE 'Asia\/Shanghai'[\s\S]*?::date/i.test(
    migrationUpSrc,
  ),
);
assert(
  '[7.20] up 含 event_type / severity / scope / status / symbol / detected_at 单列索引',
  /idx_black_swan_events_event_type/.test(migrationUpSrc) &&
    /idx_black_swan_events_severity/.test(migrationUpSrc) &&
    /idx_black_swan_events_scope/.test(migrationUpSrc) &&
    /idx_black_swan_events_status/.test(migrationUpSrc) &&
    /idx_black_swan_events_symbol/.test(migrationUpSrc) &&
    /idx_black_swan_events_detected_at/.test(migrationUpSrc),
);
assert(
  '[7.21] up 含 COMMENT ON TABLE',
  /COMMENT ON TABLE black_swan_events IS/i.test(migrationUpSrc),
);
assert(
  '[7.22] up severity 默认 medium',
  /severity\s+VARCHAR\(\d+\)\s+NOT NULL\s+DEFAULT\s+'medium'/i.test(migrationUpSrc),
);
assert(
  '[7.23] up status 默认 open',
  /status\s+VARCHAR\(\d+\)\s+NOT NULL\s+DEFAULT\s+'open'/i.test(migrationUpSrc),
);
assert(
  '[7.24] up scope 默认 symbol',
  /scope\s+VARCHAR\(\d+\)\s+NOT NULL\s+DEFAULT\s+'symbol'/i.test(migrationUpSrc),
);
assert(
  '[7.25] up source 默认 detector_cron',
  /source\s+VARCHAR\(\d+\)\s+NOT NULL\s+DEFAULT\s+'detector_cron'/i.test(migrationUpSrc),
);

// down
assert('[7.30] down 含 BEGIN', /BEGIN;/.test(migrationDownSrc));
assert('[7.31] down 含 COMMIT', /COMMIT;/.test(migrationDownSrc));
assert(
  '[7.32] down 含 DROP TABLE IF EXISTS black_swan_events',
  /DROP TABLE IF EXISTS black_swan_events/i.test(migrationDownSrc),
);
assert(
  '[7.33] down 含 DROP INDEX IF EXISTS (全 7 个索引)',
  /DROP INDEX IF EXISTS black_swan_events_type_sig_detected_uniq/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_black_swan_events_event_type/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_black_swan_events_severity/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_black_swan_events_scope/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_black_swan_events_status/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_black_swan_events_symbol/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_black_swan_events_detected_at/i.test(migrationDownSrc),
);

// ---- summary ---------------------------------------------------------------
console.log(`\nblack-swan-event model: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
