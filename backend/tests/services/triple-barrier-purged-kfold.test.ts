/**
 * Triple Barrier + Purged K-Fold 单测 — v2 #2
 */
import {
  dailyVolatility,
  evaluateTripleBarrier,
  evaluateTripleBarriersBatch,
  BarPoint,
  TripleBarrierEvent,
} from '../../src/services/meta/triple-barrier';
import {
  purgedKFoldSplits,
  sampleUniquenessWeights,
  aggregateFoldMetrics,
  SampleEvent,
} from '../../src/services/meta/purged-k-fold';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}
function expectClose(name: string, actual: number, expected: number, eps = 1e-3) {
  assert(name, Number.isFinite(actual) && Math.abs(actual - expected) < eps, `expected≈${expected}, got=${actual}`);
}

function makeBars(prices: number[], startDate = '2026-01-01'): BarPoint[] {
  const d = new Date(startDate);
  return prices.map((p, i) => {
    const date = new Date(d.getTime() + i * 86400000);
    return { date: date.toISOString().slice(0, 10), close: p };
  });
}

function testDailyVolatility() {
  console.log('\n## dailyVolatility');
  // 单调上涨 → vol 极小
  const bars = Array.from({ length: 50 }, (_, i) => 100 + i);
  const sigma = dailyVolatility(bars, 30);
  assert('长度 = N', sigma.length === bars.length);
  assert('第 1 个 = 0 (no prior)', sigma[0] === 0);
  // 30 之后 vol 应稳定 (单调 trend, vol ~ 0)
  assert('单调上涨 vol 很小', sigma[40] < 0.01, `σ=${sigma[40]}`);

  // 随机波动 → vol 非零
  const random: number[] = [100];
  let s = 42;
  for (let i = 0; i < 99; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    const noise = ((s / 233280) - 0.5) * 0.05;
    random.push(random[random.length - 1] * (1 + noise));
  }
  const sigmaR = dailyVolatility(random, 30);
  assert('随机波动 vol > 0', sigmaR[50] > 0);
}

function testEvaluateTripleBarrier_PT() {
  console.log('\n## evaluateTripleBarrier — pt hit (long)');
  // 价格: 100, 102, 104, 110, 112 → +10% 大涨
  // σ = 0.02, pt = 2 → upper barrier = 100 × (1 + 2 × 0.02) = 104
  const bars = makeBars([100, 102, 104, 110, 112]);
  const out = evaluateTripleBarrier(
    bars,
    { entry_date: bars[0].date, entry_price: 100, side: 1, target_vol: 0.02 },
    { pt: 2, sl: 1, max_holding_days: 5 }
  );
  assert('out exists', out !== null);
  assert('label = +1 (pt hit)', out!.label === 1);
  expectClose('return ≈ 4%', out!.return_pct, 0.04);
  assert('exit at index 2 (price 104)', out!.exit_date === bars[2].date);
}

function testEvaluateTripleBarrier_SL() {
  console.log('\n## evaluateTripleBarrier — sl hit (long)');
  // 价格: 100, 99, 97, 95 → 大跌
  // σ = 0.02, sl = 1 → lower barrier = 100 × (1 - 1 × 0.02) = 98
  const bars = makeBars([100, 99, 97, 95]);
  const out = evaluateTripleBarrier(
    bars,
    { entry_date: bars[0].date, entry_price: 100, side: 1, target_vol: 0.02 },
    { pt: 2, sl: 1, max_holding_days: 5 }
  );
  assert('label = -1 (sl hit)', out!.label === -1);
  expectClose('return ≈ -3%', out!.return_pct, -0.03);
}

