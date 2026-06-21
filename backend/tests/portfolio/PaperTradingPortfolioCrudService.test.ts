/**
 * PaperTradingPortfolioCrudService.test.ts — AT-1 (2026-06-22)
 *
 *   cd backend && npx ts-node --transpile-only tests/portfolio/PaperTradingPortfolioCrudService.test.ts
 *
 * 测试范围:
 *   - 8 个 export 纯函数 (normalizeName / normalizeDescription / normalizeInitialCapital /
 *     normalizeStrategyKeys / normalizeEnabledFactors / normalizeRiskOverrides /
 *     expandStrategyDisplay / expandFactorDisplay / computeReturnPct)
 *   - PortfolioCrudError class shape
 *   - Strategy/Factor registry integration (listAvailableStrategies/Factors 走真实 registry)
 *   - Meta-guard: 校验 8 个 endpoint 都在 controller + routes 里 wire 完整
 *   - Meta-guard: 校验 model 加了 5 个新字段
 *   - Meta-guard: 校验 migration 文件存在 + 含必备 SQL
 *
 * 不接 DB — 业务逻辑层 (create / update / delete / reset) 走 in-process registry
 * 调用, DB 写入路径通过 meta-guard 验证 (与 createBuyTrade-reason.test.ts 同款模式).
 */

import * as fs from 'fs';
import * as path from 'path';

// import 自我注册的因子库, 让 factorRegistry 有数据
require('../../src/quant/factors/library');

import {
  normalizeName,
  normalizeDescription,
  normalizeInitialCapital,
  normalizeStrategyKeys,
  normalizeEnabledFactors,
  normalizeRiskOverrides,
  expandStrategyDisplay,
  expandFactorDisplay,
  computeReturnPct,
  PortfolioCrudError,
  paperTradingPortfolioCrudService,
} from '../../src/portfolio/internal/PaperTradingPortfolioCrudService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function assertThrows(name: string, fn: () => any, codePart = ''): void {
  try {
    fn();
    failed++;
    console.error(`FAIL ${name} — 没抛错, 期望 throw`);
  } catch (err: any) {
    if (codePart && !(err?.code || '').includes(codePart) && !(err?.message || '').includes(codePart)) {
      failed++;
      console.error(`FAIL ${name} — 抛错但 code/message 不含 "${codePart}": ${err?.code} / ${err?.message}`);
      return;
    }
    passed++;
  }
}

const ROOT = path.resolve(__dirname, '../..');

// ---------- [1] normalizeName ----------
function test_normalizeName(): void {
  assert('[1] trim 正常 name', normalizeName('  我的低波动盘  ') === '我的低波动盘');
  assert('[1] 普通 ASCII', normalizeName('test_portfolio') === 'test_portfolio');
  assertThrows('[1] 空 string 抛错', () => normalizeName(''), 'INVALID_NAME');
  assertThrows('[1] 仅空格抛错', () => normalizeName('   '), 'INVALID_NAME');
  assertThrows('[1] null 抛错', () => normalizeName(null), 'INVALID_NAME');
  assertThrows('[1] undefined 抛错', () => normalizeName(undefined), 'INVALID_NAME');
  assertThrows('[1] 超长 (101 字符) 抛错', () => normalizeName('a'.repeat(101)), 'INVALID_NAME');
  assert('[1] 100 字符 OK (边界)', normalizeName('a'.repeat(100)) === 'a'.repeat(100));
}

// ---------- [2] normalizeDescription ----------
function test_normalizeDescription(): void {
  assert('[2] null → null', normalizeDescription(null) === null);
  assert('[2] undefined → null', normalizeDescription(undefined) === null);
  assert('[2] 空 string → null', normalizeDescription('') === null);
  assert('[2] 仅空格 → null', normalizeDescription('   ') === null);
  assert('[2] 正常字符串 trim', normalizeDescription('  测试盘  ') === '测试盘');
  assertThrows('[2] 超长 1001 字符抛错', () => normalizeDescription('a'.repeat(1001)), 'INVALID_DESCRIPTION');
  assert('[2] 1000 字符 OK (边界)', normalizeDescription('a'.repeat(1000)) === 'a'.repeat(1000));
}

