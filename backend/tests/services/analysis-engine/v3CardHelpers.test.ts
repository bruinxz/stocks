/**
 * v3CardHelpers 单元测试 (CA-1).
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/analysis-engine/v3CardHelpers.test.ts
 *
 * 覆盖:
 *   - scoreToBarValue (0/100/null/NaN/Infinity/边界)
 *   - aggregateToV3Dimensions (happy / 缺 1 / 全缺 / risk 负权重 / 边界)
 *   - buildHighlightTags (市值 4 档边界 + 各 tag 触发 + max 3 + 优先级顺序)
 *   - pickV3ConfidenceTier (3 档边界 + 全缺兜底)
 */

import {
  scoreToBarValue,
  aggregateToV3Dimensions,
  buildHighlightTags,
  pickV3ConfidenceTier,
  V3_DIMENSION_KEYS,
  V3_DIMENSION_LABEL,
  V3_SUB_WEIGHTS,
} from '../../../src/services/analysis-engine/v3CardHelpers';

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

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function expectEq<T>(name: string, actual: T, expected: T, eps = 1e-6): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    assert(name, near(actual, expected, eps), `expected=${expected}, got=${actual}`);
  } else {
    assert(name, actual === expected, `expected=${String(expected)}, got=${String(actual)}`);
  }
}

// ---------------------------------------------------------------------------
//  scoreToBarValue
// ---------------------------------------------------------------------------
console.log('\n## scoreToBarValue()');
expectEq('score=0 → 50', scoreToBarValue(0), 50);
expectEq('score=100 → 100', scoreToBarValue(100), 100);
expectEq('score=-100 → 0', scoreToBarValue(-100), 0);
expectEq('score=50 → 75', scoreToBarValue(50), 75);
expectEq('score=-50 → 25', scoreToBarValue(-50), 25);
expectEq('score=200 (clamp) → 100', scoreToBarValue(200), 100);
expectEq('score=-200 (clamp) → 0', scoreToBarValue(-200), 0);
expectEq('null → 50', scoreToBarValue(null), 50);
expectEq('undefined → 50', scoreToBarValue(undefined), 50);
expectEq('NaN → 50', scoreToBarValue(NaN), 50);
expectEq('Infinity → 50', scoreToBarValue(Infinity), 50);
expectEq('-Infinity → 50', scoreToBarValue(-Infinity), 50);
expectEq('1.4 round → 51', scoreToBarValue(1.4), 51);

// ---------------------------------------------------------------------------
//  V3_DIMENSION_KEYS / V3_DIMENSION_LABEL / V3_SUB_WEIGHTS sanity
// ---------------------------------------------------------------------------
console.log('\n## V3 常量');
expectEq('V3_DIMENSION_KEYS.length === 4', V3_DIMENSION_KEYS.length, 4);
expectEq('popularity label', V3_DIMENSION_LABEL.popularity, '人气');
expectEq('logic label', V3_DIMENSION_LABEL.logic, '逻辑');
expectEq('capital label', V3_DIMENSION_LABEL.capital, '资金');
expectEq('structure label', V3_DIMENSION_LABEL.structure, '结构');
expectEq(
  'popularity sub = sentiment 100%',
  V3_SUB_WEIGHTS.popularity.sentiment,
  1.0
);
expectEq(
  'logic sub = fundamental 0.5 + industry 0.3 + event 0.2',
  V3_SUB_WEIGHTS.logic.fundamental + V3_SUB_WEIGHTS.logic.industry_regime + V3_SUB_WEIGHTS.logic.event,
  1.0
);
expectEq('capital sub = capital 1.0', V3_SUB_WEIGHTS.capital.capital, 1.0);
expectEq('structure technical=0.7', V3_SUB_WEIGHTS.structure.technical, 0.7);
expectEq('structure risk=-0.3 (负权重)', V3_SUB_WEIGHTS.structure.risk, -0.3);
assert(
  '常量 Object.freeze (不可改)',
  (() => {
    try {
      (V3_SUB_WEIGHTS as any).popularity.sentiment = 99;
      return V3_SUB_WEIGHTS.popularity.sentiment === 1.0;
    } catch {
      return true;
    }
  })()
);

