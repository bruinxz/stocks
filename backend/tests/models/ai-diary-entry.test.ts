/**
 * AIDiaryEntry model 单元测试 (US-089 [PM-018]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/models/ai-diary-entry.test.ts
 *
 * 本 story (PM-018) 只新增 model schema + migration — 真持久化 (upsert / read) 由后续
 * PM-019 (service) / PM-020 (cron) 接入. 因此测试聚焦:
 *   - schema 字段与 PRD US-089 AC ((user_id, date, text, evidence JSONB)) 对齐
 *   - JSONB 字段类型签名 + 默认值
 *   - 索引含 (user_id, date) UNIQUE — idempotent upsert 不变量
 *   - migration up/down 形态 (CREATE/DROP, IF NOT EXISTS / IF EXISTS, BEGIN/COMMIT 完整)
 *   - META-GUARD: model 已挂 database.ts + models/index.ts (与 DailyAttributionReport
 *     同款两处必挂模式)
 *
 * 实现笔记: sequelize-typescript 的 model class 必须 addModels 后才能调 Model.getAttributes();
 * 但本仓库 backend tests 全程 DB-less + 不依赖 jest + 不连真 sequelize singleton.
 * 因此沿用 daily-attribution-report.test.ts 同款 fs+regex META-GUARD 模式直接对源文件断言 schema.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const MODEL_PATH = join(ROOT, 'src/models/AIDiaryEntry.ts');
const DATABASE_PATH = join(ROOT, 'src/config/database.ts');
const INDEX_PATH = join(ROOT, 'src/models/index.ts');
const MIGRATION_UP_PATH = join(ROOT, 'scripts/migrations/2026-06-20-ai-diary-entries.sql');
const MIGRATION_DOWN_PATH = join(ROOT, 'scripts/migrations/2026-06-20-ai-diary-entries-rollback.sql');

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
assert('[1.1] tableName = ai_diary_entries', /tableName:\s*'ai_diary_entries'/.test(modelSrc));
assert('[1.2] underscored=true', /underscored:\s*true/.test(modelSrc));
assert('[1.3] timestamps=true', /timestamps:\s*true/.test(modelSrc));

// ---- [2] 索引 --------------------------------------------------------------
const tableMatch = modelSrc.match(/@Table\(\{([\s\S]*?)\}\)/m);
const tableBlock = tableMatch ? tableMatch[1] : '';
const indexesMatch = tableBlock.match(/indexes:\s*\[([\s\S]*)\][,\s]*$/m);
const indexesBlock = indexesMatch ? indexesMatch[1] : '';
assert('[2.0] indexes 数组存在', indexesBlock.length > 0);

assert(
  '[2.1] 含 (user_id, date) UNIQUE 复合索引',
  /fields:\s*\[\s*'user_id'\s*,\s*'date'\s*\]/.test(indexesBlock) &&
    /name:\s*'ai_diary_entries_user_date_uniq'/.test(indexesBlock) &&
    /unique:\s*true/.test(indexesBlock),
);
assert("[2.2] 含 user_id 单列索引", /\{\s*fields:\s*\[\s*'user_id'\s*\]\s*\}/m.test(indexesBlock));
assert("[2.3] 含 date 单列索引", /\{\s*fields:\s*\[\s*'date'\s*\]\s*\}/m.test(indexesBlock));
assert("[2.4] 含 status 单列索引", /\{\s*fields:\s*\[\s*'status'\s*\]\s*\}/m.test(indexesBlock));
assert("[2.5] 含 source 单列索引", /\{\s*fields:\s*\[\s*'source'\s*\]\s*\}/m.test(indexesBlock));
assert(
  "[2.6] 含 generated_at 单列索引",
  /\{\s*fields:\s*\[\s*'generated_at'\s*\]\s*\}/m.test(indexesBlock),
);

// ---- [3] 列定义 sanity ------------------------------------------------------
const columns = listColumnDeclarations(modelSrc);
const allColumnNames = new Set(columns.map(c => c.field));

// 必须存在的字段全清单
const requiredCols = [
  'user_id',
  'date',
  'text',
  'evidence',
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

// user_id INTEGER NOT NULL + ForeignKey
{
  const col = columnFor('user_id');
  assert(
    '[3.1] user_id INTEGER NOT NULL',
    !!col &&
      /type:\s*DataType\.INTEGER/.test(col.block) &&
      /allowNull:\s*false/.test(col.block),
  );
  assert(
    '[3.1.fk] user_id 含 ForeignKey(() => User) 装饰',
    /@ForeignKey\(\(\)\s*=>\s*User\)\s*@Column\(\{[\s\S]*?field:\s*'user_id'/.test(modelSrc),
  );
  assert(
    '[3.1.bt] user 含 BelongsTo(() => User) 装饰',
    /@BelongsTo\(\(\)\s*=>\s*User\)/.test(modelSrc),
  );
}
// date DATEONLY NOT NULL
{
  const col = columnFor('date');
  assert(
    '[3.2] date DATEONLY NOT NULL',
    !!col &&
      /type:\s*DataType\.DATEONLY/.test(col.block) &&
      /allowNull:\s*false/.test(col.block),
  );
}
// text TEXT NOT NULL default=''
{
  const col = columnFor('text');
  assert(
    '[3.3] text TEXT NOT NULL default=""',
    !!col &&
      /type:\s*DataType\.TEXT/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*''/.test(col.block),
  );
}
// evidence JSONB NOT NULL default={}
{
  const col = columnFor('evidence');
  assert(
    '[3.4] evidence JSONB NOT NULL default={}',
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
    '[3.5] metadata JSONB NOT NULL default={}',
    !!col &&
      /type:\s*DataType\.JSONB/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*\{\}/.test(col.block),
  );
}
// source STRING NOT NULL default='heuristic'
{
  const col = columnFor('source');
  assert(
    '[3.6] source STRING NOT NULL default=heuristic',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'heuristic'/.test(col.block),
  );
}
// status STRING NOT NULL default='ok'
{
  const col = columnFor('status');
  assert(
    '[3.7] status STRING NOT NULL default=ok',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'ok'/.test(col.block),
  );
}
// reason STRING nullable
{
  const col = columnFor('reason');
  assert(
    '[3.8] reason STRING nullable',
    !!col && /allowNull:\s*true/.test(col.block) && /type:\s*DataType\.STRING/.test(col.block),
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
assert('[3.10] created_at @CreatedAt 装饰', /@CreatedAt\s+@Column\(\{\s*field:\s*'created_at'\s*\}\)/.test(modelSrc));
assert('[3.11] updated_at @UpdatedAt 装饰', /@UpdatedAt\s+@Column\(\{\s*field:\s*'updated_at'\s*\}\)/.test(modelSrc));

// ---- [4] 所有业务列都带 comment -----------------------------------------------
for (const c of columns) {
  if (c.field === 'id') continue;
  if (c.field === 'created_at' || c.field === 'updated_at') continue;
  assert(
    `[4] ${c.field} 含 comment`,
    /comment:\s*['"]/.test(c.block),
    `field=${c.field}`,
  );
}

// ---- [5] PRD US-089 AC: (user_id, date) + text + evidence JSONB -----------
{
  // AC: (user_id, date) 业务唯一
  assert(
    '[5.1] AC: (user_id, date) 业务唯一',
    /unique:\s*true/.test(indexesBlock) &&
      /fields:\s*\[\s*'user_id'\s*,\s*'date'\s*\][\s\S]{0,200}unique:\s*true/.test(indexesBlock),
  );
  // AC: text 字段存在 TEXT
  {
    const col = columnFor('text');
    assert(
      '[5.2] AC: text TEXT',
      !!col && /type:\s*DataType\.TEXT/.test(col.block),
    );
  }
  // AC: evidence JSONB
  {
    const col = columnFor('evidence');
    assert(
      '[5.3] AC: evidence JSONB',
      !!col && /type:\s*DataType\.JSONB/.test(col.block),
    );
  }
}

// ---- [6] META-GUARD: model 已挂到 database.ts + models/index.ts ----------
assert(
  '[6.1] database.ts 含 AIDiaryEntry import',
  /import\s*{\s*AIDiaryEntry\s*}\s*from\s*'\.\.\/models\/AIDiaryEntry';/.test(databaseSrc),
);
assert(
  '[6.2] database.ts models 数组含 AIDiaryEntry',
  /models:\s*\[[\s\S]*AIDiaryEntry[\s\S]*\]/.test(databaseSrc),
);
assert(
  "[6.3] models/index.ts 含 export * from './AIDiaryEntry'",
  /export\s+\*\s+from\s+'\.\/AIDiaryEntry';/.test(indexSrc),
);
assert('[6.4] model 含 PM-018 / US-089 标识', /PM-018|US-089/.test(modelSrc));
assert(
  '[6.5] model 含 tableName: ai_diary_entries',
  /ai_diary_entries/.test(modelSrc),
);
assert(
  '[6.6] model 含 fail-OPEN 注释 (与 DailyAttributionReport 同款 contract)',
  /fail-OPEN/.test(modelSrc),
);

// ---- [7] migration up/down 双 SQL 形态 ------------------------------------
assert('[7.0] migration up 文件存在', existsSync(MIGRATION_UP_PATH));
assert('[7.0] migration down 文件存在', existsSync(MIGRATION_DOWN_PATH));

// up
assert('[7.1] up 含 BEGIN', /BEGIN;/.test(migrationUpSrc));
assert('[7.2] up 含 COMMIT', /COMMIT;/.test(migrationUpSrc));
assert(
  '[7.3] up 含 CREATE TABLE IF NOT EXISTS ai_diary_entries',
  /CREATE TABLE IF NOT EXISTS ai_diary_entries/i.test(migrationUpSrc),
);
assert(
  '[7.4] up 含 user_id NOT NULL',
  /user_id\s+INTEGER\s+NOT NULL/i.test(migrationUpSrc),
);
assert('[7.5] up 含 date NOT NULL', /\bdate\s+DATE\s+NOT NULL/i.test(migrationUpSrc));
assert('[7.6] up 含 text TEXT NOT NULL', /\btext\s+TEXT\s+NOT NULL/i.test(migrationUpSrc));
assert('[7.7] up 含 evidence JSONB NOT NULL', /evidence\s+JSONB\s+NOT NULL/i.test(migrationUpSrc));
assert('[7.8] up 含 source VARCHAR', /source\s+VARCHAR/i.test(migrationUpSrc));
assert('[7.9] up 含 status VARCHAR', /status\s+VARCHAR/i.test(migrationUpSrc));
assert('[7.10] up 含 reason VARCHAR', /reason\s+VARCHAR/i.test(migrationUpSrc));
assert('[7.11] up 含 metadata JSONB NOT NULL', /metadata\s+JSONB\s+NOT NULL/i.test(migrationUpSrc));
assert(
  '[7.12] up 含 generated_at TIMESTAMP NOT NULL',
  /generated_at\s+TIMESTAMP[\s\S]*?NOT NULL/i.test(migrationUpSrc),
);
assert(
  '[7.13] up 含 UNIQUE INDEX ai_diary_entries_user_date_uniq',
  /CREATE UNIQUE INDEX IF NOT EXISTS ai_diary_entries_user_date_uniq[\s\S]*?\(user_id,\s*date\)/i.test(
    migrationUpSrc,
  ),
);
assert(
  '[7.14] up 含 user_id / date / status / source / generated_at 单列索引',
  /idx_ai_diary_entries_user_id/.test(migrationUpSrc) &&
    /idx_ai_diary_entries_date/.test(migrationUpSrc) &&
    /idx_ai_diary_entries_status/.test(migrationUpSrc) &&
    /idx_ai_diary_entries_source/.test(migrationUpSrc) &&
    /idx_ai_diary_entries_generated_at/.test(migrationUpSrc),
);
assert('[7.15] up 含 COMMENT ON TABLE', /COMMENT ON TABLE ai_diary_entries IS/i.test(migrationUpSrc));

// down
assert('[7.20] down 含 BEGIN', /BEGIN;/.test(migrationDownSrc));
assert('[7.21] down 含 COMMIT', /COMMIT;/.test(migrationDownSrc));
assert(
  '[7.22] down 含 DROP TABLE IF EXISTS ai_diary_entries',
  /DROP TABLE IF EXISTS ai_diary_entries/i.test(migrationDownSrc),
);
assert(
  '[7.23] down 含 DROP INDEX IF EXISTS (全 6 个索引)',
  /DROP INDEX IF EXISTS ai_diary_entries_user_date_uniq/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_ai_diary_entries_user_id/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_ai_diary_entries_date/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_ai_diary_entries_status/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_ai_diary_entries_source/i.test(migrationDownSrc) &&
    /DROP INDEX IF EXISTS idx_ai_diary_entries_generated_at/i.test(migrationDownSrc),
);

// ---- summary ---------------------------------------------------------------
console.log(`\nai-diary-entry model: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