// ---------- [3] normalizeInitialCapital ----------
function test_normalizeInitialCapital(): void {
  assert('[3] 10000 OK (下界)', normalizeInitialCapital(10000) === 10000);
  assert('[3] 100000000 OK (上界)', normalizeInitialCapital(100000000) === 100000000);
  assert('[3] 200000 OK', normalizeInitialCapital(200000) === 200000);
  assert('[3] 浮点保留 2 位', normalizeInitialCapital(50000.567) === 50000.57);
  assert('[3] string 数字 OK', normalizeInitialCapital('50000') === 50000);
  assertThrows('[3] 9999 抛错', () => normalizeInitialCapital(9999), 'INVALID_INITIAL_CAPITAL');
  assertThrows('[3] 100000001 抛错', () => normalizeInitialCapital(100000001), 'INVALID_INITIAL_CAPITAL');
  assertThrows('[3] NaN 抛错', () => normalizeInitialCapital(NaN), 'INVALID_INITIAL_CAPITAL');
  assertThrows('[3] string 非数字抛错', () => normalizeInitialCapital('abc'), 'INVALID_INITIAL_CAPITAL');
  assertThrows('[3] 负数抛错', () => normalizeInitialCapital(-1000), 'INVALID_INITIAL_CAPITAL');
}

// ---------- [4] normalizeStrategyKeys ----------
function test_normalizeStrategyKeys(): void {
  assert('[4] undefined → []', JSON.stringify(normalizeStrategyKeys(undefined)) === '[]');
  assert('[4] null → []', JSON.stringify(normalizeStrategyKeys(null)) === '[]');
  assert('[4] [] → []', JSON.stringify(normalizeStrategyKeys([])) === '[]');
  // 真实的策略 key (从 StrategyRegistry 拉)
  const valid = normalizeStrategyKeys(['multi_factor_alpha', 'dragon_head_momentum']);
  assert('[4] 2 个有效 key OK', valid.length === 2 && valid[0] === 'multi_factor_alpha');
  // 去重
  const dedup = normalizeStrategyKeys(['multi_factor_alpha', 'multi_factor_alpha']);
  assert('[4] 同 key 去重', dedup.length === 1);
  // 空值过滤
  const trimmed = normalizeStrategyKeys(['multi_factor_alpha', '', '  ', null]);
  assert('[4] 空 / null / 空格过滤', trimmed.length === 1);
  // 未知 key 抛
  assertThrows(
    '[4] 未知 key 抛错',
    () => normalizeStrategyKeys(['nonexistent_strategy_xyz']),
    'INVALID_STRATEGY_KEYS'
  );
  // 非数组抛错
  assertThrows('[4] string 抛错', () => normalizeStrategyKeys('multi_factor_alpha'), 'INVALID_STRATEGY_KEYS');
  assertThrows('[4] object 抛错', () => normalizeStrategyKeys({}), 'INVALID_STRATEGY_KEYS');
}

// ---------- [5] normalizeEnabledFactors ----------
function test_normalizeEnabledFactors(): void {
  assert('[5] undefined → []', JSON.stringify(normalizeEnabledFactors(undefined)) === '[]');
  assert('[5] [] → []', JSON.stringify(normalizeEnabledFactors([])) === '[]');
  // 真实的因子 name
  const valid = normalizeEnabledFactors(['value', 'momentum']);
  assert('[5] 2 个有效 factor OK', valid.length === 2);
  // 去重
  const dedup = normalizeEnabledFactors(['value', 'value']);
  assert('[5] 同 factor 去重', dedup.length === 1);
  // 未知抛错
  assertThrows(
    '[5] 未知 factor 抛错',
    () => normalizeEnabledFactors(['nonexistent_factor_xyz']),
    'INVALID_ENABLED_FACTORS'
  );
  assertThrows('[5] string 抛错', () => normalizeEnabledFactors('value'), 'INVALID_ENABLED_FACTORS');
}