function testEvaluateTripleBarrier_Time() {
  console.log('\n## evaluateTripleBarrier — time barrier hit');
  // 价格波动小: 100, 100.5, 101, 100.5, 100, 100.5
  // σ = 0.02, pt = 2 → upper = 104, sl 1 → lower = 98
  // 5 天内都没触 → 时间出场, label = 0
  const bars = makeBars([100, 100.5, 101, 100.5, 100, 100.5]);
  const out = evaluateTripleBarrier(
    bars,
    { entry_date: bars[0].date, entry_price: 100, side: 1, target_vol: 0.02 },
    { pt: 2, sl: 1, max_holding_days: 5 }
  );
  assert('label = 0 (time barrier)', out!.label === 0);
  expectClose('return ≈ 0.5%', out!.return_pct, 0.005);
}

function testEvaluateTripleBarrier_MetaLabel() {
  console.log('\n## evaluateTripleBarrier — meta-labeling mode');
  // side given (long, primary 说 BUY)，触 pt → meta_label = 1 (该下注)
  const bars = makeBars([100, 102, 110]);
  const out = evaluateTripleBarrier(
    bars,
    { entry_date: bars[0].date, entry_price: 100, side: 1, target_vol: 0.02 },
    { pt: 2, sl: 1, max_holding_days: 5 }
  );
  assert('meta_label = 1', out!.meta_label === 1);

  // side given, 触 sl → meta_label = 0
  const bars2 = makeBars([100, 99, 95]);
  const out2 = evaluateTripleBarrier(
    bars2,
    { entry_date: bars2[0].date, entry_price: 100, side: 1, target_vol: 0.02 },
    { pt: 2, sl: 1, max_holding_days: 5 }
  );
  assert('meta_label = 0 (sl)', out2!.meta_label === 0);
}

function testEvaluateTripleBarrier_Short() {
  console.log('\n## evaluateTripleBarrier — short side');
  // SHORT: 价格下跌就是赚钱
  // σ = 0.02, pt = 2 → upper barrier (for short = profit) at 100 * (1 + (-1)*2*0.02) = 96
  // 价格 100 → 96 → label = +1 (pt for short)
  const bars = makeBars([100, 98, 96]);
  const out = evaluateTripleBarrier(
    bars,
    { entry_date: bars[0].date, entry_price: 100, side: -1, target_vol: 0.02 },
    { pt: 2, sl: 1, max_holding_days: 5 }
  );
  assert('short pt hit → label +1', out!.label === 1);
  expectClose('short return ≈ +4%', out!.return_pct, 0.04);
}

function testEvaluateTripleBarriersBatch() {
  console.log('\n## evaluateTripleBarriersBatch');
  const bars = makeBars([100, 102, 105, 103, 99, 95, 92]);
  const events: TripleBarrierEvent[] = [
    { entry_date: bars[0].date, entry_price: 100, side: 1, target_vol: 0.02 },
    { entry_date: bars[3].date, entry_price: 103, side: 1, target_vol: 0.02 },
  ];
  const outs = evaluateTripleBarriersBatch(bars, events, { pt: 2, sl: 1, max_holding_days: 4 });
  assert('返回 2 个 outcomes', outs.length === 2);
}

// ============================================================
// Purged K-Fold tests
// ============================================================

function testPurgedKFoldSplits_basic() {
  console.log('\n## purgedKFoldSplits — basic');
  // 100 samples, K=5, 每段 20 个
  const events: SampleEvent[] = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    entry_time: i,
    exit_time: i + 1, // 1-day holding
  }));
  const folds = purgedKFoldSplits(events, { k: 5, embargo_pct: 0 });
  assert('5 folds', folds.length === 5);
  // 每 fold test ~ 20 samples
  for (const f of folds) {
    assert(`fold ${f.fold_index} test_ids ≈ 20`, f.test_ids.length >= 15 && f.test_ids.length <= 25, `test=${f.test_ids.length}`);
  }
  // train + test ≤ N (because purging may remove some)
  for (const f of folds) {
    assert(`fold ${f.fold_index} no overlap`, !f.train_ids.some(t => f.test_ids.includes(t)));
  }
}

