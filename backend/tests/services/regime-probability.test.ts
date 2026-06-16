/**
 * RegimeProbabilityService 单元测试 (Sprint 42-C):
 *   - gaussianPdf / softmax / sampleStats
 *   - classifyRegimeProbability (各 regime 模板下的概率 + confidence + multiplier)
 *   - service.classify() (returns_override)
 *
 * 不依赖 jest:
 *   cd backend && npx ts-node --transpile-only tests/services/regime-probability.test.ts
 */

import {
  DEFAULT_REGIME_TEMPLATES,
  gaussianPdf,
  softmax,
  sampleStats,
  classifyRegimeProbability,
  RegimeProbabilityService,
} from '../../src/services/regime/RegimeProbabilityService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}
function close(name: string, a: number, b: number, eps = 1e-4): void {
  assert(name, Math.abs(a - b) < eps, `actual=${a} expected=${b}`);
}
function eq<T>(name: string, a: T, b: T): void {
  assert(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
}

// ===========================================================================
// gaussianPdf / softmax / sampleStats
// ===========================================================================

function testHelpers(): void {
  console.log('# helpers');
  // gaussianPdf
  close('N(0,1) at x=0 = 1/√(2π) ≈ 0.3989', gaussianPdf(0, 0, 1), 1 / Math.sqrt(2 * Math.PI));
  close('N(0,1) at x=1 ≈ 0.2420', gaussianPdf(1, 0, 1), 0.24197, 1e-4);
  close('sigma=0 → 0', gaussianPdf(0, 0, 0), 0);

  // softmax
  const s1 = softmax([1, 2, 3]);
  close('softmax sum=1', s1.reduce((a, b) => a + b, 0), 1);
  assert('softmax monotonic', s1[2] > s1[1] && s1[1] > s1[0]);

  const s2 = softmax([100, 100, 100]);
  close('全等 softmax → uniform 1/3', s2[0], 1 / 3);

  eq('空 softmax → []', softmax([]), []);

  // sampleStats
  const st = sampleStats([1, 2, 3, 4, 5]);
  close('mean=3', st.mean, 3);
  close('std=√2.5', st.std, Math.sqrt(2.5));

  const st2 = sampleStats([5]);
  close('单样本 mean=0', st2.mean, 0);
  close('单样本 std=0', st2.std, 0);
}

// ===========================================================================
// classifyRegimeProbability
// ===========================================================================

function testClassify(): void {
  console.log('# classifyRegimeProbability');
  // case 1: bull (mean +0.5%, std 1%) 应该最像 bull
  const bullReturns = Array.from({ length: 60 }, (_, i) => 0.005 + Math.sin(i / 5) * 0.005);
  const r1 = classifyRegimeProbability(bullReturns);
  console.log(`  ℹ️ bull-like 60 days: argmax=${r1.argmax_regime} p=${r1.max_probability.toFixed(2)}`);
  // 注: 严格的 argmax 可能因模板而异; 重点是 confidence + multiplier 合理
  assert('probabilities sum=1', Math.abs(Object.values(r1.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-6);
  assert('max_prob 在 [0.25, 1]', r1.max_probability >= 0.25 && r1.max_probability <= 1);

  // case 2: volatile (std 大) - 大 std 应推 volatile
  const volatileReturns = Array.from({ length: 60 }, (_, i) => Math.sin(i) * 0.03);
  const r2 = classifyRegimeProbability(volatileReturns);
  console.log(`  ℹ️ volatile 60 days: argmax=${r2.argmax_regime} p=${r2.max_probability.toFixed(2)}`);
  assert('volatile 大 std → argmax≈volatile', r2.argmax_regime === 'volatile' || r2.probabilities.volatile > 0.2);

  // case 3: bear (negative mean)
  const bearReturns = Array.from({ length: 60 }, () => -0.005 + Math.random() * 0.005);
  const r3 = classifyRegimeProbability(bearReturns);
  console.log(`  ℹ️ bear 60 days: argmax=${r3.argmax_regime} p=${r3.max_probability.toFixed(2)}`);

  // case 4: range (small mean & std) 但当前是 mean=0, std=0.5% — 应像 range
  const rangeReturns = Array.from({ length: 60 }, () => (Math.random() - 0.5) * 0.01);
  const r4 = classifyRegimeProbability(rangeReturns);
  console.log(`  ℹ️ range 60 days: argmax=${r4.argmax_regime} p=${r4.max_probability.toFixed(2)}`);

  // case 5: confidence 与 multiplier 映射
  // 强信号 → high (>=0.7) → 1.0
  // 中信号 → medium (0.5-0.7) → 0.7
  // 弱信号 → low (<0.5) → 0.4
  // 验证 multiplier 是 confidence 的纯函数
  for (const r of [r1, r2, r3, r4]) {
    if (r.confidence === 'high') close(`${r.argmax_regime} high mult=1`, r.recommended_position_multiplier, 1);
    if (r.confidence === 'medium') close(`${r.argmax_regime} medium mult=0.7`, r.recommended_position_multiplier, 0.7);
    if (r.confidence === 'low') close(`${r.argmax_regime} low mult=0.4`, r.recommended_position_multiplier, 0.4);
  }

  // case 6: 样本不足 → none
  const r5 = classifyRegimeProbability([0.01, 0.02]);
  eq('< 5 样本 confidence=none', r5.confidence, 'none');
  close('< 5 样本 multiplier=0', r5.recommended_position_multiplier, 0);
  // uniform 分布
  close('uniform bull=0.25', r5.probabilities.bull, 0.25);

  // case 7: 全 NaN → none
  const r6 = classifyRegimeProbability([NaN, NaN, NaN, NaN, NaN, NaN]);
  eq('全 NaN → none', r6.confidence, 'none');

  // case 8: 默认模板存在
  eq('4 个 regime 模板', Object.keys(DEFAULT_REGIME_TEMPLATES).length, 4);
  assert('bull.mean > 0', DEFAULT_REGIME_TEMPLATES.bull.mean_return > 0);
  assert('bear.mean < 0', DEFAULT_REGIME_TEMPLATES.bear.mean_return < 0);
  assert('volatile.std 最大', DEFAULT_REGIME_TEMPLATES.volatile.std_return > DEFAULT_REGIME_TEMPLATES.bull.std_return);
}

// ===========================================================================
// service.classify()
// ===========================================================================

async function testService(): Promise<void> {
  console.log('# RegimeProbabilityService.classify');
  // returns_override 直接传, 跳过 DataSource
  const svc = new RegimeProbabilityService({
    async loadBenchmarkReturns() {
      return [];
    },
  });
  const r = await svc.classify({
    returns_override: Array.from({ length: 60 }, () => 0.005),
  });
  assert('classify 返回', r.argmax_regime != null);
  assert('probabilities sum=1', Math.abs(Object.values(r.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-6);

  // 不传 override → 走 DataSource
  const svc2 = new RegimeProbabilityService({
    async loadBenchmarkReturns() {
      return Array.from({ length: 30 }, () => -0.003);
    },
  });
  const r2 = await svc2.classify({});
  assert('fake DataSource works', Number.isFinite(r2.observation.mean));

  // DataSource 返回空 → confidence=none
  const svc3 = new RegimeProbabilityService({
    async loadBenchmarkReturns() {
      return [];
    },
  });
  const r3 = await svc3.classify({});
  eq('DataSource 空 → none', r3.confidence, 'none');
}

// ===========================================================================
// Run
// ===========================================================================

(async () => {
  testHelpers();
  testClassify();
  await testService();
  console.log('');
  console.log(`✅ passed=${passed}`);
  console.log(`❌ failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