// ---------- [6] normalizeRiskOverrides ----------
function test_normalizeRiskOverrides(): void {
  assert('[6] undefined → {}', JSON.stringify(normalizeRiskOverrides(undefined)) === '{}');
  assert('[6] null → {}', JSON.stringify(normalizeRiskOverrides(null)) === '{}');
  const out = normalizeRiskOverrides({ stop_loss_pct: 0.05, max_pos_pct: 0.15 });
  assert('[6] plain obj 透传', (out as any).stop_loss_pct === 0.05);
  assertThrows('[6] array 抛错', () => normalizeRiskOverrides([1, 2, 3]), 'INVALID_RISK_OVERRIDES');
  assertThrows('[6] string 抛错', () => normalizeRiskOverrides('foo'), 'INVALID_RISK_OVERRIDES');
}

// ---------- [7] expand display ----------
function test_expandDisplay(): void {
  const sd = expandStrategyDisplay(['multi_factor_alpha']);
  assert('[7] strategy_display 含中文', sd.length === 1 && sd[0].length > 0);
  const sd2 = expandStrategyDisplay(['unknown_xyz']);
  assert('[7] 未知 strategy 显示原 key', sd2[0] === 'unknown_xyz');
  const fd = expandFactorDisplay(['value']);
  assert('[7] factor_display 含描述', fd.length === 1 && fd[0].length > 0);
  const fd2 = expandFactorDisplay(['unknown_xyz']);
  assert('[7] 未知 factor 显示原 key', fd2[0] === 'unknown_xyz');
}

// ---------- [8] computeReturnPct ----------
function test_computeReturnPct(): void {
  assert('[8] baseline null → null', computeReturnPct(105000, null, 100000) === null);
  assert('[8] initial=0 → null', computeReturnPct(105000, 100000, 0) === null);
  assert('[8] initial 负 → null', computeReturnPct(105000, 100000, -1) === null);
  // (105000 - 100000) / 100000 = 5%
  assert('[8] +5% 收益', computeReturnPct(105000, 100000, 100000) === 5);
  // (95000 - 100000) / 100000 = -5%
  assert('[8] -5% 收益', computeReturnPct(95000, 100000, 100000) === -5);
  // 浮点保 2 位
  const r = computeReturnPct(100123.45, 100000, 100000);
  assert('[8] 浮点保 2 位 (0.12)', r === 0.12);
  // 0 baseline 不视为 null (baseline 可能是亏到 0 的真实数据 — 但这种边界 caller 自己处理)
  // ⚠️ 当前实现 baseline=0 也返回 (currentTotal - 0) / initial; 测一下:
  assert('[8] baseline=0 时正常计算', computeReturnPct(50000, 0, 100000) === 50);
}

// ---------- [9] PortfolioCrudError class ----------
function test_errorClass(): void {
  const e1 = new PortfolioCrudError('abc');
  assert('[9] 默认 statusCode=400', e1.statusCode === 400);
  assert('[9] 默认 code', e1.code === 'PORTFOLIO_CRUD_ERROR');
  const e2 = new PortfolioCrudError('not found', { statusCode: 404, code: 'NOT_FOUND' });
  assert('[9] 自定义 statusCode', e2.statusCode === 404);
  assert('[9] 自定义 code', e2.code === 'NOT_FOUND');
  assert('[9] instanceof Error', e2 instanceof Error);
}

// ---------- [10] listAvailableStrategies / Factors ----------
function test_listAvailable(): void {
  const strategies = paperTradingPortfolioCrudService.listAvailableStrategies();
  assert('[10] strategies 至少 20 个', strategies.length >= 20);
  assert('[10] strategy 含 strategy_key', strategies[0].strategy_key.length > 0);
  assert('[10] strategy 含 name', strategies[0].name.length > 0);
  const factors = paperTradingPortfolioCrudService.listAvailableFactors();
  assert('[10] factors 至少 15 个', factors.length >= 15);
  assert('[10] factor 含 name', factors[0].name.length > 0);
  assert('[10] factor 含 description', factors[0].description.length > 0);
}