function testPurgedKFoldSplits_purging() {
  console.log('\n## purgedKFoldSplits — purging works');
  // 5 samples with overlapping intervals
  const events: SampleEvent[] = [
    { id: 'A', entry_time: 0, exit_time: 50 },  // 跨整个 fold 2-3 边界
    { id: 'B', entry_time: 10, exit_time: 11 }, // fold 0
    { id: 'C', entry_time: 30, exit_time: 31 }, // fold 1
    { id: 'D', entry_time: 60, exit_time: 61 }, // fold 2
    { id: 'E', entry_time: 90, exit_time: 91 }, // fold 4
  ];
  const folds = purgedKFoldSplits(events, { k: 5, embargo_pct: 0 });
  // fold 0: test_ids 含 A (entry_time=0) 和 B
  // sample A 在所有其他 fold 都被 purged
  let totalPurged = 0;
  for (const f of folds) totalPurged += f.purged_count;
  assert('至少 purge 一些样本', totalPurged > 0, `totalPurged=${totalPurged}`);
}

function testPurgedKFoldSplits_embargo() {
  console.log('\n## purgedKFoldSplits — embargo');
  const events: SampleEvent[] = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    entry_time: i,
    exit_time: i + 0.1,
  }));
  // embargo_pct = 0.05 → embargo span = 5
  const folds = purgedKFoldSplits(events, { k: 5, embargo_pct: 0.05 });
  let totalEmbargoed = 0;
  for (const f of folds) totalEmbargoed += f.embargoed_count;
  assert('embargo 至少推迟一些样本', totalEmbargoed > 0, `embargoed=${totalEmbargoed}`);
}

function testSampleUniquenessWeights() {
  console.log('\n## sampleUniquenessWeights');
  // 3 不重叠 samples → 每个 weight = 1
  const events1: SampleEvent[] = [
    { id: 0, entry_time: 0, exit_time: 1 },
    { id: 1, entry_time: 2, exit_time: 3 },
    { id: 2, entry_time: 4, exit_time: 5 },
  ];
  const w1 = sampleUniquenessWeights(events1);
  expectClose('不重叠 weight = 1', w1[0], 1);
  expectClose('不重叠 weight = 1 (2)', w1[1], 1);

  // 2 重叠 sample → weight = 0.5
  const events2: SampleEvent[] = [
    { id: 0, entry_time: 0, exit_time: 10 },
    { id: 1, entry_time: 5, exit_time: 15 },
  ];
  const w2 = sampleUniquenessWeights(events2);
  expectClose('重叠 weight = 0.5', w2[0], 0.5);
  expectClose('重叠 weight = 0.5 (2)', w2[1], 0.5);
}

function testAggregateFoldMetrics() {
  console.log('\n## aggregateFoldMetrics');
  const metrics = [
    { fold: 0, accuracy: 0.6, auc: 0.65 },
    { fold: 1, accuracy: 0.7, auc: 0.75 },
    { fold: 2, accuracy: 0.65 },
  ];
  const agg = aggregateFoldMetrics(metrics);
  expectClose('mean acc = 0.65', agg.mean_accuracy, 0.65);
  assert('std_accuracy > 0', agg.std_accuracy > 0);
  expectClose('mean auc = 0.70', agg.mean_auc!, 0.70);
  assert('num_folds = 3', agg.num_folds === 3);
}

function main() {
  testDailyVolatility();
  testEvaluateTripleBarrier_PT();
  testEvaluateTripleBarrier_SL();
  testEvaluateTripleBarrier_Time();
  testEvaluateTripleBarrier_MetaLabel();
  testEvaluateTripleBarrier_Short();
  testEvaluateTripleBarriersBatch();
  testPurgedKFoldSplits_basic();
  testPurgedKFoldSplits_purging();
  testPurgedKFoldSplits_embargo();
  testSampleUniquenessWeights();
  testAggregateFoldMetrics();

  console.log(`\n========================================`);
  console.log(`Triple Barrier + Purged K-Fold tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