// ---------------------------------------------------------------------------
//  aggregateToV3Dimensions
// ---------------------------------------------------------------------------
console.log('\n## aggregateToV3Dimensions()');

// happy: 8 维全有
const dims1 = aggregateToV3Dimensions([
  { analyzer_key: 'fundamental', score: 60, confidence: 0.8 },
  { analyzer_key: 'technical', score: 40, confidence: 0.7 },
  { analyzer_key: 'capital', score: 50, confidence: 0.9 },
  { analyzer_key: 'sentiment', score: 30, confidence: 0.6 },
  { analyzer_key: 'news', score: 20, confidence: 0.5 }, // 不进 4 维
  { analyzer_key: 'industry_regime', score: 70, confidence: 0.8 },
  { analyzer_key: 'risk', score: -50, confidence: 0.7 }, // 负 score = 高风险
  { analyzer_key: 'event', score: 10, confidence: 0.4 },
]);
expectEq('happy: 4 维', dims1.length, 4);
expectEq('happy: dim[0].key=popularity', dims1[0].key, 'popularity');
expectEq('happy: popularity raw=30', dims1[0].raw_score, 30);
expectEq('happy: popularity bar=65', dims1[0].bar_value, 65);
expectEq('happy: popularity confidence=0.6', dims1[0].confidence, 0.6);
expectEq('happy: popularity subs_present=1', dims1[0].subs_present, 1);

// logic: (60*0.5 + 70*0.3 + 10*0.2) / 1.0 = 30+21+2 = 53
expectEq('happy: logic raw=53', dims1[1].raw_score, 53);
expectEq('happy: logic bar=77', dims1[1].bar_value, 77);
expectEq('happy: logic subs=3', dims1[1].subs_present, 3);

// capital: 50 / 1.0 = 50
expectEq('happy: capital raw=50', dims1[2].raw_score, 50);

// structure: (40*0.7 + (-50)*(-0.3)) / (0.7+0.3) = (28 + 15) / 1.0 = 43
expectEq(
  'happy: structure raw=43 (risk 负 score × 负权重 = 正贡献)',
  dims1[3].raw_score,
  43
);

// 缺 1 子维: sentiment 没有 → popularity subs=0 → raw=0 / bar=50
const dims2 = aggregateToV3Dimensions([
  { analyzer_key: 'fundamental', score: 60, confidence: 0.8 },
]);
expectEq('缺 sentiment: popularity raw=0', dims2[0].raw_score, 0);
expectEq('缺 sentiment: popularity bar=50', dims2[0].bar_value, 50);
expectEq('缺 sentiment: popularity subs=0', dims2[0].subs_present, 0);
expectEq('缺 sentiment: popularity conf=0', dims2[0].confidence, 0);
// logic 只有 fundamental: (60*0.5) / 0.5 = 60
expectEq('缺 industry+event: logic raw=60 (仅 fundamental)', dims2[1].raw_score, 60);
expectEq('缺 industry+event: logic subs=1', dims2[1].subs_present, 1);

// 全缺: 空数组
const dims3 = aggregateToV3Dimensions([]);
expectEq('全缺: 4 维', dims3.length, 4);
expectEq('全缺: popularity raw=0', dims3[0].raw_score, 0);
expectEq('全缺: popularity bar=50', dims3[0].bar_value, 50);
expectEq('全缺: structure subs=0', dims3[3].subs_present, 0);

// risk 子维负权重生效 (risk 正 score = 低风险 → structure 应减少)
const dims4 = aggregateToV3Dimensions([
  { analyzer_key: 'technical', score: 0, confidence: 0.5 },
  { analyzer_key: 'risk', score: 100, confidence: 0.5 }, // 极度安全
]);
// structure = (0*0.7 + 100*(-0.3)) / 1.0 = -30
expectEq('risk score=100 (低风险) → structure raw=-30', dims4[3].raw_score, -30);
expectEq('risk score=100 → structure bar=35', dims4[3].bar_value, 35);

