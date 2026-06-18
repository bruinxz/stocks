/**
 * DecisionAggregator.test.ts — 5 case (veto / dampen / 各 action 阈值 / data_quality critical).
 */

import {
  DecisionAggregator,
  mapScoreToAction,
  normalizeWeights,
  pickEntryZone,
  pickStopLoss,
  pickTakeProfit,
} from '../../../src/services/analysis-engine/DecisionAggregator';
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

  // pickTakeProfit
  assert(pickTakeProfit([120, 130], 100, null) === 120, 'take_profit = resistance[0]');
  assert(pickTakeProfit([], 100, 3) === 109, 'take_profit = price + 3*atr');

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
