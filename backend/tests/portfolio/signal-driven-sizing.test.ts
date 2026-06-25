/**
 * CB-2 SignalDrivenSizing 单元测试 (2026/06/25)
 *
 *   cd backend && npx ts-node --transpile-only tests/portfolio/signal-driven-sizing.test.ts
 *
 * 覆盖:
 *   - normalizeConfidence: 0-1 / 0-100 兼容 / 负数 / NaN / null
 *   - deriveTargetPctFromConfidence: 4 档边界 (0.79/0.80/0.59/0.60/0.39/0.40/0.0)
 *   - computeMinTradeAmount: 5000 floor / 低 pct 抬高 / 0 total
 *   - applyMaxPctCapToAmount: 上限 cap
 *   - tier override: 用户自定义档位
 *   - META-TEST (fs+regex): autoBuyFromSignals 必须 wire 进去
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  normalizeConfidence,
  deriveTargetPctFromConfidence,
  computeMinTradeAmount,
  applyMaxPctCapToAmount,
  CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT,
  CONFIDENCE_DRIVEN_DEFAULT_MAX_PCT,
  CONFIDENCE_TIER_DEFAULTS,
} from '../../src/portfolio/sizing/SignalDrivenSizing';

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

// ===== normalizeConfidence =====
console.log('## normalizeConfidence');
expectClose('0.5 → 0.5', normalizeConfidence(0.5), 0.5);
expectClose('1.0 → 1.0', normalizeConfidence(1.0), 1.0);
expectClose('0.0 → 0.0', normalizeConfidence(0.0), 0.0);
expectClose('80 (百分制) → 0.8', normalizeConfidence(80), 0.8);
expectClose('100 (百分制) → 1.0', normalizeConfidence(100), 1.0);
expectClose('150 (异常) → cap 1.0', normalizeConfidence(150), 1.0);
expectClose('-0.5 → 0', normalizeConfidence(-0.5), 0);
expectClose('NaN → 0', normalizeConfidence(NaN), 0);
expectClose('null → 0', normalizeConfidence(null), 0);
expectClose('undefined → 0', normalizeConfidence(undefined), 0);
expectClose('"0.7" → 0.7', normalizeConfidence('0.7'), 0.7);

// ===== deriveTargetPctFromConfidence — 4 档边界 =====
console.log('## deriveTargetPctFromConfidence — 4 档边界');

// tier_strong (≥ 0.8)
const t1 = deriveTargetPctFromConfidence(0.8);
expectClose('0.8 → 8%', t1.target_pct, 8);
assert('0.8 → tier_strong', t1.tier === 'tier_strong');

const t1b = deriveTargetPctFromConfidence(0.95);
expectClose('0.95 → 8%', t1b.target_pct, 8);
assert('0.95 → tier_strong', t1b.tier === 'tier_strong');

// tier_high [0.6, 0.8)
const t2 = deriveTargetPctFromConfidence(0.6);
expectClose('0.6 → 5%', t2.target_pct, 5);
assert('0.6 → tier_high', t2.tier === 'tier_high');

const t2b = deriveTargetPctFromConfidence(0.79);
expectClose('0.79 → 5%', t2b.target_pct, 5);

// tier_medium [0.4, 0.6)
const t3 = deriveTargetPctFromConfidence(0.4);
expectClose('0.4 → 3%', t3.target_pct, 3);
assert('0.4 → tier_medium', t3.tier === 'tier_medium');

const t3b = deriveTargetPctFromConfidence(0.59);
expectClose('0.59 → 3%', t3b.target_pct, 3);

// tier_low (< 0.4)
const t4 = deriveTargetPctFromConfidence(0.3);
expectClose('0.3 → 1.5%', t4.target_pct, 1.5);
assert('0.3 → tier_low', t4.tier === 'tier_low');

const t4b = deriveTargetPctFromConfidence(0.0);
expectClose('0.0 → 1.5%', t4b.target_pct, 1.5);

const t4c = deriveTargetPctFromConfidence(0.39);
expectClose('0.39 → 1.5%', t4c.target_pct, 1.5);

// 百分制输入
const t5 = deriveTargetPctFromConfidence(85);
expectClose('confidence=85 (百分制) → 8%', t5.target_pct, 8);
assert('confidence=85 → tier_strong', t5.tier === 'tier_strong');

// ===== max_pct cap =====
console.log('## max_pct cap');
const t6 = deriveTargetPctFromConfidence(0.9, { max_position_pct: 5 });
expectClose('strong tier capped at 5', t6.target_pct, 5);
assert('capped_by_max=true', t6.capped_by_max === true);

const t6b = deriveTargetPctFromConfidence(0.5, { max_position_pct: 10 });
expectClose('medium tier under cap → 3', t6b.target_pct, 3);
assert('capped_by_max=false', t6b.capped_by_max === false);

// tier_overrides
const t7 = deriveTargetPctFromConfidence(0.85, {
  tier_overrides: { tier_strong: 12, tier_high: 7 },
});
expectClose('tier_strong override → 12%', t7.target_pct, 12);

const t7b = deriveTargetPctFromConfidence(0.65, {
  tier_overrides: { tier_strong: 12, tier_high: 7 },
});
expectClose('tier_high override → 7%', t7b.target_pct, 7);

// ===== computeMinTradeAmount =====
console.log('## computeMinTradeAmount');
expectClose('1% × 100000 = 1000, max(1000, 5000) = 5000', computeMinTradeAmount(1, 100000), 5000);
expectClose('3% × 200000 = 6000, max(6000, 5000) = 6000', computeMinTradeAmount(3, 200000), 6000);
expectClose('8% × 200000 = 16000', computeMinTradeAmount(8, 200000), 16000);
expectClose('0 total → 0', computeMinTradeAmount(5, 0), 0);
expectClose('NaN total → 0', computeMinTradeAmount(5, NaN), 0);
expectClose(
  'override min_trade=8000',
  computeMinTradeAmount(1, 100000, 8000),
  8000
);
expectClose(
  'override min_trade=0 invalid → default 5000',
  computeMinTradeAmount(1, 100000, 0),
  5000
);

// ===== applyMaxPctCapToAmount =====
console.log('## applyMaxPctCapToAmount');
expectClose(
  '10000 ≤ 15% × 100000 = 15000 → pass through',
  applyMaxPctCapToAmount(10000, 100000, 15) as number,
  10000
);
expectClose(
  '20000 > 15% × 100000 = 15000 → cap to 15000',
  applyMaxPctCapToAmount(20000, 100000, 15) as number,
  15000
);
assert('total<=0 → null', applyMaxPctCapToAmount(10000, 0, 15) === null);

// ===== 默认值 =====
assert(
  'DEFAULT_MIN_TRADE_AMOUNT === 5000',
  CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT === 5000
);
assert(
  'DEFAULT_MAX_PCT === 15',
  CONFIDENCE_DRIVEN_DEFAULT_MAX_PCT === 15
);
assert(
  'tier_strong threshold === 0.8',
  CONFIDENCE_TIER_DEFAULTS.tier_strong.threshold === 0.8
);
assert(
  'tier_strong target_pct === 8',
  CONFIDENCE_TIER_DEFAULTS.tier_strong.target_pct === 8
);

// ===== META-TEST: autoBuyFromSignals 必须 wire =====
console.log('## META-TEST: autoBuyFromSignals 必须 wire CB-2');
const ROOT = path.resolve(__dirname, '../../');
const automationSrc = fs.readFileSync(
  path.join(ROOT, 'src/portfolio/internal/PaperTradingAutomationService.ts'),
  'utf-8'
);

assert(
  'import deriveTargetPctFromConfidence',
  /deriveTargetPctFromConfidence/.test(automationSrc),
  'PaperTradingAutomationService.ts 没 import deriveTargetPctFromConfidence'
);
assert(
  'import CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT',
  /CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT/.test(automationSrc),
  'PaperTradingAutomationService.ts 没 import CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT'
);
assert(
  'call deriveTargetPctFromConfidence(signal.confidence_score',
  /deriveTargetPctFromConfidence\(signal\.confidence_score/.test(automationSrc),
  'autoBuyFromSignals 没 call deriveTargetPctFromConfidence(signal.confidence_score)'
);
assert(
  'rawTargetAmount * Math.max(raw, CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT)',
  /Math\.max\(\s*rawTargetAmount\s*,\s*CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT\s*\)/.test(
    automationSrc
  ),
  'autoBuyFromSignals 没把 targetAmount 兜底 max(raw, CONFIDENCE_DRIVEN_DEFAULT_MIN_TRADE_AMOUNT)'
);

console.log(`\n# summary: ${passed} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