const dims5 = aggregateToV3Dimensions([
  { analyzer_key: 'technical', score: 0, confidence: 0.5 },
  { analyzer_key: 'risk', score: -100, confidence: 0.5 }, // 极度危险
]);
// structure = (0*0.7 + (-100)*(-0.3)) / 1.0 = 30
expectEq('risk score=-100 (高风险) → structure raw=30 (利多 structure)', dims5[3].raw_score, 30);

// score 边界 (NaN / null / Infinity 不应让整维退化)
const dims6 = aggregateToV3Dimensions([
  { analyzer_key: 'fundamental', score: NaN, confidence: 0.5 },
  { analyzer_key: 'industry_regime', score: 60, confidence: 0.8 },
  { analyzer_key: 'event', score: 30, confidence: 0.6 },
]);
// logic = (0*0.5 + 60*0.3 + 30*0.2) / 1.0 = 18+6 = 24
expectEq('NaN score 安全 fallback 0: logic raw=24', dims6[1].raw_score, 24);

const dims7 = aggregateToV3Dimensions([
  { analyzer_key: 'sentiment', score: Infinity, confidence: 0.5 },
]);
expectEq('Infinity score → 0', dims7[0].raw_score, 0);

// confidence 越界 clamp
const dims8 = aggregateToV3Dimensions([
  { analyzer_key: 'sentiment', score: 50, confidence: 1.5 },
]);
expectEq('confidence 1.5 clamp 到 1', dims8[0].confidence, 1);

const dims9 = aggregateToV3Dimensions([
  { analyzer_key: 'sentiment', score: 50, confidence: -0.5 },
]);
expectEq('confidence -0.5 clamp 到 0', dims9[0].confidence, 0);

// score 极值 (200 → bar clamp 100)
const dims10 = aggregateToV3Dimensions([
  { analyzer_key: 'sentiment', score: 200, confidence: 0.5 },
]);
expectEq('score=200 → raw=200', dims10[0].raw_score, 200);
expectEq('score=200 → bar=100 (clamp)', dims10[0].bar_value, 100);

// ---------------------------------------------------------------------------
//  buildHighlightTags
// ---------------------------------------------------------------------------
console.log('\n## buildHighlightTags()');

// 市值 4 档边界
expectEq(
  '市值 1500亿 → 超大市值',
  buildHighlightTags({ circulating_market_cap: 1.5e11 }, [])[0],
  '超大市值'
);
expectEq(
  '市值 1000亿 (边界) → 超大市值',
  buildHighlightTags({ circulating_market_cap: 1e11 }, [])[0],
  '超大市值'
);
expectEq(
  '市值 800亿 → 千亿大盘',
  buildHighlightTags({ circulating_market_cap: 8e10 }, [])[0],
  '千亿大盘'
);
expectEq(
  '市值 500亿 (边界) → 千亿大盘',
  buildHighlightTags({ circulating_market_cap: 5e10 }, [])[0],
  '千亿大盘'
);
expectEq(
  '市值 300亿 → 中盘股',
  buildHighlightTags({ circulating_market_cap: 3e10 }, [])[0],
  '中盘股'
);
expectEq(
  '市值 100亿 (边界) → 中盘股',
  buildHighlightTags({ circulating_market_cap: 1e10 }, [])[0],
  '中盘股'
);
expectEq(
  '市值 50亿 → 小盘股',
  buildHighlightTags({ circulating_market_cap: 5e9 }, [])[0],
  '小盘股'
);

// 缺 circulating, 走 total
expectEq(
  '缺 circulating, total=1500亿 → 超大市值',
  buildHighlightTags({ total_market_cap: 1.5e11 }, [])[0],
  '超大市值'
);

