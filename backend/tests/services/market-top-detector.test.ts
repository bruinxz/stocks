/**
 * MarketTopDetector 单测 — Phase 8 顶部前瞻
 */
import {
  computeRsi,
  detectRsiTopDivergence,
  detectHighRangeOscillation,
  detectVolumeDivergence,
  computeTopScore,
  scoreToLevel,
  buildSummaryMessage,
} from '../../src/services/MarketTopDetector';

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

function testRsi() {
  console.log('\n## computeRsi');
  // 短序列 → null
  assert('< 15 → null', computeRsi([1, 2, 3]) === null);
  // 全涨 → 100 (无损失)
  const allUp = Array.from({ length: 20 }, (_, i) => 100 + i);
  expectClose('全涨 → 100', computeRsi(allUp)!, 100);
  // 全跌 → 接近 0 (gains=0)
  const allDown = Array.from({ length: 20 }, (_, i) => 100 - i);
  expectClose('全跌 → 接近 0', computeRsi(allDown)!, 0, 1);
}

function testDetectRsiTopDivergence() {
  console.log('\n## detectRsiTopDivergence');
  // 短序列 → false
  assert('短序列 → false', detectRsiTopDivergence([1, 2, 3]) === false);

  // 单调上涨 → price 新高 + RSI 新高 → 不算背离
  const monotonic = Array.from({ length: 60 }, (_, i) => 100 + i);
  assert('单调上涨 不算背离', !detectRsiTopDivergence(monotonic, 20));

  // 价格创新高但中间有过更猛的 rally (那一段 RSI 更高) → 背离
  // 序列: 慢涨 30 → 快涨 → 平 → 慢涨创新高
  const divergent: number[] = [];
  for (let i = 0; i < 30; i++) divergent.push(100 + i * 0.1); // 慢涨
  for (let i = 0; i < 10; i++) divergent.push(divergent[divergent.length - 1] + 2); // 快涨
  for (let i = 0; i < 10; i++) divergent.push(divergent[divergent.length - 1] - 0.1); // 微跌
  for (let i = 0; i < 10; i++) divergent.push(divergent[divergent.length - 1] + 0.5); // 慢涨新高
  assert('快涨后慢涨创新高 → 背离', detectRsiTopDivergence(divergent, 20));
}

function testHighRangeOscillation() {
  console.log('\n## detectHighRangeOscillation');
  // 短序列 → false
  assert('< 70 day → false', detectHighRangeOscillation([1, 2, 3]) === false);

  // 60 日震荡 + 最近 10 日明显高位运行
  // 前 50 日 70-89 区间, 后 10 日全部 200 (远高于 90% 分位, 确保都过 threshold)
  const ranging: number[] = [];
  for (let i = 0; i < 60; i++) ranging.push(70 + (i % 20)); // 70-89 循环
  for (let i = 0; i < 10; i++) ranging.push(200); // 200 远高于任何 percentile
  assert('最近 10 日在 90% 分位 → 高位震荡', detectHighRangeOscillation(ranging, 10, 0.9));

  // 60 日震荡 + 最近 10 日跌到低位 → 不算
  const dropped: number[] = [];
  for (let i = 0; i < 60; i++) dropped.push(80 + Math.sin(i) * 10);
  for (let i = 0; i < 10; i++) dropped.push(70 - i * 0.1);
  assert('最近 10 日在低位 → 不算', !detectHighRangeOscillation(dropped, 10, 0.9));
}

function testVolumeDivergence() {
  console.log('\n## detectVolumeDivergence');
  // 短序列 → false
  assert('短序列 → false', detectVolumeDivergence([1], [1]) === false);

  // 价升量跌 → 背离
  const upClose = Array.from({ length: 60 }, (_, i) => 100 + i);
  // 长期均量 high, 短期均量 low (下降 > 15%)
  const lowVolRecent: number[] = [];
  for (let i = 0; i < 40; i++) lowVolRecent.push(10000);
  for (let i = 0; i < 20; i++) lowVolRecent.push(7000); // 短期 -30%
  assert('价升 + 量缩 > 15% → 背离', detectVolumeDivergence(upClose, lowVolRecent, 20, 60));

  // 价升 + 量同步 → 不算背离
  const samVol = Array.from({ length: 60 }, () => 10000);
  assert('价升 + 量同步 → 不算', !detectVolumeDivergence(upClose, samVol, 20, 60));

  // 价跌 → 不论 vol 都不算 (定义)
  const downClose = Array.from({ length: 60 }, (_, i) => 100 - i);
  assert('价跌 → 不算 (定义)', !detectVolumeDivergence(downClose, lowVolRecent, 20, 60));
}

function testComputeTopScore() {
  console.log('\n## computeTopScore');
  // 全 false → 0
  expectClose(
    '无信号 → 0',
    computeTopScore({
      rsi_divergence: false,
      breadth_deterioration: false,
      new_high_low_reversal: false,
      high_range_oscillation: false,
      volume_divergence: false,
    }),
    0
  );

  // 全 true → 100
  expectClose(
    '全信号 → 100',
    computeTopScore({
      rsi_divergence: true,
      breadth_deterioration: true,
      new_high_low_reversal: true,
      high_range_oscillation: true,
      volume_divergence: true,
    }),
    100
  );

  // breadth (25) + RSI (20) = 45
  expectClose(
    'RSI + breadth → 45',
    computeTopScore({
      rsi_divergence: true,
      breadth_deterioration: true,
      new_high_low_reversal: false,
      high_range_oscillation: false,
      volume_divergence: false,
    }),
    45
  );
}

function testScoreToLevel() {
  console.log('\n## scoreToLevel');
  assert('70 → top_warning_high', scoreToLevel(70) === 'top_warning_high');
  assert('45 → top_warning_medium', scoreToLevel(45) === 'top_warning_medium');
  assert('20 → no_warning', scoreToLevel(20) === 'no_warning');
  assert('60 边界 → high', scoreToLevel(60) === 'top_warning_high');
  assert('40 边界 → medium', scoreToLevel(40) === 'top_warning_medium');
}

function testSummaryMessage() {
  console.log('\n## buildSummaryMessage');
  const r1 = {
    top_score: 0,
    level: 'no_warning',
    signals: [],
  };
  assert('no_warning msg', buildSummaryMessage(r1).includes('无顶部信号'));

  const r2 = {
    top_score: 70,
    level: 'top_warning_high',
    signals: [
      { signal: 'rsi_divergence', triggered: true, score_contribution: 20, detail: '' },
      { signal: 'breadth_deterioration', triggered: true, score_contribution: 25, detail: '' },
    ],
  };
  const msg = buildSummaryMessage(r2);
  assert('high warning msg 含高顶部风险', msg.includes('高顶部风险'));
  assert('high warning msg 含 触发列表', msg.includes('rsi_divergence'));
}

function main() {
  testRsi();
  testDetectRsiTopDivergence();
  testHighRangeOscillation();
  testVolumeDivergence();
  testComputeTopScore();
  testScoreToLevel();
  testSummaryMessage();
  console.log(`\n========================================`);
  console.log(`MarketTopDetector tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
