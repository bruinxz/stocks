/**
 * MetaLabelService 单测 — Sprint 2A
 */
import {
  MetaLabelService,
  sigmoid,
  computeFeatureStats,
  buildFeatureVector,
  trainLogisticRegression,
  predictConfidence,
  fallbackConfidence,
  DEFAULT_THRESHOLD,
  FEATURE_NAMES,
  TrainingRow,
  RawSignalFeatures,
} from '../../src/services/meta/MetaLabelService';

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

function testSigmoid() {
  console.log('\n## sigmoid');
  expectClose('sigmoid(0)=0.5', sigmoid(0), 0.5);
  expectClose('sigmoid(+inf)≈1', sigmoid(100), 1);
  expectClose('sigmoid(-inf)≈0', sigmoid(-100), 0);
  expectClose('sigmoid(1)≈0.731', sigmoid(1), 0.7310585786);
}

function testComputeFeatureStats() {
  console.log('\n## computeFeatureStats');
  const rows: RawSignalFeatures[] = [
    { signal_score: 70, signal_source: 'quant', regime: 'bull', market_breadth_score: 30, strategy_recent_winrate_30d: 0.55, strategy_recent_payoff_30d: 1.3, market_vol_atr: 5 },
    { signal_score: 60, signal_source: 'ai', regime: 'range', market_breadth_score: 10, strategy_recent_winrate_30d: 0.50, strategy_recent_payoff_30d: 1.1, market_vol_atr: 4 },
    { signal_score: 80, signal_source: 'quant', regime: 'bull', market_breadth_score: 50, strategy_recent_winrate_30d: 0.60, strategy_recent_payoff_30d: 1.5, market_vol_atr: 6 },
  ];
  const { means, stds } = computeFeatureStats(rows);
  expectClose('signal_score 均值=70', means.signal_score_z, 70);
  assert('signal_score std > 0', stds.signal_score_z > 0);
  // one-hot 字段 default mean=0 std=1
  expectClose('source_quant mean=0', means.source_quant, 0);
  expectClose('source_quant std=1', stds.source_quant, 1);
}

function testBuildFeatureVector() {
  console.log('\n## buildFeatureVector');
  const means: any = {};
  const stds: any = {};
  for (const n of FEATURE_NAMES) {
    means[n] = 0;
    stds[n] = 1;
  }
  means.signal_score_z = 70;
  stds.signal_score_z = 10;
  const v = buildFeatureVector(
    {
      signal_score: 80,
      signal_source: 'quant',
      regime: 'bull',
      market_breadth_score: 20,
      strategy_recent_winrate_30d: 0.5,
      strategy_recent_payoff_30d: 1.2,
      market_vol_atr: 5,
    },
    means,
    stds
  );
  expectClose('signal_score_z = (80-70)/10 = 1', v.signal_score_z, 1);
  assert('source_quant = 1', v.source_quant === 1);
  assert('source_ai = 0', v.source_ai === 0);
  assert('regime_bull = 1', v.regime_bull === 1);
  assert('regime_bear = 0', v.regime_bear === 0);
}

function generateSyntheticTrainingData(n: number, seed = 0): TrainingRow[] {
  // 简单线性可分: signal_score > 50 + regime=bull => label=1，否则 label=0
  const out: TrainingRow[] = [];
  let s = seed;
  const random = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = 0; i < n; i += 1) {
    const score = 30 + Math.floor(random() * 60);
    const regime = random() > 0.5 ? 'bull' : 'bear';
    const label: 0 | 1 = score > 50 && regime === 'bull' ? 1 : 0;
    out.push({
      features: {
        signal_score: score,
        signal_source: 'quant',
        regime,
        market_breadth_score: 0,
        strategy_recent_winrate_30d: 0.5,
        strategy_recent_payoff_30d: 1.0,
        market_vol_atr: 4,
      },
      label,
    });
  }
  return out;
}

function testTrainLogisticRegression() {
  console.log('\n## trainLogisticRegression');
  const rows = generateSyntheticTrainingData(200, 42);
  const model = trainLogisticRegression(rows, { max_iter: 200, learning_rate: 0.1 });
  assert('model has version', typeof model.version === 'string' && model.version.startsWith('v1-logistic-'));
  assert('trained_samples = 200', model.trained_samples === 200);
  assert('insample_accuracy > 0.7', model.insample_accuracy > 0.7, `acc=${model.insample_accuracy}`);
  assert('insample > baseline', model.insample_accuracy >= model.baseline_accuracy);
  // 训练样本不足应抛错
  let threw = false;
  try {
    trainLogisticRegression([]);
  } catch (e) {
    threw = true;
  }
  assert('训练样本=0 → throw', threw);
}