// 缺市值 → 不加市值 tag
const noCapTags = buildHighlightTags({}, [
  { analyzer_key: 'capital', score: 70 },
]);
assert('缺市值, capital>60 → 仅资金流入', noCapTags.length === 1 && noCapTags[0] === '资金流入');

// 各 score tag 触发
const allTagsInput: Array<{ analyzer_key: string; score: number; evidence?: { label: string; direction: string }[] }> = [
  { analyzer_key: 'capital', score: 70 },
  { analyzer_key: 'sentiment', score: 70 },
  { analyzer_key: 'technical', score: 70, evidence: [{ label: '放量上涨', direction: 'bullish' }] },
  { analyzer_key: 'event', score: 50 },
  { analyzer_key: 'industry_regime', score: 70 },
];
const allTags = buildHighlightTags({ circulating_market_cap: 8e10 }, allTagsInput, 6);
expectEq('全部 tag 触发 → max 6 = 6 个', allTags.length, 6);
expectEq('全部 tag[0] = 千亿大盘', allTags[0], '千亿大盘');
expectEq('全部 tag[1] = 资金流入', allTags[1], '资金流入');
expectEq('全部 tag[2] = 题材活跃', allTags[2], '题材活跃');
expectEq('全部 tag[3] = 放量突破', allTags[3], '放量突破');
expectEq('全部 tag[4] = 事件催化', allTags[4], '事件催化');
expectEq('全部 tag[5] = 行业景气', allTags[5], '行业景气');

// 默认 maxTags=3 (优先级前 3)
const top3 = buildHighlightTags({ circulating_market_cap: 8e10 }, allTagsInput);
expectEq('默认 maxTags=3', top3.length, 3);
expectEq('top3[0] 市值', top3[0], '千亿大盘');
expectEq('top3[1] capital', top3[1], '资金流入');
expectEq('top3[2] sentiment', top3[2], '题材活跃');

// technical: score>60 但 evidence 不含放量/突破 → 不触发
const noBreakoutTags = buildHighlightTags({}, [
  { analyzer_key: 'technical', score: 70, evidence: [{ label: '均线多头', direction: 'bullish' }] },
]);
expectEq('technical>60 但 evidence 无放量/突破 → 不加 tag', noBreakoutTags.length, 0);

// technical: evidence 含突破
const breakoutTags = buildHighlightTags({}, [
  { analyzer_key: 'technical', score: 65, evidence: [{ label: '日线突破前高', direction: 'bullish' }] },
]);
expectEq('technical>60 且 evidence 含突破 → 放量突破', breakoutTags[0], '放量突破');

// score 边界: capital=60 (=阈值) 不触发 (用 > 而非 >=)
const equalTags = buildHighlightTags({}, [{ analyzer_key: 'capital', score: 60 }]);
expectEq('capital=60 (=阈值) 不触发', equalTags.length, 0);

// event score=40 (=阈值) 不触发
const equalEventTags = buildHighlightTags({}, [{ analyzer_key: 'event', score: 40 }]);
expectEq('event=40 (=阈值) 不触发', equalEventTags.length, 0);

// null/undefined stock
const nullStockTags = buildHighlightTags(null, [{ analyzer_key: 'capital', score: 70 }]);
expectEq('null stock → 仅 capital', nullStockTags[0], '资金流入');
expectEq('null stock → tags.length=1', nullStockTags.length, 1);

const undefStockTags = buildHighlightTags(undefined, [{ analyzer_key: 'capital', score: 70 }]);
expectEq('undefined stock → 仅 capital', undefStockTags[0], '资金流入');

// maxTags=0 → 空
const zeroTags = buildHighlightTags({ circulating_market_cap: 8e10 }, allTagsInput, 0);
expectEq('maxTags=0 → 空 (实际 spec 是 slice(0,0))', zeroTags.length, 0);

