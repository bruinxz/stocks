/**
 * DailyAttributionReport model 单元测试 (US-080 [PM-003]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/models/daily-attribution-report.test.ts
 *
 * 本 story (PM-003) 只新增 model schema — 真持久化 (upsert / read) 由后续
 * PM-006 (cron) / PM-007 (route) 接入. 因此测试聚焦:
 *   - schema 字段与 PRD US-080 AC ((date, portfolio_id), breakdown JSONB, ai_summary TEXT) 对齐
 *   - JSONB 字段类型签名 + 默认值
 *   - 索引含 (portfolio_id, date) UNIQUE — idempotent upsert 不变量
 *   - 与 DailyAttributionService.DailyAttributionReport 业务类型可兼容映射 (字段一一对得上)
 *   - META-GUARD: model 已挂 database.ts + models/index.ts (与 BenchmarkAttributionResult /
 *     IndustryAttributionResult 同款两处必挂模式)
 *
 * 实现笔记: sequelize-typescript 的 model class 必须 addModels 后才能调用
 * Model.getAttributes(); 但本仓库的 backend tests 全程 DB-less + 不依赖 jest +
 * 不连真 sequelize singleton (避免 ts-node 子进程跨文件污染). 因此采用本仓库
 * 一贯的 fs+regex META-GUARD 模式直接对源文件断言 schema, 与 cron-registry /
 * portfolio-construction-adapter 测试中 "源文件正则扫" 同款.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const MODEL_PATH = join(ROOT, 'src/models/DailyAttributionReport.ts');
const DATABASE_PATH = join(ROOT, 'src/config/database.ts');
const INDEX_PATH = join(ROOT, 'src/models/index.ts');
const SERVICE_PATH = join(ROOT, 'src/services/attribution/DailyAttributionService.ts');

const modelSrc = readFileSync(MODEL_PATH, 'utf8');
const databaseSrc = readFileSync(DATABASE_PATH, 'utf8');
const indexSrc = readFileSync(INDEX_PATH, 'utf8');
const serviceSrc = readFileSync(SERVICE_PATH, 'utf8');

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
 * 返回 [block, field_name] 元组数组. 用于把字段定义切片做正则扫.
 */
