/**
 * scenarioPlaybookBuilder 单元测试 (CA-2).
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/analysis-engine/scenarioPlaybookBuilder.test.ts
 *
 * 覆盖:
 *   - classifyOpenPrice (5 档 + 边界 + null/NaN/0/负 prev_close)
 *   - buildScenarioPlaybook happy / action=sell / prev_close 缺失 / breakout / 缩量 /
 *                          capital 加速 / 高位风险 / support_level 缺失降级 /
 *                          ATR 紧止损 / entry_low fallback
 *   - SCENARIO_THRESHOLDS / VERDICT_COLOR / SCENARIO_LABEL freeze
 */

import {
  classifyOpenPrice,
  buildScenarioPlaybook,
  SCENARIO_THRESHOLDS,
  SCENARIO_LABEL,
  VERDICT_COLOR,
  VERDICT_LABEL,
  type ScenarioPlaybookContext,
} from '../../../src/services/analysis-engine/scenarioPlaybookBuilder';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectEq<T>(name: string, actual: T, expected: T): void {
  assert(
    name,
    actual === expected,
    `expected=${String(expected)}, got=${String(actual)}`
  );
}

function makeCtx(overrides: Partial<ScenarioPlaybookContext> = {}): ScenarioPlaybookContext {
  return {
    prev_close: 100,
    entry_low: null,
    support_level: null,
    atr_20d: null,
    action: 'buy',
    evidence_text: '',
    capital_score: null,
    risk_warnings_text: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  constants
// ---------------------------------------------------------------------------
console.log('\n## 常量 / 冻结');
expectEq('SCENARIO_LABEL.high_strong', SCENARIO_LABEL.high_strong, '高开 +2% 以上');
expectEq('SCENARIO_LABEL.high_weak', SCENARIO_LABEL.high_weak, '高开 0 ~ +2%');
expectEq('SCENARIO_LABEL.flat', SCENARIO_LABEL.flat, '平开 -1% ~ +1%');
expectEq('SCENARIO_LABEL.low_mild', SCENARIO_LABEL.low_mild, '低开 -2% 以内');
expectEq('SCENARIO_LABEL.low_hard', SCENARIO_LABEL.low_hard, '低开超 -3%');
expectEq('VERDICT_COLOR.buy 红', VERDICT_COLOR.buy, '#cf1322');
expectEq('VERDICT_COLOR.hold 橙', VERDICT_COLOR.hold, '#fa8c16');
expectEq('VERDICT_COLOR.observe 蓝', VERDICT_COLOR.observe, '#1890ff');
expectEq('VERDICT_COLOR.avoid 绿', VERDICT_COLOR.avoid, '#52c41a');
expectEq('VERDICT_LABEL.buy', VERDICT_LABEL.buy, '建议参与');
expectEq('VERDICT_LABEL.avoid', VERDICT_LABEL.avoid, '避开');
expectEq('SCENARIO_THRESHOLDS.high_strong.min', SCENARIO_THRESHOLDS.high_strong.min, 0.02);
expectEq('SCENARIO_THRESHOLDS.low_hard.max', SCENARIO_THRESHOLDS.low_hard.max, -0.03);
assert(
  'SCENARIO_LABEL Object.freeze (不可改)',
  (() => {
    try {
      (SCENARIO_LABEL as any).high_strong = 'X';
    } catch {
      /* strict mode 抛 */
    }
    return SCENARIO_LABEL.high_strong === '高开 +2% 以上';
  })()
);
assert(
  'VERDICT_COLOR Object.freeze (不可改)',
  (() => {
    try {
      (VERDICT_COLOR as any).buy = 'X';
    } catch {
      /* strict mode 抛 */
    }
    return VERDICT_COLOR.buy === '#cf1322';
  })()
);

// ---------------------------------------------------------------------------
//  classifyOpenPrice
// ---------------------------------------------------------------------------
console.log('\n## classifyOpenPrice()');

// 5 档基本
expectEq('+5% → high_strong', classifyOpenPrice(100, 105), 'high_strong');
expectEq('+2.01% → high_strong', classifyOpenPrice(100, 102.01), 'high_strong');
expectEq('+2% 边界 → high_strong (>=)', classifyOpenPrice(100, 102), 'high_strong');
expectEq('+1.99% → high_weak', classifyOpenPrice(100, 101.99), 'high_weak');
expectEq('+1% → high_weak', classifyOpenPrice(100, 101), 'high_weak');
expectEq('+0.5% → high_weak', classifyOpenPrice(100, 100.5), 'high_weak');
expectEq('0% 边界 → high_weak (>=)', classifyOpenPrice(100, 100), 'high_weak');
expectEq('-0.01% → flat', classifyOpenPrice(100, 99.99), 'flat');
expectEq('-0.5% → flat', classifyOpenPrice(100, 99.5), 'flat');
expectEq('-1% 边界 → low_mild (>=)', classifyOpenPrice(100, 99), 'low_mild');
expectEq('-2% → low_mild', classifyOpenPrice(100, 98), 'low_mild');
expectEq('-2.99% → low_mild', classifyOpenPrice(100, 97.01), 'low_mild');
expectEq('-3% 边界 → low_hard (<=)', classifyOpenPrice(100, 97), 'low_hard');
expectEq('-5% → low_hard', classifyOpenPrice(100, 95), 'low_hard');

// 无效输入
expectEq('prev_close=0 → null', classifyOpenPrice(0, 100), null);
expectEq('prev_close=-1 → null', classifyOpenPrice(-1, 100), null);
expectEq('prev_close=NaN → null', classifyOpenPrice(NaN, 100), null);
expectEq('next_open=NaN → null', classifyOpenPrice(100, NaN), null);
expectEq('prev_close=Infinity → null', classifyOpenPrice(Infinity, 100), null);
expectEq('null prev_close → null', classifyOpenPrice(null as any, 100), null);

// ---------------------------------------------------------------------------
//  buildScenarioPlaybook
// ---------------------------------------------------------------------------
console.log('\n## buildScenarioPlaybook() — happy path');

const happy = buildScenarioPlaybook(makeCtx());
assert('happy: 非 null', happy !== null);
if (happy) {
  expectEq('happy: 5 档', happy.length, 5);
  expectEq('happy[0].bucket = high_strong', happy[0].bucket, 'high_strong');
  expectEq('happy[1].bucket = high_weak', happy[1].bucket, 'high_weak');
  expectEq('happy[2].bucket = flat', happy[2].bucket, 'flat');
  expectEq('happy[3].bucket = low_mild', happy[3].bucket, 'low_mild');
  expectEq('happy[4].bucket = low_hard', happy[4].bucket, 'low_hard');

  expectEq('happy[0].verdict = buy', happy[0].verdict, 'buy');
  expectEq('happy[1].verdict = hold', happy[1].verdict, 'hold');
  expectEq('happy[2].verdict = observe', happy[2].verdict, 'observe');
  expectEq('happy[3].verdict = observe', happy[3].verdict, 'observe');
  expectEq('happy[4].verdict = avoid', happy[4].verdict, 'avoid');

  expectEq('happy[4].avoid = true', happy[4].avoid, true);
  expectEq('happy[0].avoid = false', happy[0].avoid, false);

  // high_strong: stop = open(102) * 0.98 = 99.96
  expectEq('happy[0].stop_loss ≈ 99.96', happy[0].stop_loss, 99.96);
  // high_weak: stop = 100 * 0.99 = 99
  expectEq('happy[1].stop_loss = 99', happy[1].stop_loss, 99);
  // flat: stop null
  expectEq('happy[2].stop_loss = null', happy[2].stop_loss, null);
  // low_mild: 无 support_level → null
  expectEq('happy[3].stop_loss = null (no support)', happy[3].stop_loss, null);
  // low_hard: stop null (放弃)
  expectEq('happy[4].stop_loss = null', happy[4].stop_loss, null);

  // trigger 应该是 SCENARIO_LABEL 原文
  expectEq('happy[0].trigger', happy[0].trigger, SCENARIO_LABEL.high_strong);

  // action 基础文案
  assert('happy[0].action 含 "可积极参与"', happy[0].action.includes('可积极参与'));
  assert('happy[0].action 含止损价 ¥99.96', happy[0].action.includes('¥99.96'));
  assert('happy[1].action 含 "温和走强"', happy[1].action.includes('温和走强'));
  assert('happy[2].action 含 "窄幅整理"', happy[2].action.includes('窄幅整理'));
  assert(
    'happy[2].action 含 (新进仓位...) — action=buy 是 positive',
    happy[2].action.includes('新进仓位')
  );
  assert('happy[3].action 含 "低位观察"', happy[3].action.includes('低位观察'));
  assert('happy[4].action 含 "明显弱势"', happy[4].action.includes('明显弱势'));
  assert('happy[4].action 含 "不急于抄底"', happy[4].action.includes('不急于抄底'));
}

console.log('\n## buildScenarioPlaybook() — fail conditions');
expectEq(
  'action=sell → null',
  buildScenarioPlaybook(makeCtx({ action: 'sell' })),
  null
);
expectEq(
  'action=strong_sell → null',
  buildScenarioPlaybook(makeCtx({ action: 'strong_sell' })),
  null
);
expectEq(
  'action=SELL 大写 → null (lowercase 后比较)',
  buildScenarioPlaybook(makeCtx({ action: 'SELL' })),
  null
);
expectEq(
  'prev_close=0 → null',
  buildScenarioPlaybook(makeCtx({ prev_close: 0 })),
  null
);
expectEq(
  'prev_close=-1 → null',
  buildScenarioPlaybook(makeCtx({ prev_close: -1 })),
  null
);
expectEq(
  'prev_close=NaN → null',
  buildScenarioPlaybook(makeCtx({ prev_close: NaN })),
  null
);
expectEq(
  'prev_close=Infinity → null',
  buildScenarioPlaybook(makeCtx({ prev_close: Infinity })),
  null
);
expectEq('null ctx → null', buildScenarioPlaybook(null as any), null);

// action=hold 时 flat 不含 "新进仓位"
const holdCtx = buildScenarioPlaybook(makeCtx({ action: 'hold' }));
if (holdCtx) {
  assert(
    'action=hold: flat 不含 "新进仓位"',
    !holdCtx[2].action.includes('新进仓位')
  );
}

console.log('\n## buildScenarioPlaybook() — 文案动态');

// evidence 含 "放量" → high_strong 加 "放量突破信号"
const breakout = buildScenarioPlaybook(makeCtx({ evidence_text: '今日放量上涨' }));
if (breakout) {
  assert('放量 → high_strong action 含 "放量突破信号"', breakout[0].action.includes('放量突破信号'));
}

// evidence 含 "突破"
const breakout2 = buildScenarioPlaybook(makeCtx({ evidence_text: '日线突破前高' }));
if (breakout2) {
  assert('突破 → high_strong action 含 "放量突破信号"', breakout2[0].action.includes('放量突破信号'));
}

// evidence 不含 → 不加
const noBreakout = buildScenarioPlaybook(makeCtx({ evidence_text: '均线多头' }));
if (noBreakout) {
  assert('无放量/突破 → high_strong 不加 "放量突破"', !noBreakout[0].action.includes('放量突破信号'));
}

// capital_score=70 → 加 "资金加速"
const capital = buildScenarioPlaybook(makeCtx({ capital_score: 70 }));
if (capital) {
  assert('capital_score=70 → "资金加速"', capital[0].action.includes('资金加速'));
}

// capital_score=60 (边界, 用 >) → 不加
const capitalEdge = buildScenarioPlaybook(makeCtx({ capital_score: 60 }));
if (capitalEdge) {
  assert('capital_score=60 边界 → 不加 "资金加速"', !capitalEdge[0].action.includes('资金加速'));
}

// capital_score=null → 不加
const capitalNull = buildScenarioPlaybook(makeCtx({ capital_score: null }));
if (capitalNull) {
  assert('capital_score=null → 不加 "资金加速"', !capitalNull[0].action.includes('资金加速'));
}

// evidence 含 "缩量" → high_weak 加 "量能不足需谨慎"
const volWeak = buildScenarioPlaybook(makeCtx({ evidence_text: '今日缩量调整' }));
if (volWeak) {
  assert('缩量 → high_weak 加 "量能不足需谨慎"', volWeak[1].action.includes('量能不足需谨慎'));
}

// risk_warnings 含 "高位" → low_hard 加 "避免抄底"
const highRisk = buildScenarioPlaybook(makeCtx({ risk_warnings_text: '高位破位' }));
if (highRisk) {
  assert('高位 → low_hard 加 "高位破位, 避免抄底"', highRisk[4].action.includes('避免抄底'));
}

const crowdedRisk = buildScenarioPlaybook(makeCtx({ risk_warnings_text: '机构持仓拥挤' }));
if (crowdedRisk) {
  assert('拥挤 → low_hard 加 "避免抄底"', crowdedRisk[4].action.includes('避免抄底'));
}

const normalRisk = buildScenarioPlaybook(makeCtx({ risk_warnings_text: '行业β偏高' }));
if (normalRisk) {
  assert('普通风险 → low_hard 不加 "避免抄底"', !normalRisk[4].action.includes('避免抄底'));
}

console.log('\n## buildScenarioPlaybook() — support_level / entry_low');

// support_level=95 → low_mild "关注 ¥95.00 支撑" + 止损 95*0.99=94.05
const support = buildScenarioPlaybook(makeCtx({ support_level: 95 }));
if (support) {
  assert('support=95 → action 含 "¥95.00 支撑"', support[3].action.includes('¥95.00 支撑'));
  expectEq('support=95 → stop_loss = 94.05', support[3].stop_loss, 94.05);
  assert('support=95 → action 含 "止损 ¥94.05"', support[3].action.includes('止损 ¥94.05'));
}

// support 缺失但 entry_low=93 → 退而求其次
const entryFallback = buildScenarioPlaybook(makeCtx({ entry_low: 93 }));
if (entryFallback) {
  assert('entry_low fallback → "¥93.00 支撑"', entryFallback[3].action.includes('¥93.00 支撑'));
  expectEq('entry_low fallback stop = 93*0.99 = 92.07', entryFallback[3].stop_loss, 92.07);
}

// support 与 entry_low 都缺 → "低位观察"
const noSupport = buildScenarioPlaybook(makeCtx({ support_level: null, entry_low: null }));
if (noSupport) {
  assert('全无 support → "低位观察"', noSupport[3].action.includes('低位观察'));
  expectEq('全无 support → stop null', noSupport[3].stop_loss, null);
}

// support=0 / 负数 → 视为缺失, 走 entry_low fallback (此处 entry_low=92)
const supportZero = buildScenarioPlaybook(makeCtx({ support_level: 0, entry_low: 92 }));
if (supportZero) {
  assert(
    'support=0 视为缺失, 走 entry_low=92 fallback',
    supportZero[3].action.includes('¥92.00 支撑')
  );
}

console.log('\n## buildScenarioPlaybook() — ATR 紧止损');

// ATR 紧止损: prev_close=100, open=102, ATR=1.5 → atrStop=100.5 > 99.96 → 用 100.5
const atr = buildScenarioPlaybook(makeCtx({ atr_20d: 1.5 }));
if (atr) {
  expectEq('ATR=1.5 紧止损 → stop=100.50', atr[0].stop_loss, 100.5);
  assert('ATR 紧止损 action 含 ¥100.50', atr[0].action.includes('¥100.50'));
}

// ATR 过大 → 不收紧 (atrStop=102-3=99 < 99.96, 取 99.96)
const atrLarge = buildScenarioPlaybook(makeCtx({ atr_20d: 3 }));
if (atrLarge) {
  expectEq('ATR=3 过大, 仍用 99.96 止损', atrLarge[0].stop_loss, 99.96);
}

// ATR=0 / 负 / NaN → 不影响, 用默认 99.96
const atrZero = buildScenarioPlaybook(makeCtx({ atr_20d: 0 }));
if (atrZero) expectEq('ATR=0 → 默认 99.96', atrZero[0].stop_loss, 99.96);

const atrNaN = buildScenarioPlaybook(makeCtx({ atr_20d: NaN }));
if (atrNaN) expectEq('ATR=NaN → 默认 99.96', atrNaN[0].stop_loss, 99.96);

console.log('\n## buildScenarioPlaybook() — 多触发器组合');

const combo = buildScenarioPlaybook(
  makeCtx({
    evidence_text: '放量突破 缩量',
    capital_score: 80,
    risk_warnings_text: '高位拥挤',
  })
);
if (combo) {
  // high_strong: 含放量突破 + 资金加速
  assert('combo[0] 含 "放量突破信号"', combo[0].action.includes('放量突破信号'));
  assert('combo[0] 含 "资金加速"', combo[0].action.includes('资金加速'));
  // high_weak: 含 量能不足
  assert('combo[1] 含 "量能不足"', combo[1].action.includes('量能不足'));
  // low_hard: 含 避免抄底
  assert('combo[4] 含 "避免抄底"', combo[4].action.includes('避免抄底'));
}

console.log(`\n--- summary: ${passed} passed, ${failed} failed ---`);

setTimeout(() => {
  if (failed > 0) {
    console.error('\nFAILED');
    process.exit(1);
  } else {
    console.log('\nALL PASS');
    process.exit(0);
  }
}, 50);