// 市值为 0 / 负 → 不加市值 tag
const zeroCapTags = buildHighlightTags({ circulating_market_cap: 0 }, [
  { analyzer_key: 'capital', score: 70 },
]);
expectEq('market_cap=0 → 不加市值 tag', zeroCapTags[0], '资金流入');

const negCapTags = buildHighlightTags({ circulating_market_cap: -100 }, [
  { analyzer_key: 'capital', score: 70 },
]);
expectEq('market_cap=-100 → 不加市值 tag', negCapTags[0], '资金流入');

// 优先级: 即使 industry tag 先 (capital 缺失), 顺序仍是 capital→sentiment→...
const partialTags = buildHighlightTags({}, [
  { analyzer_key: 'industry_regime', score: 80 },
  { analyzer_key: 'sentiment', score: 80 },
]);
expectEq('优先级 sentiment 在 industry 前', partialTags[0], '题材活跃');
expectEq('优先级 industry 第 2', partialTags[1], '行业景气');

// ---------------------------------------------------------------------------
//  pickV3ConfidenceTier
// ---------------------------------------------------------------------------
console.log('\n## pickV3ConfidenceTier()');

const tierHigh = pickV3ConfidenceTier([
  { key: 'popularity', label: '人气', bar_value: 80, raw_score: 60, confidence: 0.8, subs_present: 1 },
  { key: 'logic', label: '逻辑', bar_value: 80, raw_score: 60, confidence: 0.8, subs_present: 1 },
  { key: 'capital', label: '资金', bar_value: 70, raw_score: 40, confidence: 0.8, subs_present: 1 },
  { key: 'structure', label: '结构', bar_value: 70, raw_score: 40, confidence: 0.8, subs_present: 1 },
]);
expectEq('avg=75 → high', tierHigh, 'high');

const tierHighBoundary = pickV3ConfidenceTier([
  { key: 'popularity', label: '', bar_value: 70, raw_score: 0, confidence: 0, subs_present: 1 },
]);
expectEq('avg=70 (=边界) → high', tierHighBoundary, 'high');

const tierMedium = pickV3ConfidenceTier([
  { key: 'popularity', label: '', bar_value: 60, raw_score: 0, confidence: 0, subs_present: 1 },
  { key: 'logic', label: '', bar_value: 40, raw_score: 0, confidence: 0, subs_present: 1 },
]);
expectEq('avg=50 → medium', tierMedium, 'medium');

const tierMediumBoundary = pickV3ConfidenceTier([
  { key: 'popularity', label: '', bar_value: 40, raw_score: 0, confidence: 0, subs_present: 1 },
]);
expectEq('avg=40 (=边界) → medium', tierMediumBoundary, 'medium');

const tierLow = pickV3ConfidenceTier([
  { key: 'popularity', label: '', bar_value: 30, raw_score: 0, confidence: 0, subs_present: 0 },
  { key: 'logic', label: '', bar_value: 30, raw_score: 0, confidence: 0, subs_present: 0 },
]);
expectEq('avg=30 → low', tierLow, 'low');

const tierEmpty = pickV3ConfidenceTier([]);
expectEq('空数组 → low (兜底)', tierEmpty, 'low');

const tierAllNaN = pickV3ConfidenceTier([
  { key: 'popularity', label: '', bar_value: NaN as any, raw_score: 0, confidence: 0, subs_present: 0 },
]);
expectEq('全 NaN bar → low (兜底)', tierAllNaN, 'low');

const tierMixed = pickV3ConfidenceTier([
  { key: 'popularity', label: '', bar_value: 80, raw_score: 0, confidence: 0, subs_present: 1 },
  { key: 'logic', label: '', bar_value: NaN as any, raw_score: 0, confidence: 0, subs_present: 0 },
  { key: 'capital', label: '', bar_value: 80, raw_score: 0, confidence: 0, subs_present: 1 },
]);
// 只算有效 2 个: (80+80)/2 = 80
expectEq('混合 NaN: 有效平均=80 → high', tierMixed, 'high');

// ---------------------------------------------------------------------------
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
