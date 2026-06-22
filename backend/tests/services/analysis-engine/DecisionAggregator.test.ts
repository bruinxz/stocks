/**
 * DecisionAggregator.test.ts — 5 case (veto / dampen / 各 action 阈值 / data_quality critical).
 *
 * AE-006 (US-112): 追加 pickEntryZone 走 `marketLimits.ts` 的市场段矩阵 + meta-test
 * guard 确保 DecisionAggregator 不再 inline 写涨跌停 (历史 `applyLimitPrice` 已删除).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  DecisionAggregator,
  mapScoreToAction,
  normalizeWeights,
  pickEntryZone,
  pickStopLoss,
  pickTakeProfit,
  pickConfidenceTier,
  derivePositionAction,
  CONFIDENCE_TIER_HIGH_MIN,
  CONFIDENCE_TIER_MEDIUM_MIN,
} from '../../../src/services/analysis-engine/DecisionAggregator';
import { getLimitPrices } from '../../../src/quant/marketLimits';
import type {
  AnalyzerOutput,
  DataQualityVerdict,
} from '../../../src/services/analysis-engine/AnalyzerTypes';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(msg);
    console.error(`✗ ${msg}`);
  }
}

function dqGood(): DataQualityVerdict {
  return { level: 'good', missing_critical: [], missing_optional: [], notes: [], coefficient: 1 };
}
function dqCritical(): DataQualityVerdict {
  return {
    level: 'critical',
    missing_critical: ['daily_bars'],
    missing_optional: [],
    notes: [],
    coefficient: 0,
  };
}

function makeAnalyzer(
  key: AnalyzerOutput['analyzer_key'],
  score: number,
  confidence = 0.8,
  extra: Partial<AnalyzerOutput> = {}
): AnalyzerOutput {
  return {
    analyzer_key: key,
    score,
    evidence: [{ label: `${key} ev`, direction: score > 0 ? 'bullish' : 'bearish', weight: 1 }],
    data_sources: [],
    confidence,
    data_missing: [],
    error: null,
    elapsed_ms: 1,
    ...extra,
  };
}

(() => {
  const agg = new DecisionAggregator();

  // 1. data_quality critical → hold
  const d1 = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: [makeAnalyzer('fundamental', 80)],
    data_quality: dqCritical(),
    current_price: 100,
  });
  assert(d1.action === 'hold', `critical → hold (got ${d1.action})`);
  assert(d1.overall_confidence === 0, 'critical → overall_confidence=0');

  // 2. EventAnalyzer veto → hold (no position)
  const d2 = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: [
      makeAnalyzer('fundamental', 80),
      makeAnalyzer('event', -100, 0.8, { event_action: 'veto' }),
    ],
    data_quality: dqGood(),
    current_price: 100,
    has_open_position: false,
  });
  assert(d2.action === 'hold', `event veto + no position → hold (got ${d2.action})`);
  assert(d2.suggested_position_pct === 0, 'event veto → suggested=0');

  // 2b. EventAnalyzer veto + has_open_position → sell
  const d2b = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: [
      makeAnalyzer('fundamental', 80),
      makeAnalyzer('event', -100, 0.8, { event_action: 'veto' }),
    ],
    data_quality: dqGood(),
    current_price: 100,
    has_open_position: true,
  });
  assert(d2b.action === 'sell', `event veto + position → sell (got ${d2b.action})`);

  // 3. RiskAnalyzer score < -80 → hard veto
  const d3 = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: [makeAnalyzer('fundamental', 80), makeAnalyzer('risk', -90)],
    data_quality: dqGood(),
    current_price: 100,
  });
  assert(d3.action === 'hold', `risk score=-90 → hold (got ${d3.action})`);

  // 4. event dampen → weighted score × 0.5
  // 全部 +65 → 应该 strong_buy (≥60); dampen × 0.5 后 +32.5 → buy (≥30)
  const allBull = [
    makeAnalyzer('fundamental', 65),
    makeAnalyzer('technical', 65),
    makeAnalyzer('capital', 65),
    makeAnalyzer('news', 65),
    makeAnalyzer('sentiment', 65),
    makeAnalyzer('industry_regime', 65),
    makeAnalyzer('risk', 65),
    makeAnalyzer('event', 65),
  ];
  const noDampenDecision = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: allBull,
    data_quality: dqGood(),
    current_price: 100,
  });
  assert(
    noDampenDecision.action === 'strong_buy',
    `all +65 → strong_buy (got ${noDampenDecision.action})`
  );

  const allBullDampened = [...allBull];
  allBullDampened[7] = makeAnalyzer('event', 65, 0.8, { event_action: 'dampen' });
  const dampenDecision = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: allBullDampened,
    data_quality: dqGood(),
    current_price: 100,
  });
  // 65 × 0.5 = 32.5 → 'buy' (>=30)
  assert(
    dampenDecision.action === 'buy',
    `dampened all +65 → buy (got ${dampenDecision.action})`
  );

  // 5. score map 阈值
  assert(mapScoreToAction(80) === 'strong_buy', 'mapScore 80 = strong_buy');
  assert(mapScoreToAction(35) === 'buy', 'mapScore 35 = buy');
  assert(mapScoreToAction(20) === 'add', 'mapScore 20 = add');
  assert(mapScoreToAction(0) === 'hold', 'mapScore 0 = hold');
  assert(mapScoreToAction(-20) === 'reduce', 'mapScore -20 = reduce');
  assert(mapScoreToAction(-45) === 'sell', 'mapScore -45 = sell');
  assert(mapScoreToAction(-80) === 'strong_sell', 'mapScore -80 = strong_sell');

  // normalizeWeights: empty → default, sum=1
  const w1 = normalizeWeights(undefined);
  const sum1 = Object.values(w1).reduce((a, b) => a + b, 0);
  assert(Math.abs(sum1 - 1) < 1e-6, `normalizeWeights default sum=1`);

  const w2 = normalizeWeights({ fundamental: 100, technical: 0 });
  // re-normalize 后 sum=1 (其他 7 个 default + 给的 2 个)
  const sum2 = Object.values(w2).reduce((a, b) => a + b, 0);
  assert(Math.abs(sum2 - 1) < 1e-6, `normalizeWeights custom sum=1`);

  // pickEntryZone with 涨跌停修正 (chinext 20%)
  const ez = pickEntryZone([80, 95], 100, 'chinext', false);
  assert(!!ez && ez[0] === 80 && ez[1] === 95, `entry_zone within band (got ${JSON.stringify(ez)})`);
  // 涨跌停夹紧: 当 buy_zone 超过涨停下限
  const ezClamp = pickEntryZone([60, 90], 100, 'main', false);
  // main 跌停 = 90
  assert(!!ezClamp && ezClamp[0] === 90, `entry_zone clamp to down limit (got ${JSON.stringify(ezClamp)})`);

  // pickStopLoss
  assert(pickStopLoss([95, 90], 100, null) === 95, 'stop_loss = support[0]');
  assert(pickStopLoss([], 100, 2) === 96, 'stop_loss = price - 2*atr');
  assert(pickStopLoss([], 100, null) === 93, 'stop_loss fallback = 0.93×price');

  // ----------------------------------------------------------------
  // AE-010 (US-115) — ATR-adjusted stop: max(support[0], close - 2×ATR)
  // ----------------------------------------------------------------

  // (a) support[0] 与 close - 2*ATR 都可用 → 取较高 (更紧)
  //     support=95, atrStop=100-2*2=96 → max=96 (ATR stop 更紧)
  assert(
    pickStopLoss([95, 90], 100, 2) === 96,
    `AE-010: max(support=95, close-2*ATR=96) = 96 (got ${pickStopLoss([95, 90], 100, 2)})`
  );
  // support=98 较紧, atrStop=100-4=96 → max=98 (support 更紧)
  assert(
    pickStopLoss([98], 100, 2) === 98,
    `AE-010: max(support=98, close-2*ATR=96) = 98 (got ${pickStopLoss([98], 100, 2)})`
  );
  // 极端: support=95, ATR=10 → atrStop=80 → max=95 (support 远紧于 ATR)
  assert(
    pickStopLoss([95], 100, 10) === 95,
    `AE-010: max(support=95, close-2*ATR=80) = 95 (got ${pickStopLoss([95], 100, 10)})`
  );

  // (b) 安全 guard: max 结果 ≥ currentPrice → 退化到较小者
  //     support=105 (已被击穿/在 price 之上), ATR=2 → atrStop=96 → max=105 ≥ 100 → 退化到 96
  assert(
    pickStopLoss([105], 100, 2) === 96,
    `AE-010 guard: max≥price 退化到较小 ATR stop (got ${pickStopLoss([105], 100, 2)})`
  );
  // 双源都 ≥ price → 跌回 0.93×price 兜底 (support=105, ATR=0.0... → atrStop=99.99 也 ≥100? no 99.99 <100)
  // 构造双源都 ≥ price: support=105, currentPrice=100, ATR=-1 不行 (atr>0 守); 用 support=105 + 没 ATR
  // 走 support-only path: support=105 直接返回 (不在双源 guard 内). 这正是历史行为, 不应破坏.
  assert(
    pickStopLoss([105], 100, null) === 105,
    `AE-010: support-only 即便 ≥ price 仍返回 support (不在双源 guard 内, 与历史一致)`
  );

  // (c) 老契约不变: 只有 support → support[0]; 只有 ATR → close - 2*ATR; 都无 → 0.93×price; 全无 → null
  assert(pickStopLoss(undefined, 100, null) === 93, 'AE-010: 老 fallback 不变 (0.93×price)');
  assert(pickStopLoss(undefined, null, null) === null, 'AE-010: 全 null → null');
  assert(pickStopLoss([], null, 2) === null, 'AE-010: 只有 ATR 但无 price → null');

  // (d) 非法值 fail-safe: support[0]=NaN / atr=NaN / atr=0 / atr<0 → 退到对应单源 / 兜底
  assert(
    pickStopLoss([NaN, 90], 100, 2) === 96,
    `AE-010: NaN support → 退到 ATR stop (got ${pickStopLoss([NaN, 90], 100, 2)})`
  );
  assert(
    pickStopLoss([95], 100, NaN) === 95,
    `AE-010: NaN ATR → 退到 support (got ${pickStopLoss([95], 100, NaN)})`
  );
  assert(
    pickStopLoss([95], 100, 0) === 95,
    `AE-010: atr=0 → 退到 support (got ${pickStopLoss([95], 100, 0)})`
  );
  assert(
    pickStopLoss([95], 100, -1) === 95,
    `AE-010: atr<0 → 退到 support (got ${pickStopLoss([95], 100, -1)})`
  );

  // (e) 联立属性: 双源都有时, 结果永远 ≥ 单 support / 单 ATR 任一 (取 max 不变小)
  const supportOnly = pickStopLoss([95], 100, null);
  const atrOnly = pickStopLoss([], 100, 2);
  const both = pickStopLoss([95], 100, 2);
  assert(
    supportOnly !== null && atrOnly !== null && both !== null,
    `AE-010 联立 sanity: 三路径均非 null`
  );
  assert(
    (both as number) >= (supportOnly as number) && (both as number) >= (atrOnly as number),
    `AE-010 联立: max(support,ATR) ≥ support 且 ≥ ATR (got both=${both} support=${supportOnly} atr=${atrOnly})`
  );

  // META-GUARD: pickStopLoss 实现必须真用 Math.max 把两源合并 (防回退到单源)
  const aggSrcForAtr = fs.readFileSync(
    path.resolve(__dirname, '../../../src/services/analysis-engine/DecisionAggregator.ts'),
    'utf-8'
  );
  // 抽 pickStopLoss 函数体 (从 export function pickStopLoss 到下一个 export)
  const fnMatch = aggSrcForAtr.match(/export function pickStopLoss[\s\S]*?\n\}\n/);
  assert(fnMatch !== null, 'meta: pickStopLoss 函数体抽取成功');
  const fnBody = fnMatch ? fnMatch[0] : '';
  assert(
    /Math\.max\s*\(/.test(fnBody),
    'meta AE-010: pickStopLoss 必须用 Math.max 合并 support + ATR 双源'
  );
  assert(
    /2\s*\*/.test(fnBody),
    'meta AE-010: pickStopLoss 必须含 `2 *` 系数 (close - 2*ATR)'
  );

  // pickTakeProfit
  assert(pickTakeProfit([120, 130], 100, null) === 120, 'take_profit = resistance[0]');
  assert(pickTakeProfit([], 100, 3) === 109, 'take_profit = price + 3*atr');

  // ----------------------------------------------------------------
  // AE-006 (US-112) — pickEntryZone 走 marketLimits.ts 单一权威, 全市场段矩阵
  // ----------------------------------------------------------------
  // ST 主板 5% (与历史 inline 一致, 但口径来自 marketLimits.ST_LIMIT_PCT)
  const ezST = pickEntryZone([90, 99], 100, 'main', true);
  // ST 下限 = 95, buy_zone [90,99] → clamp 到 [95,99]
  assert(
    !!ezST && ezST[0] === 95 && ezST[1] === 99,
    `ST clamp to ±5% (got ${JSON.stringify(ezST)})`
  );

  // 北交所 30%: buy_zone 在区间内不动
  const ezBJ = pickEntryZone([72, 128], 100, 'bj', false);
  assert(
    !!ezBJ && ezBJ[0] === 72 && ezBJ[1] === 128,
    `BJ 30% no clamp (got ${JSON.stringify(ezBJ)})`
  );

  // 科创板 20%: buy_zone 全部超下限 → 反弹到 [down, up]
  const ezSTAR = pickEntryZone([50, 60], 100, 'star', false);
  // star: down=80, up=120, lo=max(50,80)=80, hi=min(60,120)=60 → lo>=hi → reset to [80,120]
  assert(
    !!ezSTAR && ezSTAR[0] === 80 && ezSTAR[1] === 120,
    `STAR clamp degenerate → full band (got ${JSON.stringify(ezSTAR)})`
  );

  // unknown 段兜底 = 主板 10%
  const ezUnknown = pickEntryZone([85, 95], 100, undefined, false);
  assert(
    !!ezUnknown && ezUnknown[0] === 90,
    `unknown segment fallback to main 10% (got ${JSON.stringify(ezUnknown)})`
  );

  // 与 marketLimits.getLimitPrices 字节对齐: pickEntryZone 与 getLimitPrices 同源
  const bandST = getLimitPrices(100, 'main', true);
  assert(bandST.upper === 105 && bandST.lower === 95, `marketLimits ST band sanity`);
  const bandSTAR = getLimitPrices(100, 'star', false);
  assert(bandSTAR.upper === 120 && bandSTAR.lower === 80, `marketLimits STAR band sanity`);

  // buy_zone null + currentPrice null → 真 null
  assert(pickEntryZone(null, null, 'main', false) === null, 'pickEntryZone null both = null');

  // ----------------------------------------------------------------
  // AE-006 meta-test guard: DecisionAggregator.ts 必须 import marketLimits 且不再
  // inline 写涨跌停百分比 (照搬 [5] cron-registry / [6] PCA 双向一致性 guard 模式).
  // ----------------------------------------------------------------
  const aggSrcPath = path.resolve(
    __dirname,
    '../../../src/services/analysis-engine/DecisionAggregator.ts'
  );
  const aggSrc = fs.readFileSync(aggSrcPath, 'utf-8');
  assert(
    /from\s+['"][^'"]*quant\/marketLimits['"]/.test(aggSrc),
    'meta: DecisionAggregator imports quant/marketLimits'
  );
  assert(
    /getLimitPrices\s*\(/.test(aggSrc),
    'meta: DecisionAggregator calls getLimitPrices(...)'
  );
  assert(
    !/function\s+applyLimitPrice\s*\(/.test(aggSrc),
    'meta: legacy inline applyLimitPrice() removed'
  );
  // 不再硬编码 0.2 / 0.3 / 0.05 涨跌停百分比 (允许 0.93/1.12/0.98/1.02 等 ATR/兜底常数)
  const segmentPctLit = /(?:chinext|star|bj|isSt|isST)[^\n]{0,60}(?:0\.2(?!\d)|0\.3(?!\d)|0\.05(?!\d))/;
  assert(
    !segmentPctLit.test(aggSrc),
    'meta: no inline 0.2/0.3/0.05 next to segment literals (must go via marketLimits)'
  );

  // ----------------------------------------------------------------
  // AE-008 (US-114) — confidence_tier 三档分桶 + 阈值常量 sanity + aggregator 3 路径全填
  // ----------------------------------------------------------------

  // 阈值常量 sanity (与 [[shadowRunHelpers]] HEALTHY_MIN > DEGRADED_MIN 同款守 sanity)
  assert(
    CONFIDENCE_TIER_HIGH_MIN > CONFIDENCE_TIER_MEDIUM_MIN,
    `tier thresholds: HIGH_MIN (${CONFIDENCE_TIER_HIGH_MIN}) > MEDIUM_MIN (${CONFIDENCE_TIER_MEDIUM_MIN})`
  );
  assert(CONFIDENCE_TIER_MEDIUM_MIN > 0, 'MEDIUM_MIN > 0');
  assert(CONFIDENCE_TIER_HIGH_MIN <= 1, 'HIGH_MIN ≤ 1');

  // pickConfidenceTier — high 边界 (恰好 / 略低 / 远低; off-by-one 防御)
  assert(pickConfidenceTier(CONFIDENCE_TIER_HIGH_MIN) === 'high', `≥ HIGH_MIN → high`);
  assert(
    pickConfidenceTier(CONFIDENCE_TIER_HIGH_MIN - 0.0001) === 'medium',
    `< HIGH_MIN → medium (off-by-one boundary)`
  );
  assert(pickConfidenceTier(0.99) === 'high', `0.99 → high`);
  assert(pickConfidenceTier(1) === 'high', `1.0 → high`);

  // pickConfidenceTier — medium 边界
  assert(pickConfidenceTier(CONFIDENCE_TIER_MEDIUM_MIN) === 'medium', `≥ MEDIUM_MIN → medium`);
  assert(
    pickConfidenceTier(CONFIDENCE_TIER_MEDIUM_MIN - 0.0001) === 'low',
    `< MEDIUM_MIN → low (off-by-one boundary)`
  );
  assert(pickConfidenceTier(0.5) === 'medium', `0.5 → medium`);

  // pickConfidenceTier — low + 非法值 fail-safe (任何 NaN/Infinity/null/undefined/负数 → low)
  assert(pickConfidenceTier(0) === 'low', `0 → low`);
  assert(pickConfidenceTier(0.39) === 'low', `0.39 → low`);
  assert(pickConfidenceTier(NaN) === 'low', `NaN → low (fail-safe)`);
  assert(pickConfidenceTier(Infinity) === 'low', `Infinity → low (fail-safe)`);
  assert(pickConfidenceTier(-Infinity) === 'low', `-Infinity → low (fail-safe)`);
  assert(pickConfidenceTier(null) === 'low', `null → low (fail-safe)`);
  assert(pickConfidenceTier(undefined) === 'low', `undefined → low (fail-safe)`);
  assert(pickConfidenceTier(-0.5) === 'low', `negative → low (fail-safe)`);

  // aggregator 3 个返回路径全填 confidence_tier
  // (a) data_quality=critical → overall_confidence=0 → tier='low'
  assert(d1.confidence_tier === 'low', `critical path → tier=low (got ${d1.confidence_tier})`);
  // (b) hard veto → overall_confidence=0.3 → tier='low' (0.3 < 0.4)
  assert(d2.confidence_tier === 'low', `veto path → tier=low (got ${d2.confidence_tier})`);
  assert(d3.confidence_tier === 'low', `risk hard veto → tier=low (got ${d3.confidence_tier})`);

  // (c) 正常路径 — 所有 analyzer confidence=0.8 + data_quality.coefficient=1 → avg=0.8 → high
  assert(
    noDampenDecision.confidence_tier === 'high',
    `all-bull confidence=0.8 → tier=high (got ${noDampenDecision.confidence_tier})`
  );

  // (c2) 正常路径 — confidence 拉到 medium 档 (8 analyzer 全填, 单 confidence=0.55 → 0.55*1=0.55 → medium)
  const mediumDecision = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: [
      makeAnalyzer('fundamental', 20, 0.55),
      makeAnalyzer('technical', 20, 0.55),
      makeAnalyzer('capital', 20, 0.55),
      makeAnalyzer('news', 20, 0.55),
      makeAnalyzer('sentiment', 20, 0.55),
      makeAnalyzer('industry_regime', 20, 0.55),
      makeAnalyzer('risk', 20, 0.55),
      makeAnalyzer('event', 20, 0.55),
    ],
    data_quality: dqGood(),
    current_price: 100,
  });
  assert(
    mediumDecision.confidence_tier === 'medium',
    `confidence ≈ 0.55 → medium (got ${mediumDecision.overall_confidence} → ${mediumDecision.confidence_tier})`
  );

  // (c3) 正常路径 — coefficient 拖低到 low 档
  const lowDecision = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: [
      makeAnalyzer('fundamental', 20, 0.5),
      makeAnalyzer('technical', 20, 0.5),
      makeAnalyzer('capital', 20, 0.5),
      makeAnalyzer('news', 20, 0.5),
      makeAnalyzer('sentiment', 20, 0.5),
      makeAnalyzer('industry_regime', 20, 0.5),
      makeAnalyzer('risk', 20, 0.5),
      makeAnalyzer('event', 20, 0.5),
    ],
    data_quality: {
      level: 'degraded',
      missing_critical: [],
      missing_optional: ['x'],
      notes: [],
      coefficient: 0.5,
    },
    current_price: 100,
  });
  assert(
    lowDecision.confidence_tier === 'low',
    `confidence 拖低 → low (got ${lowDecision.overall_confidence} → ${lowDecision.confidence_tier})`
  );

  // META-GUARD: DecisionAggregator.ts 必须 export pickConfidenceTier + 常量 + 3 个 return 路径都填
  const aggSrcPath2 = path.resolve(
    __dirname,
    '../../../src/services/analysis-engine/DecisionAggregator.ts'
  );
  const aggSrc2 = fs.readFileSync(aggSrcPath2, 'utf-8');
  assert(
    /export\s+function\s+pickConfidenceTier\s*\(/.test(aggSrc2),
    'meta: pickConfidenceTier exported'
  );
  assert(
    /export\s+const\s+CONFIDENCE_TIER_HIGH_MIN/.test(aggSrc2) &&
      /export\s+const\s+CONFIDENCE_TIER_MEDIUM_MIN/.test(aggSrc2),
    'meta: 两档阈值常量 export'
  );
  // 3 个 return 路径都必须含 confidence_tier — 数 occurrences ≥ 3
  const tierOccurrences = (aggSrc2.match(/confidence_tier:\s*pickConfidenceTier/g) || []).length;
  assert(
    tierOccurrences >= 3,
    `meta: aggregator 3 个 return 路径全填 confidence_tier (found ${tierOccurrences})`
  );

  // META-GUARD: archive + hardShortCircuit metadata 必须含 confidence_tier (下游可见)
  const archiveSrc = fs.readFileSync(
    path.resolve(__dirname, '../../../src/services/analysis-engine/analysisEngineSignalArchive.ts'),
    'utf-8'
  );
  assert(
    /confidence_tier:\s*decision\.confidence_tier/.test(archiveSrc),
    'meta: archive metadata 含 confidence_tier'
  );
  const hardSrc = fs.readFileSync(
    path.resolve(__dirname, '../../../src/services/analysis-engine/hardShortCircuit.ts'),
    'utf-8'
  );
  assert(
    /confidence_tier:\s*decision\.confidence_tier/.test(hardSrc),
    'meta: hardShortCircuit metadata 含 confidence_tier'
  );

  // ----------------------------------------------------------------
  // BA-A (用户清单 #14) — position_action 4 档语义 + hold 双形态
  // ----------------------------------------------------------------

  // derivePositionAction 纯函数 — 12 case 覆盖 (action × has_open_position 矩阵)
  // hold + 有持仓 → maintain (区别于"不建仓")
  assert(
    derivePositionAction('hold', true) === 'maintain',
    `hold + 持仓 → maintain (got ${derivePositionAction('hold', true)})`
  );
  // hold + 无持仓 → avoid (区别于"维持现有")
  assert(
    derivePositionAction('hold', false) === 'avoid',
    `hold + 无持仓 → avoid (got ${derivePositionAction('hold', false)})`
  );
  // hold + undefined → avoid (默认无持仓; "不建议"是更保守的兜底, 不会让用户误以为持仓存在)
  assert(
    derivePositionAction('hold', undefined) === 'avoid',
    `hold + undefined → avoid (defaults to avoid)`
  );
  // buy / strong_buy / add → open (不分有无持仓)
  assert(derivePositionAction('strong_buy', false) === 'open', 'strong_buy → open');
  assert(derivePositionAction('buy', true) === 'open', 'buy + 持仓 → open (加仓)');
  assert(derivePositionAction('add', false) === 'open', 'add → open');
  // reduce / sell / strong_sell + 有持仓 → close
  assert(derivePositionAction('reduce', true) === 'close', 'reduce + 持仓 → close');
  assert(derivePositionAction('sell', true) === 'close', 'sell + 持仓 → close');
  assert(derivePositionAction('strong_sell', true) === 'close', 'strong_sell + 持仓 → close');
  // reduce / sell / strong_sell + 无持仓 → avoid (无需操作)
  assert(derivePositionAction('reduce', false) === 'avoid', 'reduce + 无持仓 → avoid');
  assert(derivePositionAction('sell', false) === 'avoid', 'sell + 无持仓 → avoid');
  assert(derivePositionAction('strong_sell', undefined) === 'avoid', 'strong_sell + undef → avoid');

  // aggregator 3 个 return 路径都必须填 position_action
  // (a) critical hold + 有持仓 → action=hold + position_action=maintain
  const dCriticalHeld = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: [makeAnalyzer('fundamental', 80)],
    data_quality: dqCritical(),
    current_price: 100,
    has_open_position: true,
  });
  assert(
    dCriticalHeld.action === 'hold' && dCriticalHeld.position_action === 'maintain',
    `critical + 持仓 → action=hold + position_action=maintain (got ${dCriticalHeld.action} / ${dCriticalHeld.position_action})`
  );
  // (a2) critical hold + 无持仓 → action=hold + position_action=avoid
  assert(
    d1.position_action === 'avoid',
    `critical + 无持仓 → position_action=avoid (got ${d1.position_action})`
  );

  // (b) veto + 持仓 → action=sell + position_action=close
  assert(
    d2b.position_action === 'close',
    `veto + 持仓 → position_action=close (got ${d2b.position_action})`
  );
  // (b2) veto + 无持仓 → action=hold + position_action=avoid
  assert(
    d2.position_action === 'avoid',
    `veto + 无持仓 → position_action=avoid (got ${d2.position_action})`
  );

  // (c) 正常路径 strong_buy → position_action=open
  assert(
    noDampenDecision.position_action === 'open',
    `strong_buy → position_action=open (got ${noDampenDecision.position_action})`
  );
  // (c2) 正常路径 + 有持仓 + strong_buy → open
  const noDampenWithPos = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: [...allBull],
    data_quality: dqGood(),
    current_price: 100,
    has_open_position: true,
  });
  assert(
    noDampenWithPos.position_action === 'open',
    `strong_buy + 持仓 → open (加仓; got ${noDampenWithPos.position_action})`
  );

  // (c3) 正常路径 hold (全部 0 分) + 有持仓 → maintain
  const allZero = [
    makeAnalyzer('fundamental', 0),
    makeAnalyzer('technical', 0),
    makeAnalyzer('capital', 0),
    makeAnalyzer('news', 0),
    makeAnalyzer('sentiment', 0),
    makeAnalyzer('industry_regime', 0),
    makeAnalyzer('risk', 0),
    makeAnalyzer('event', 0),
  ];
  const dHoldHeld = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: allZero,
    data_quality: dqGood(),
    current_price: 100,
    has_open_position: true,
  });
  assert(
    dHoldHeld.action === 'hold' && dHoldHeld.position_action === 'maintain',
    `正常 hold + 持仓 → action=hold + position_action=maintain (got ${dHoldHeld.action} / ${dHoldHeld.position_action})`
  );
  const dHoldNoPos = agg.aggregate({
    stock_code: 'sh.600519',
    as_of: '2026-06-18',
    analyzers: allZero,
    data_quality: dqGood(),
    current_price: 100,
    has_open_position: false,
  });
  assert(
    dHoldNoPos.action === 'hold' && dHoldNoPos.position_action === 'avoid',
    `正常 hold + 无持仓 → action=hold + position_action=avoid (got ${dHoldNoPos.action} / ${dHoldNoPos.position_action})`
  );

  // META-GUARD: derivePositionAction 必须 export + aggregator 3 个 return 路径全部填
  assert(
    /export\s+function\s+derivePositionAction\s*\(/.test(aggSrc2),
    'meta: derivePositionAction exported'
  );
  const posActionOccurrences = (
    aggSrc2.match(/position_action:\s*derivePositionAction/g) || []
  ).length;
  assert(
    posActionOccurrences >= 3,
    `meta: aggregator 3 个 return 路径全填 position_action (found ${posActionOccurrences})`
  );

  // META-GUARD: archive / hardShortCircuit metadata 含 position_action
  assert(
    /position_action:\s*decision\.position_action/.test(archiveSrc),
    'meta: archive metadata 含 position_action'
  );
  assert(
    /position_action:\s*decision\.position_action/.test(hardSrc),
    'meta: hardShortCircuit metadata 含 position_action'
  );

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
