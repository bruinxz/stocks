/**
 * ETFCreationRedemption model 单元测试 (US-147 KOL-001).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/models/etf-creation-redemption.test.ts
 *
 * 本 story (KOL-001) 只新增 model schema + migration — 真持久化 (sync service / cron /
 * KOLAggregator 接入) 由后续 KOL-002 / KOL-003 / KOL-004 / KOL-006 完成. 因此测试聚焦:
 *   - schema 字段与 PRD US-147 AC ((trade_date, etf_code, etf_name, industry,
 *     net_creation, net_redemption, premium_pct)) 对齐
 *   - DECIMAL / JSONB 字段类型签名 + 默认值 + nullable 语义
 *   - 复合 PK (trade_date, etf_code) + 4 个辅助索引
 *   - migration up/down 形态 (CREATE/DROP, IF NOT EXISTS / IF EXISTS, BEGIN/COMMIT 完整)
 *   - META-GUARD: model 已挂 database.ts + models/index.ts (与 AIDiaryEntry /
 *     KOLAuthorStat 同款两处必挂模式)
 *
 * 实现笔记: sequelize-typescript 的 model class 必须 addModels 后才能调
 * Model.getAttributes(); 但本仓库 backend tests 全程 DB-less + 不依赖 jest +
 * 不连真 sequelize singleton. 因此沿用 ai-diary-entry / kol-author-stats 同款
 * fs+regex META-GUARD 模式直接对源文件断言 schema.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const MODEL_PATH = join(ROOT, 'src/models/ETFCreationRedemption.ts');
const DATABASE_PATH = join(ROOT, 'src/config/database.ts');
const INDEX_PATH = join(ROOT, 'src/models/index.ts');
const MIGRATION_UP_PATH = join(
  ROOT,
  'scripts/migrations/2026-06-21-etf-creation-redemption.sql',
);
const MIGRATION_DOWN_PATH = join(
  ROOT,
  'scripts/migrations/2026-06-21-etf-creation-redemption-rollback.sql',
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

// ---- [0] 文件存在性 --------------------------------------------------------
assert('[0.1] model 文件存在', existsSync(MODEL_PATH));
assert('[0.2] migration up 文件存在', existsSync(MIGRATION_UP_PATH));
assert('[0.3] migration down 文件存在', existsSync(MIGRATION_DOWN_PATH));

// ---- [1] @Table 配置 -------------------------------------------------------
assert(
  '[1.1] tableName = etf_creation_redemption',
  /tableName:\s*'etf_creation_redemption'/.test(modelSrc),
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
  '[2.1] 含 (trade_date) 单列索引',
  /\{\s*fields:\s*\[\s*'trade_date'\s*\]\s*,\s*name:\s*'idx_etf_creation_redemption_trade_date'/.test(
    indexesBlock,
  ),
);
assert(
  '[2.2] 含 (etf_code) 单列索引',
  /\{\s*fields:\s*\[\s*'etf_code'\s*\]\s*,\s*name:\s*'idx_etf_creation_redemption_etf_code'/.test(
    indexesBlock,
  ),
);
assert(
  '[2.3] 含 (industry) 单列索引',
  /\{\s*fields:\s*\[\s*'industry'\s*\]\s*,\s*name:\s*'idx_etf_creation_redemption_industry'/.test(
    indexesBlock,
  ),
);
assert(
  '[2.4] 含 (trade_date, industry) 复合索引',
  /fields:\s*\[\s*'trade_date'\s*,\s*'industry'\s*\][\s\S]*?name:\s*'idx_etf_creation_redemption_trade_date_industry'/.test(
    indexesBlock,
  ),
);

// ---- [3] 列定义 sanity ------------------------------------------------------
const columns = listColumnDeclarations(modelSrc);
const allColumnNames = new Set(columns.map(c => c.field));

// PRD US-147 AC 7 字段
const requiredAcCols = [
  'trade_date',
  'etf_code',
  'etf_name',
  'industry',
  'net_creation',
  'net_redemption',
  'premium_pct',
];
for (const c of requiredAcCols) {
  assert(`[3.ac] AC 字段 ${c} 列存在`, allColumnNames.has(c));
}

// 审计字段
const requiredAuditCols = ['source', 'raw_payload', 'created_at', 'updated_at'];
for (const c of requiredAuditCols) {
  assert(`[3.aud] 审计字段 ${c} 列存在`, allColumnNames.has(c));
}

// trade_date DATEONLY NOT NULL primaryKey
{
  const col = columnFor('trade_date');
  assert(
    '[3.1] trade_date DATEONLY NOT NULL primaryKey',
    !!col &&
      /type:\s*DataType\.DATEONLY/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /primaryKey:\s*true/.test(col.block),
  );
}
// etf_code STRING(20) NOT NULL primaryKey
{
  const col = columnFor('etf_code');
  assert(
    '[3.2] etf_code STRING(20) NOT NULL primaryKey',
    !!col &&
      /type:\s*DataType\.STRING\(20\)/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /primaryKey:\s*true/.test(col.block),
  );
}
// etf_name STRING(100) NOT NULL
{
  const col = columnFor('etf_name');
  assert(
    '[3.3] etf_name STRING(100) NOT NULL',
    !!col &&
      /type:\s*DataType\.STRING\(100\)/.test(col.block) &&
      /allowNull:\s*false/.test(col.block),
  );
}
// industry STRING(50) NOT NULL
{
  const col = columnFor('industry');
  assert(
    '[3.4] industry STRING(50) NOT NULL',
    !!col &&
      /type:\s*DataType\.STRING\(50\)/.test(col.block) &&
      /allowNull:\s*false/.test(col.block),
  );
}
// net_creation DECIMAL(24,4) NULLABLE
{
  const col = columnFor('net_creation');
  assert(
    '[3.5] net_creation DECIMAL(24,4) NULLABLE',
    !!col &&
      /type:\s*DataType\.DECIMAL\(24,\s*4\)/.test(col.block) &&
      /allowNull:\s*true/.test(col.block),
  );
}
// net_redemption DECIMAL(24,4) NULLABLE
{
  const col = columnFor('net_redemption');
  assert(
    '[3.6] net_redemption DECIMAL(24,4) NULLABLE',
    !!col &&
      /type:\s*DataType\.DECIMAL\(24,\s*4\)/.test(col.block) &&
      /allowNull:\s*true/.test(col.block),
  );
}
// premium_pct DECIMAL(8,4) NULLABLE
{
  const col = columnFor('premium_pct');
  assert(
    '[3.7] premium_pct DECIMAL(8,4) NULLABLE',
    !!col &&
      /type:\s*DataType\.DECIMAL\(8,\s*4\)/.test(col.block) &&
      /allowNull:\s*true/.test(col.block),
  );
}
// source STRING(50) NOT NULL default='akshare'
{
  const col = columnFor('source');
  assert(
    '[3.8] source STRING(50) NOT NULL default=akshare',
    !!col &&
      /type:\s*DataType\.STRING\(50\)/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'akshare'/.test(col.block),
  );
}
// raw_payload JSONB NOT NULL default={}
{
  const col = columnFor('raw_payload');
  assert(
    '[3.9] raw_payload JSONB NOT NULL default={}',
    !!col &&
      /type:\s*DataType\.JSONB/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*\{\}/.test(col.block),
  );
}

// ---- [4] TS 类型签名 --------------------------------------------------------
assert(
  '[4.1] trade_date: string',
  /declare\s+trade_date:\s*string;/.test(modelSrc),
);
assert(
  '[4.2] etf_code: string',
  /declare\s+etf_code:\s*string;/.test(modelSrc),
);
assert(
  '[4.3] net_creation: number | null',
  /declare\s+net_creation:\s*number\s*\|\s*null;/.test(modelSrc),
);
assert(
  '[4.4] net_redemption: number | null',
  /declare\s+net_redemption:\s*number\s*\|\s*null;/.test(modelSrc),
);
assert(
  '[4.5] premium_pct: number | null',
  /declare\s+premium_pct:\s*number\s*\|\s*null;/.test(modelSrc),
);
assert(
  '[4.6] raw_payload Record<string, unknown>',
  /declare\s+raw_payload:\s*Record<string,\s*unknown>;/.test(modelSrc),
);

// ---- [5] timestamps decorator -----------------------------------------------
assert('[5.1] @CreatedAt + created_at', /@CreatedAt\s*\n\s*@Column\(\{\s*field:\s*'created_at'\s*\}\)/.test(modelSrc));
assert('[5.2] @UpdatedAt + updated_at', /@UpdatedAt\s*\n\s*@Column\(\{\s*field:\s*'updated_at'\s*\}\)/.test(modelSrc));

// ---- [6] META-GUARD: 双处挂载 -----------------------------------------------
assert(
  '[6.1] database.ts import ETFCreationRedemption',
  /import\s*\{\s*ETFCreationRedemption\s*\}\s*from\s*'\.\.\/models\/ETFCreationRedemption'/.test(
    databaseSrc,
  ),
);
assert(
  '[6.2] database.ts addModels 列表含 ETFCreationRedemption',
  /\bETFCreationRedemption\b\s*,/.test(databaseSrc),
);
assert(
  '[6.3] models/index.ts re-export ETFCreationRedemption',
  /export\s*\*\s*from\s*'\.\/ETFCreationRedemption'/.test(indexSrc),
);

// ---- [7] migration up ------------------------------------------------------
assert('[7.0] up 含 BEGIN', /BEGIN;/.test(migrationUpSrc));
assert('[7.1] up 含 COMMIT', /COMMIT;/.test(migrationUpSrc));
assert(
  '[7.2] up 含 CREATE TABLE IF NOT EXISTS etf_creation_redemption',
  /CREATE TABLE IF NOT EXISTS etf_creation_redemption/i.test(migrationUpSrc),
);
assert('[7.3] up 含 trade_date DATE NOT NULL', /trade_date\s+DATE\s+NOT NULL/i.test(migrationUpSrc));
assert(
  '[7.4] up 含 etf_code VARCHAR(20) NOT NULL',
  /etf_code\s+VARCHAR\(20\)\s+NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.5] up 含 etf_name VARCHAR(100) NOT NULL',
  /etf_name\s+VARCHAR\(100\)\s+NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.6] up 含 industry VARCHAR(50) NOT NULL',
  /industry\s+VARCHAR\(50\)\s+NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.7] up 含 net_creation DECIMAL(24,4)',
  /net_creation\s+DECIMAL\(24,\s*4\)/i.test(migrationUpSrc),
);
assert(
  '[7.8] up 含 net_redemption DECIMAL(24,4)',
  /net_redemption\s+DECIMAL\(24,\s*4\)/i.test(migrationUpSrc),
);
assert(
  '[7.9] up 含 premium_pct DECIMAL(8,4)',
  /premium_pct\s+DECIMAL\(8,\s*4\)/i.test(migrationUpSrc),
);
assert(
  '[7.10] up 含 source VARCHAR(50) NOT NULL DEFAULT \'akshare\'',
  /source\s+VARCHAR\(50\)\s+NOT NULL\s+DEFAULT\s+'akshare'/i.test(migrationUpSrc),
);
assert(
  '[7.11] up 含 raw_payload JSONB NOT NULL DEFAULT \'{}\'::jsonb',
  /raw_payload\s+JSONB\s+NOT NULL\s+DEFAULT\s+'\{\}'::jsonb/i.test(migrationUpSrc),
);
assert(
  '[7.12] up 含 PRIMARY KEY (trade_date, etf_code)',
  /PRIMARY KEY\s*\(trade_date,\s*etf_code\)/i.test(migrationUpSrc),
);
assert(
  '[7.13] up 含 4 个 CREATE INDEX IF NOT EXISTS',
  /CREATE INDEX IF NOT EXISTS idx_etf_creation_redemption_trade_date\b/.test(migrationUpSrc) &&
    /CREATE INDEX IF NOT EXISTS idx_etf_creation_redemption_etf_code\b/.test(migrationUpSrc) &&
    /CREATE INDEX IF NOT EXISTS idx_etf_creation_redemption_industry\b/.test(migrationUpSrc) &&
    /CREATE INDEX IF NOT EXISTS idx_etf_creation_redemption_trade_date_industry\b/.test(
      migrationUpSrc,
    ),
);
assert(
  '[7.14] up 含 COMMENT ON TABLE',
  /COMMENT ON TABLE etf_creation_redemption IS/i.test(migrationUpSrc),
);
assert(
  '[7.15] up 含 7 AC 字段 COMMENT ON COLUMN',
  /COMMENT ON COLUMN etf_creation_redemption\.trade_date/i.test(migrationUpSrc) &&
    /COMMENT ON COLUMN etf_creation_redemption\.etf_code/i.test(migrationUpSrc) &&
    /COMMENT ON COLUMN etf_creation_redemption\.etf_name/i.test(migrationUpSrc) &&
    /COMMENT ON COLUMN etf_creation_redemption\.industry/i.test(migrationUpSrc) &&
    /COMMENT ON COLUMN etf_creation_redemption\.net_creation/i.test(migrationUpSrc) &&
    /COMMENT ON COLUMN etf_creation_redemption\.net_redemption/i.test(migrationUpSrc) &&
    /COMMENT ON COLUMN etf_creation_redemption\.premium_pct/i.test(migrationUpSrc),
);

// ---- [8] migration down ----------------------------------------------------
assert('[8.0] down 含 BEGIN', /BEGIN;/.test(migrationDownSrc));
assert('[8.1] down 含 COMMIT', /COMMIT;/.test(migrationDownSrc));
assert(
  '[8.2] down 含 DROP TABLE IF EXISTS etf_creation_redemption',
  /DROP TABLE IF EXISTS etf_creation_redemption/i.test(migrationDownSrc),
);
assert(
  '[8.3] down 含 4 个 DROP INDEX IF EXISTS',
  /DROP INDEX IF EXISTS idx_etf_creation_redemption_trade_date\b/.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_etf_creation_redemption_etf_code/.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_etf_creation_redemption_industry/.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_etf_creation_redemption_trade_date_industry/.test(migrationDownSrc),
);

// ---- summary ---------------------------------------------------------------
console.log(`\netf-creation-redemption model: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