// ---------- [11] Meta-guard: controller wire-in ----------
function test_meta_controller_routes(): void {
  const ctrl = fs.readFileSync(
    path.join(ROOT, 'src/api/controllers/PaperTradingController.ts'),
    'utf8'
  );
  const REQUIRED_METHODS = [
    'getPortfolioDetail',
    'createPortfolio',
    'updatePortfolio',
    'deletePortfolio',
    'resetPortfolio',
    'listAvailableStrategies',
    'listAvailableFactors',
  ];
  for (const m of REQUIRED_METHODS) {
    assert(`[11] controller has ${m}`, new RegExp(`\\b${m}\\s*=\\s*async`).test(ctrl));
  }
  assert(
    '[11] controller import paperTradingPortfolioCrudService',
    /import\s*\{\s*paperTradingPortfolioCrudService\s*\}/.test(ctrl)
  );
  // 资金字段防御
  assert(
    '[11] updatePortfolio 拒绝 initial_capital',
    /initial_capital.*current_cash.*total_value/.test(ctrl)
  );

  const routes = fs.readFileSync(path.join(ROOT, 'src/api/routes/paperTrading.routes.ts'), 'utf8');
  // Express routes 可能单行或多行 (prettier 决定); 用 regex 验证关键字段
  const REQUIRED_ROUTES = [
    /router\.post\s*\(\s*['"]\/portfolios['"]/,
    /router\.get\s*\(\s*\n?\s*['"]\/portfolios\/:id['"]/,
    /router\.put\s*\(\s*\n?\s*['"]\/portfolios\/:id['"]/,
    /router\.delete\s*\(\s*\n?\s*['"]\/portfolios\/:id['"]/,
    /router\.post\s*\(\s*\n?\s*['"]\/portfolios\/:id\/reset['"]/,
    /router\.get\s*\(\s*\n?\s*['"]\/strategies\/available['"]/,
    /router\.get\s*\(\s*\n?\s*['"]\/factors\/available['"]/,
  ];
  for (const re of REQUIRED_ROUTES) {
    assert(`[11] route registered ${re.toString().slice(0, 60)}…`, re.test(routes));
  }
}

// ---------- [12] Meta-guard: model fields ----------
function test_meta_model(): void {
  const model = fs.readFileSync(path.join(ROOT, 'src/models/PaperTradingPortfolio.ts'), 'utf8');
  const REQUIRED_FIELDS = [
    "declare description: string | null",
    "declare strategy_keys: string[]",
    "declare enabled_factors: string[]",
    "declare risk_profile_overrides: Record<string, unknown>",
    "declare auto_trade_enabled: boolean",
  ];
  for (const f of REQUIRED_FIELDS) {
    assert(`[12] model has ${f}`, model.includes(f));
  }
  assert(
    '[12] model strategy_keys JSONB defaults []',
    /strategy_keys[\s\S]{0,300}defaultValue:\s*\[\]/.test(model)
  );
  assert(
    '[12] model auto_trade_enabled defaults false',
    /defaultValue:\s*false,[\s\S]{0,200}auto_trade_enabled/.test(model)
  );
}

// ---------- [13] Meta-guard: migration files ----------
function test_meta_migration(): void {
  const upPath = path.join(
    ROOT,
    'scripts/migrations/2026-06-22-paper-trading-portfolio-strategy-fields.sql'
  );
  const downPath = path.join(
    ROOT,
    'scripts/migrations/2026-06-22-paper-trading-portfolio-strategy-fields-rollback.sql'
  );
  assert('[13] up migration exists', fs.existsSync(upPath));
  assert('[13] down migration exists', fs.existsSync(downPath));
  const up = fs.readFileSync(upPath, 'utf8');
  assert('[13] up adds description col', /ADD COLUMN IF NOT EXISTS description/i.test(up));
  assert('[13] up adds strategy_keys col', /ADD COLUMN IF NOT EXISTS strategy_keys JSONB/i.test(up));
  assert('[13] up adds enabled_factors col', /ADD COLUMN IF NOT EXISTS enabled_factors JSONB/i.test(up));
  assert('[13] up adds risk_profile_overrides col', /ADD COLUMN IF NOT EXISTS risk_profile_overrides JSONB/i.test(up));
  assert(
    '[13] up adds auto_trade_enabled col (default false)',
    /ADD COLUMN IF NOT EXISTS auto_trade_enabled BOOLEAN[\s\S]*NOT NULL[\s\S]*DEFAULT false/i.test(up)
  );
  assert('[13] up wraps in BEGIN/COMMIT', /BEGIN;[\s\S]+COMMIT;/.test(up));
  assert('[13] up creates auto_trade index', /idx_paper_trading_portfolios_auto_trade/.test(up));
  const down = fs.readFileSync(downPath, 'utf8');
  assert('[13] down drops all 5 cols', /DROP COLUMN IF EXISTS auto_trade_enabled[\s\S]*description/i.test(down));
  // Admin keep-on SQL
  const adminPath = path.join(ROOT, 'scripts/migrations/2026-06-22-admin-keep-auto-trade.sql');
  assert('[13] admin keep-on SQL exists', fs.existsSync(adminPath));
  const admin = fs.readFileSync(adminPath, 'utf8');
  assert(
    '[13] admin SQL targets user_id=4',
    /UPDATE paper_trading_portfolios[\s\S]*auto_trade_enabled = true[\s\S]*user_id = 4/i.test(admin)
  );
}

// ---------- [14] Meta-guard: automation gate ----------
function test_meta_automation_gate(): void {
  const auto = fs.readFileSync(
    path.join(ROOT, 'src/portfolio/internal/PaperTradingAutomationService.ts'),
    'utf8'
  );
  // runAutoSync 方法体内必须含 auto_trade_enabled 判定
  const runAutoSyncMatch = auto.match(/async\s+runAutoSync\s*\([\s\S]*?\n  \}/);
  assert('[14] runAutoSync 方法可定位', !!runAutoSyncMatch);
  if (runAutoSyncMatch) {
    const body = runAutoSyncMatch[0];
    assert(
      '[14] runAutoSync 含 auto_trade_enabled !== true 判定',
      /auto_trade_enabled\s*!==\s*true/.test(body)
    );
    assert(
      '[14] runAutoSync 含 dry_run / bypass_auto_trade_gate 例外',
      /bypass_auto_trade_gate/.test(body) && /dry_run/.test(body)
    );
    assert(
      '[14] runAutoSync gate hit 时 return 跳过',
      /AUTO_TRADE_GATE/.test(body)
    );
  }
}

// ============================================================
(async () => {
  console.log('# PaperTradingPortfolioCrudService.test.ts (AT-1)');
  console.log('## [1] normalizeName');
  test_normalizeName();
  console.log('## [2] normalizeDescription');
  test_normalizeDescription();
  console.log('## [3] normalizeInitialCapital');
  test_normalizeInitialCapital();
  console.log('## [4] normalizeStrategyKeys');
  test_normalizeStrategyKeys();
  console.log('## [5] normalizeEnabledFactors');
  test_normalizeEnabledFactors();
  console.log('## [6] normalizeRiskOverrides');
  test_normalizeRiskOverrides();
  console.log('## [7] expand display');
  test_expandDisplay();
  console.log('## [8] computeReturnPct');
  test_computeReturnPct();
  console.log('## [9] PortfolioCrudError');
  test_errorClass();
  console.log('## [10] listAvailableStrategies / Factors');
  test_listAvailable();
  console.log('## [11] Meta-guard: controller + routes');
  test_meta_controller_routes();
  console.log('## [12] Meta-guard: model fields');
  test_meta_model();
  console.log('## [13] Meta-guard: migration files');
  test_meta_migration();
  console.log('## [14] Meta-guard: automation gate');
  test_meta_automation_gate();

  console.log(`\n# summary: ${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
