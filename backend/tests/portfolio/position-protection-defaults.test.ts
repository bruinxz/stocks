/**
 * CB-1 positionProtectionDefaults 单元测试 (2026/06/25)
 *
 * 不依赖 jest / DB / network. 跑:
 *   cd backend && npx ts-node --transpile-only tests/portfolio/position-protection-defaults.test.ts
 *
 * 覆盖维度:
 *   - normalizeStopLossPercent: 5/10/50/0/NaN/string/null/undefined/超 50
 *   - normalizeTakeProfitPercent: 5/10/200/0/NaN/string/null/超 200
 *   - deriveProtectionPrices: 完整 config / 缺 config / avg_cost 边界 / 价格小数位
 *   - meta-test (fs+regex): facade + automation 两处 PaperTradingPosition.create 必含
 *     stop_loss_price + take_profit_price 字段, 防止后续 refactor 把字段写丢
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  normalizeStopLossPercent,
  normalizeTakeProfitPercent,
  deriveProtectionPrices,
  DEFAULT_STOP_LOSS_PERCENT,
  DEFAULT_TAKE_PROFIT_PERCENT,
} from '../../src/portfolio/internal/positionProtectionDefaults';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function expectClose(name: string, actual: number, expected: number, eps = 1e-4) {
  assert(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) < eps,
    `expected≈${expected} got=${actual}`
  );
}

// ===== normalizeStopLossPercent =====
console.log('## normalizeStopLossPercent');
assert('5 → 5', normalizeStopLossPercent(5) === 5);
assert('10 → 10', normalizeStopLossPercent(10) === 10);
assert('50 边界 → 50', normalizeStopLossPercent(50) === 50);
assert('0 → 默认 5', normalizeStopLossPercent(0) === DEFAULT_STOP_LOSS_PERCENT);
assert('负数 → 默认 5', normalizeStopLossPercent(-3) === DEFAULT_STOP_LOSS_PERCENT);
assert('NaN → 默认 5', normalizeStopLossPercent(NaN) === DEFAULT_STOP_LOSS_PERCENT);
assert('string "5" → 5', normalizeStopLossPercent('5') === 5);
assert('string "abc" → 默认 5', normalizeStopLossPercent('abc') === DEFAULT_STOP_LOSS_PERCENT);
assert('null → 默认 5', normalizeStopLossPercent(null) === DEFAULT_STOP_LOSS_PERCENT);
assert('undefined → 默认 5', normalizeStopLossPercent(undefined) === DEFAULT_STOP_LOSS_PERCENT);
assert('超 50 (60) → 默认 5', normalizeStopLossPercent(60) === DEFAULT_STOP_LOSS_PERCENT);

// ===== normalizeTakeProfitPercent =====
console.log('## normalizeTakeProfitPercent');
assert('10 → 10', normalizeTakeProfitPercent(10) === 10);
assert('100 → 100', normalizeTakeProfitPercent(100) === 100);
assert('200 边界 → 200', normalizeTakeProfitPercent(200) === 200);
assert('超 200 → 默认 10', normalizeTakeProfitPercent(300) === DEFAULT_TAKE_PROFIT_PERCENT);
assert('0 → 默认 10', normalizeTakeProfitPercent(0) === DEFAULT_TAKE_PROFIT_PERCENT);
assert('NaN → 默认 10', normalizeTakeProfitPercent(NaN) === DEFAULT_TAKE_PROFIT_PERCENT);
assert('null → 默认 10', normalizeTakeProfitPercent(null) === DEFAULT_TAKE_PROFIT_PERCENT);
assert('"15" → 15', normalizeTakeProfitPercent('15') === 15);

// ===== deriveProtectionPrices =====
console.log('## deriveProtectionPrices');

const r1 = deriveProtectionPrices(100, { stop_loss_percent: 5, take_profit_percent: 10 });
expectClose('avg_cost=100, sl=5 → 95', r1.stop_loss_price as number, 95);
expectClose('avg_cost=100, tp=10 → 110', r1.take_profit_price as number, 110);
assert('返回 sl=5%', r1.stop_loss_percent === 5);
assert('返回 tp=10%', r1.take_profit_percent === 10);

const r2 = deriveProtectionPrices(100, undefined);
expectClose('avg_cost=100, 缺 config → 默认 sl 95', r2.stop_loss_price as number, 95);
expectClose('avg_cost=100, 缺 config → 默认 tp 110', r2.take_profit_price as number, 110);

const r3 = deriveProtectionPrices(100, { stop_loss_percent: 7, take_profit_percent: 20 });
expectClose('avg_cost=100, sl=7 → 93', r3.stop_loss_price as number, 93);
expectClose('avg_cost=100, tp=20 → 120', r3.take_profit_price as number, 120);

// avg_cost 边界
const r4 = deriveProtectionPrices(0, { stop_loss_percent: 5, take_profit_percent: 10 });
assert('avg_cost=0 → stop_loss_price null', r4.stop_loss_price === null);
assert('avg_cost=0 → take_profit_price null', r4.take_profit_price === null);

const r5 = deriveProtectionPrices(-10, { stop_loss_percent: 5, take_profit_percent: 10 });
assert('avg_cost<0 → stop_loss_price null', r5.stop_loss_price === null);
assert('avg_cost<0 → take_profit_price null', r5.take_profit_price === null);

const r6 = deriveProtectionPrices(NaN, { stop_loss_percent: 5, take_profit_percent: 10 });
assert('avg_cost=NaN → stop_loss_price null', r6.stop_loss_price === null);

const r7 = deriveProtectionPrices(null, { stop_loss_percent: 5, take_profit_percent: 10 });
assert('avg_cost=null → stop_loss_price null', r7.stop_loss_price === null);

// 小数位 toFixed(4)
const r8 = deriveProtectionPrices(12.345, { stop_loss_percent: 5, take_profit_percent: 10 });
expectClose('avg_cost=12.345, sl=5 → 11.7278', r8.stop_loss_price as number, 11.7278);

// 非法 risk_config 字段 fallback to defaults
const r9 = deriveProtectionPrices(100, {
  stop_loss_percent: 'bogus' as any,
  take_profit_percent: -50 as any,
});
expectClose('非法字段 sl → 95 (默认 5%)', r9.stop_loss_price as number, 95);
expectClose('非法字段 tp → 110 (默认 10%)', r9.take_profit_price as number, 110);

// 极端 stop_loss = 50% (合法边界)
const r10 = deriveProtectionPrices(100, { stop_loss_percent: 50, take_profit_percent: 200 });
expectClose('50% stop_loss → 50', r10.stop_loss_price as number, 50);
expectClose('200% take_profit → 300', r10.take_profit_price as number, 300);

// ===== META-TEST: facade / automation 两处必含 stop_loss_price / take_profit_price 字段 =====
console.log('## META-TEST: PaperTradingPosition.create 必含 stop_loss_price + take_profit_price');
const ROOT = path.resolve(__dirname, '../../');
const facadeSrc = fs.readFileSync(path.join(ROOT, 'src/portfolio/PaperTradingFacade.ts'), 'utf-8');
const automationSrc = fs.readFileSync(
  path.join(ROOT, 'src/portfolio/internal/PaperTradingAutomationService.ts'),
  'utf-8'
);

// facade 必须 import loadProtectionPricesForUser
assert(
  'facade import loadProtectionPricesForUser',
  /loadProtectionPricesForUser/.test(facadeSrc),
  '没在 PaperTradingFacade.ts import loadProtectionPricesForUser'
);

// facade 必须在 BUY 新仓位分支 call loadProtectionPricesForUser
assert(
  'facade call loadProtectionPricesForUser(user_id, execute_price)',
  /loadProtectionPricesForUser\(user_id,\s*execute_price\)/.test(facadeSrc),
  'PaperTradingFacade.ts BUY 新仓位分支没 call loadProtectionPricesForUser(user_id, execute_price)'
);

// facade BUY create 必含 stop_loss_price / take_profit_price 字段 (用 protection.xxx)
assert(
  'facade Position.create 含 stop_loss_price: protection.stop_loss_price',
  /stop_loss_price:\s*protection\.stop_loss_price/.test(facadeSrc),
  'PaperTradingFacade.ts BUY 新仓位 Position.create 没写 stop_loss_price: protection.stop_loss_price'
);
assert(
  'facade Position.create 含 take_profit_price: protection.take_profit_price',
  /take_profit_price:\s*protection\.take_profit_price/.test(facadeSrc),
  'PaperTradingFacade.ts BUY 新仓位 Position.create 没写 take_profit_price: protection.take_profit_price'
);

// automation 必须 import loadProtectionPricesForUser
assert(
  'automation import loadProtectionPricesForUser',
  /loadProtectionPricesForUser/.test(automationSrc),
  '没在 PaperTradingAutomationService.ts import loadProtectionPricesForUser'
);
assert(
  'automation call loadProtectionPricesForUser(portfolio.user_id, execute_price)',
  /loadProtectionPricesForUser\(portfolio\.user_id,\s*execute_price\)/.test(automationSrc),
  'PaperTradingAutomationService.ts createBuyTrade 没 call loadProtectionPricesForUser(portfolio.user_id, execute_price)'
);
assert(
  'automation Position.create 含 stop_loss_price: protection.stop_loss_price',
  /stop_loss_price:\s*protection\.stop_loss_price/.test(automationSrc),
  'PaperTradingAutomationService.ts createBuyTrade Position.create 没写 stop_loss_price'
);
assert(
  'automation Position.create 含 take_profit_price: protection.take_profit_price',
  /take_profit_price:\s*protection\.take_profit_price/.test(automationSrc),
  'PaperTradingAutomationService.ts createBuyTrade Position.create 没写 take_profit_price'
);

console.log(`\n# summary: ${passed} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