function testPredictConfidence() {
  console.log('\n## predictConfidence');
  const rows = generateSyntheticTrainingData(200, 42);
  const model = trainLogisticRegression(rows, { max_iter: 300, learning_rate: 0.1 });
  // 正样本：score=80 + bull
  const p1 = predictConfidence(model, {
    signal_score: 80,
    signal_source: 'quant',
    regime: 'bull',
    market_breadth_score: 0,
    strategy_recent_winrate_30d: 0.5,
    strategy_recent_payoff_30d: 1.0,
    market_vol_atr: 4,
  });
  // 负样本：score=20 + bear
  const p2 = predictConfidence(model, {
    signal_score: 20,
    signal_source: 'quant',
    regime: 'bear',
    market_breadth_score: 0,
    strategy_recent_winrate_30d: 0.5,
    strategy_recent_payoff_30d: 1.0,
    market_vol_atr: 4,
  });
  assert('正样本 confidence > 0.5', p1.confidence > 0.5, `conf=${p1.confidence}`);
  assert('负样本 confidence < 0.5', p2.confidence < 0.5, `conf=${p2.confidence}`);
  assert('正样本 confidence > 负样本', p1.confidence > p2.confidence);
  assert('contributions 排序后第一个有贡献', p1.contributions.length > 0 && Math.abs(p1.contributions[0].contribution) > 0);
}

function testFallbackConfidence() {
  console.log('\n## fallbackConfidence');
  const f1 = fallbackConfidence({
    signal_score: 80,
    signal_source: 'quant',
    regime: 'bull',
    market_breadth_score: 0,
    strategy_recent_winrate_30d: 0.5,
    strategy_recent_payoff_30d: 1.0,
    market_vol_atr: 4,
  });
  assert('bull 80 → confidence > 0.5', f1.confidence > 0.5, `conf=${f1.confidence}`);

  const f2 = fallbackConfidence({
    signal_score: 30,
    signal_source: 'quant',
    regime: 'bear',
    market_breadth_score: 0,
    strategy_recent_winrate_30d: 0.5,
    strategy_recent_payoff_30d: 1.0,
    market_vol_atr: 4,
  });
  assert('bear 30 → confidence < 0.5', f2.confidence < 0.5, `conf=${f2.confidence}`);
}

async function testServiceShouldBet() {
  console.log('\n## shouldBet end-to-end');
  const svc = new MetaLabelService();
  // 无模型 → fallback
  const r1 = await svc.shouldBet(
    {
      symbol: 'sh.600000',
      as_of_date: '2026-06-13',
      features: {
        signal_score: 80,
        signal_source: 'quant',
        regime: 'bull',
        market_breadth_score: 0,
        strategy_recent_winrate_30d: 0.5,
        strategy_recent_payoff_30d: 1.0,
        market_vol_atr: 4,
      },
    },
    { persist: false }
  );
  assert('无模型 → fallback model_version', r1.model_version === 'fallback-rule');
  assert('confidence ∈ [0, 1]', r1.confidence >= 0 && r1.confidence <= 1);

  // 训练 → 使用模型
  const rows = generateSyntheticTrainingData(100, 42);
  const model = await svc.train(rows);
  assert('训练成功', model.trained_samples === 100);

  const r2 = await svc.shouldBet(
    {
      symbol: 'sh.600000',
      as_of_date: '2026-06-13',
      features: {
        signal_score: 80,
        signal_source: 'quant',
        regime: 'bull',
        market_breadth_score: 0,
        strategy_recent_winrate_30d: 0.5,
        strategy_recent_payoff_30d: 1.0,
        market_vol_atr: 4,
      },
    },
    { persist: false }
  );
  assert('使用 trained model', r2.model_version.startsWith('v1-logistic-'));
  assert('decision = bet/skip', r2.decision === 'bet' || r2.decision === 'skip');

  // 自定义 threshold 高 → skip
  const r3 = await svc.shouldBet(
    {
      symbol: 'sh.600000',
      as_of_date: '2026-06-13',
      features: {
        signal_score: 60,
        signal_source: 'quant',
        regime: 'bull',
        market_breadth_score: 0,
        strategy_recent_winrate_30d: 0.5,
        strategy_recent_payoff_30d: 1.0,
        market_vol_atr: 4,
      },
    },
    { threshold: 0.95, persist: false }
  );
  // 极高 threshold 大概率 skip
  assert('极高 threshold → skip', r3.decision === 'skip', `conf=${r3.confidence}`);
}

async function main() {
  testSigmoid();
  testComputeFeatureStats();
  testBuildFeatureVector();
  testTrainLogisticRegression();
  testPredictConfidence();
  testFallbackConfidence();
  await testServiceShouldBet();
  console.log(`\n========================================`);
  console.log(`MetaLabelService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