function listColumnDeclarations(src: string): Array<{ block: string; field: string }> {
  // 简化版: 找 declare <ident>...; 前面最近的 @Column({...}) 块
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
assert('[1.1] tableName = daily_attribution_reports', /tableName:\s*'daily_attribution_reports'/.test(modelSrc));
assert('[1.2] underscored=true', /underscored:\s*true/.test(modelSrc));
assert('[1.3] timestamps=true', /timestamps:\s*true/.test(modelSrc));

// ---- [2] 索引 --------------------------------------------------------------
// 整段 indexes:[...] 抽出来一次性扫. 注意 indexes 内含嵌套对象 `{ fields: [...] }`,
// 用 lazy `[\s\S]*?` 配 `],` 终止会切到第一个内部 `},`. 这里用 @Table({ 开头到下一个 `})` 锁定.
const tableMatch = modelSrc.match(/@Table\(\{([\s\S]*?)\}\)/m);
const tableBlock = tableMatch ? tableMatch[1] : '';
const indexesMatch = tableBlock.match(/indexes:\s*\[([\s\S]*)\][,\s]*$/m);
const indexesBlock = indexesMatch ? indexesMatch[1] : '';
assert('[2.0] indexes 数组存在', indexesBlock.length > 0);

assert(
  '[2.1] 含 (portfolio_id, date) UNIQUE 复合索引',
  /fields:\s*\[\s*'portfolio_id'\s*,\s*'date'\s*\]/.test(indexesBlock) &&
    /name:\s*'daily_attribution_reports_portfolio_date_uniq'/.test(indexesBlock) &&
    /unique:\s*true/.test(indexesBlock),
);
assert("[2.2] 含 portfolio_id 单列索引", /\{\s*fields:\s*\[\s*'portfolio_id'\s*\]\s*\}/m.test(indexesBlock));
assert("[2.3] 含 date 单列索引", /\{\s*fields:\s*\[\s*'date'\s*\]\s*\}/m.test(indexesBlock));
assert("[2.4] 含 status 单列索引", /\{\s*fields:\s*\[\s*'status'\s*\]\s*\}/m.test(indexesBlock));
assert(
  "[2.5] 含 generated_at 单列索引",
  /\{\s*fields:\s*\[\s*'generated_at'\s*\]\s*\}/m.test(indexesBlock),
);

// ---- [3] 列定义 sanity ------------------------------------------------------
const columns = listColumnDeclarations(modelSrc);
const allColumnNames = new Set(columns.map(c => c.field));

// 必须存在的字段全清单
const requiredCols = [
  'portfolio_id',
  'date',
  'total_pnl',
  'total_pnl_pct',
  'realized_pnl',
  'unrealized_delta',
  'trade_count',
  'buy_count',
  'sell_count',
  'breakdown',
  'best_trades',
  'worst_trades',
  'ai_summary',
  'bias_findings',
  'recommendations',
  'status',
  'reason',
  'metadata',
  'generated_at',
  'source',
  'created_at',
  'updated_at',
];
for (const c of requiredCols) {
  assert(`[3.col] ${c} 列存在`, allColumnNames.has(c));
}

// portfolio_id INTEGER NOT NULL
{
  const col = columnFor('portfolio_id');
  assert(
    '[3.1] portfolio_id INTEGER NOT NULL',
    !!col &&
      /type:\s*DataType\.INTEGER/.test(col.block) &&
      /allowNull:\s*false/.test(col.block),
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
// total_pnl DECIMAL NOT NULL default 0
{
  const col = columnFor('total_pnl');
  assert(
    '[3.3] total_pnl DECIMAL NOT NULL default 0',
    !!col &&
      /type:\s*DataType\.DECIMAL/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*0/.test(col.block),
  );
}
// total_pnl_pct DECIMAL nullable
{
  const col = columnFor('total_pnl_pct');
  assert(
    '[3.4] total_pnl_pct nullable',
    !!col && /allowNull:\s*true/.test(col.block) && /type:\s*DataType\.DECIMAL/.test(col.block),
  );
}
// 计数字段
for (const n of ['trade_count', 'buy_count', 'sell_count']) {
  const col = columnFor(n);
  assert(
    `[3.5] ${n} INTEGER NOT NULL default=0`,
    !!col &&
      /type:\s*DataType\.INTEGER/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*0/.test(col.block),
  );
}
// JSONB object 字段
for (const n of ['breakdown', 'metadata']) {
  const col = columnFor(n);
  assert(
    `[3.6] ${n} JSONB NOT NULL default={}`,
    !!col &&
      /type:\s*DataType\.JSONB/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*\{\}/.test(col.block),
  );
}
// JSONB array 字段
for (const n of ['best_trades', 'worst_trades', 'bias_findings', 'recommendations']) {
  const col = columnFor(n);
  assert(
    `[3.7] ${n} JSONB NOT NULL default=[]`,
    !!col &&
      /type:\s*DataType\.JSONB/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*\[\]/.test(col.block),
  );
}
// ai_summary TEXT
{
  const col = columnFor('ai_summary');
  assert(
    '[3.8] ai_summary TEXT NOT NULL default=""',
    !!col &&
      /type:\s*DataType\.TEXT/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*''/.test(col.block),
  );
}
// status default=ok
{
  const col = columnFor('status');
  assert(
    '[3.9] status STRING NOT NULL default=ok',
    !!col &&
      /type:\s*DataType\.STRING/.test(col.block) &&
      /allowNull:\s*false/.test(col.block) &&
      /defaultValue:\s*'ok'/.test(col.block),
  );
}
// reason nullable
{
  const col = columnFor('reason');
  assert(
    '[3.10] reason STRING nullable',
    !!col && /allowNull:\s*true/.test(col.block) && /type:\s*DataType\.STRING/.test(col.block),
  );
}
// generated_at DATE NOT NULL
{
  const col = columnFor('generated_at');
  assert(
    '[3.11] generated_at DATE NOT NULL',
    !!col && /type:\s*DataType\.DATE/.test(col.block) && /allowNull:\s*false/.test(col.block),
  );
}
// source default
{
  const col = columnFor('source');
  assert(
    '[3.12] source default=daily_attribution_service',
    !!col && /defaultValue:\s*'daily_attribution_service'/.test(col.block),
  );
}
// 自动管理时间戳列由 @CreatedAt / @UpdatedAt 装饰
assert('[3.13] created_at @CreatedAt 装饰', /@CreatedAt\s+@Column\(\{\s*field:\s*'created_at'\s*\}\)/.test(modelSrc));
assert('[3.14] updated_at @UpdatedAt 装饰', /@UpdatedAt\s+@Column\(\{\s*field:\s*'updated_at'\s*\}\)/.test(modelSrc));

// ---- [4] 所有业务列都带 comment (运维 / DB 文档刷新时一眼看懂; 时间戳列由装饰器管) -----
for (const c of columns) {
  if (c.field === 'id') continue; // PK 不强制
  if (c.field === 'created_at' || c.field === 'updated_at') continue; // 装饰器管, 无须 comment
  assert(
    `[4] ${c.field} 含 comment`,
    /comment:\s*['"]/.test(c.block),
    `field=${c.field}`,
  );
}

// ---- [5] PRD US-080 AC: (date, portfolio_id) + breakdown JSONB + ai_summary TEXT ---
{
  // AC §E.1: 必须有 (portfolio_id, date) 业务唯一
  assert(
    '[5.1] AC: (portfolio_id, date) 业务唯一',
    /unique:\s*true/.test(indexesBlock) &&
      /fields:\s*\[\s*'portfolio_id'\s*,\s*'date'\s*\][\s\S]{0,200}unique:\s*true/.test(indexesBlock),
  );
  // AC §E.2: breakdown JSONB
  {
    const col = columnFor('breakdown');
    assert(
      '[5.2] AC: breakdown JSONB',
      !!col && /type:\s*DataType\.JSONB/.test(col.block),
    );
  }
  // AC §E.3: ai_summary TEXT
  {
    const col = columnFor('ai_summary');
    assert('[5.3] AC: ai_summary TEXT', !!col && /type:\s*DataType\.TEXT/.test(col.block));
  }
}

// ---- [6] 与 DailyAttributionService.DailyAttributionReport 业务类型对得上 -
// service 端的字段全集 (PM-001 已 freeze) — model 不必逐个但关键 7 字段必齐.
const serviceInterfaceFields = [
  'date',
  'portfolio_id',
  'total_pnl',
  'total_pnl_pct',
  'realized_pnl',
  'unrealized_delta',
  'trade_count',
  'buy_count',
  'sell_count',
  'breakdown',
  'best_trades',
  'worst_trades',
  'ai_summary',
  'bias_findings',
  'recommendations',
  'generated_at',
];
for (const f of serviceInterfaceFields) {
  assert(
    `[6] service 字段 ${f} 在 model 中存在`,
    allColumnNames.has(f),
    `missing ${f} in model`,
  );
}
// 反向: service 端导出的 interface 名要稳定 (避免 PM-006 cron 编译期断)
assert(
  '[6.x] service 含 export interface DailyAttributionReport',
  /export\s+interface\s+DailyAttributionReport/.test(serviceSrc),
);

// ---- [7] META-GUARD: model 已挂到 database.ts + models/index.ts ----------
assert(
  '[7.1] database.ts 含 DailyAttributionReport import',
  /import\s*{\s*DailyAttributionReport\s*}\s*from\s*'\.\.\/models\/DailyAttributionReport';/.test(
    databaseSrc,
  ),
);
assert(
  '[7.2] database.ts models 数组含 DailyAttributionReport',
  /models:\s*\[[\s\S]*DailyAttributionReport[\s\S]*\]/.test(databaseSrc),
);
assert(
  "[7.3] models/index.ts 含 export * from './DailyAttributionReport'",
  /export\s+\*\s+from\s+'\.\/DailyAttributionReport';/.test(indexSrc),
);
assert('[7.4] model 含 PM-003 / US-080 标识', /PM-003|US-080/.test(modelSrc));
assert(
  '[7.5] model 含 tableName: daily_attribution_reports',
  /daily_attribution_reports/.test(modelSrc),
);
assert(
  '[7.6] model 含 fail-OPEN 注释 (与 service 端 contract 一致)',
  /fail-OPEN/.test(modelSrc),
);
assert(
  '[7.7] model 与 BenchmarkAttribution / IndustryAttribution 同款 4-tuple 范式注释或 strategy_key 差异说明',
  /BenchmarkAttributionResult|IndustryAttributionResult/.test(modelSrc),
);

// ---- summary ---------------------------------------------------------------
console.log(`\ndaily-attribution-report model: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
