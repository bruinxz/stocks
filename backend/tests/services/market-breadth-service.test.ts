/**
 * MarketBreadthService 单测 — Phase 8 全市场宽度
 * 只测纯函数 (computeAdvanceDeclineRatio / computeBreadthScore /
 * scoreToLevel / buildSummaryMessage)。DB-driven 由集成测试覆盖。
 */
import {
  computeAdvanceDeclineRatio,
  computeBreadthScore,
  scoreToLevel,
  buildSummaryMessage,
} from '../../src/services/MarketBreadthService';

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
  assert(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) < eps,
    `expected≈${expected}, got=${actual}`
  );
}

function testAD() {
  console.log('\n## computeAdvanceDeclineRatio');
  expectClose('600 advancers / 400 decliners = 1.5', computeAdvanceDeclineRatio(600, 400)!, 1.5);
  expectClose('200 / 800 = 0.25', computeAdvanceDeclineRatio(200, 800)!, 0.25);
  expectClose('1000 / 0 → 99 (大数)', computeAdvanceDeclineRatio(1000, 0)!, 99);
  assert('0 / 0 → null', computeAdvanceDeclineRatio(0, 0) === null);
  assert('0 / 0 (双 0) → null 而非 div 0', computeAdvanceDeclineRatio(0, 0) === null);
}

function testBreadthScore() {
  console.log('\n## computeBreadthScore');

  // 中性: 50% 上涨, AD=1, 新高=新低, 涨停=跌停
  const neutral = computeBreadthScore({
    advancer_pct: 0.5,
    advance_decline_ratio: 1.0,
    new_60d_high_count: 10,
    new_60d_low_count: 10,
    limit_up_count: 5,
    limit_down_count: 5,
  });
  expectClose('中性 score ≈ 0', neutral, 0);

  // 强势: 70% 上涨, AD=3, 新高>>新低, 涨停>>跌停
  const strong = computeBreadthScore({
    advancer_pct: 0.7,
    advance_decline_ratio: 3.0,
    new_60d_high_count: 100,
    new_60d_low_count: 5,
    limit_up_count: 50,
    limit_down_count: 0,
  });
  assert('强势 score > 50', strong > 50, `actual=${strong}`);

  // 极弱: 30% 上涨, AD=0.3, 新低>>新高
  const weak = computeBreadthScore({
    advancer_pct: 0.3,
    advance_decline_ratio: 0.3,
    new_60d_high_count: 5,
    new_60d_low_count: 100,
    limit_up_count: 2,
    limit_down_count: 30,
  });
  assert('极弱 score < -30', weak < -30, `actual=${weak}`);

  // AD null (不计该项)
  const noAD = computeBreadthScore({
    advancer_pct: 0.5,
    advance_decline_ratio: null,
    new_60d_high_count: 10,
    new_60d_low_count: 10,
    limit_up_count: 0,
    limit_down_count: 0,
  });
  expectClose('AD null 不影响其他项 → 接近 0', noAD, 0, 5);
}

function testScoreToLevel() {
  console.log('\n## scoreToLevel');
  assert('60 → strong', scoreToLevel(60) === 'strong');
  assert('30 → mild_strong', scoreToLevel(30) === 'mild_strong');
  assert('0 → neutral', scoreToLevel(0) === 'neutral');
  assert('-30 → mild_weak', scoreToLevel(-30) === 'mild_weak');
  assert('-60 → weak', scoreToLevel(-60) === 'weak');
  assert('20 边界 → mild_strong (≥)', scoreToLevel(20) === 'mild_strong');
  assert('-20 边界 → neutral (≥)', scoreToLevel(-20) === 'neutral');
}

function testSummaryMessage() {
  console.log('\n## buildSummaryMessage');
  const snap = {
    trade_date: '2026-06-12',
    advancers_count: 3000,
    decliners_count: 1500,
    unchanged_count: 100,
    total_count: 4600,
    advance_decline_ratio: 2.0,
    advancer_pct: 0.652,
    limit_up_count: 30,
    limit_down_count: 5,
    new_60d_high_count: 80,
    new_60d_low_count: 10,
    median_return_pct: 1.5,
    breadth_score: 45,
    level: 'mild_strong' as const,
  };
  const msg = buildSummaryMessage(snap);
  assert('msg 含日期', msg.includes('2026-06-12'));
  assert('msg 含 偏强', msg.includes('偏强'));
  assert('msg 含 65.2%', msg.includes('65.2%'));
  assert('msg 含 涨停 30', msg.includes('涨停 30'));
  assert('msg 含 新高 80', msg.includes('新高 80'));
}

function main() {
  testAD();
  testBreadthScore();
  testScoreToLevel();
  testSummaryMessage();
  console.log(`\n========================================`);
  console.log(`MarketBreadthService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
