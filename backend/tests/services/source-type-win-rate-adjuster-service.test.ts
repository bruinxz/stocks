/**
 * SourceTypeWinRateAdjuster 单元测试 (PR-M3 / 2026-06-29)
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/source-type-win-rate-adjuster-service.test.ts
 *
 * 完全脱 DB — WinRateDataSource 全 stub.
 *
 * 覆盖维度:
 *   - 纯 helpers: applyInversion / computeAdjustment
 *   - getStats / adjust e2e:
 *     - 高 win_rate (> 0.5) → no_adjustment
 *     - 低 win_rate + 样本足 → inverted_source_winrate (raw 80 → 20)
 *     - 样本不足 → insufficient_samples
 *     - DS throw → no_data (fail-open)
 *     - cache 5min TTL: 同 source 第二次不打 DB
 */

import {
  SourceTypeWinRateAdjuster,
  WinRateDataSource,
  applyInversion,
  computeAdjustment,
  WIN_RATE_INVERT_THRESHOLD,
  WIN_RATE_MIN_SAMPLE,
} from '../../src/services/SourceTypeWinRateAdjuster';

let ok = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function assertEqual(name: string, got: any, want: any): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`);
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeStats {
  n_close: number;
  n_win: number;
  throws?: boolean;
}

function makeFakeDS(
  bySource: Record<string, FakeStats>,
  callCounter: { count: number }
): WinRateDataSource {
  return {
    async fetchSourceTypeWinRate(source_type: string) {
      callCounter.count += 1;
      const s = bySource[source_type];
      if (!s) return { n_close: 0, n_win: 0 };
      if (s.throws) throw new Error(`mock throw ${source_type}`);
      return { n_close: s.n_close, n_win: s.n_win };
    },
  };
}

// ---------------------------------------------------------------------------
// [1] Constants
// ---------------------------------------------------------------------------
console.log('\n[1] Constants...');
assertEqual('WIN_RATE_INVERT_THRESHOLD', WIN_RATE_INVERT_THRESHOLD, 0.5);
assertEqual('WIN_RATE_MIN_SAMPLE', WIN_RATE_MIN_SAMPLE, 10);

// ---------------------------------------------------------------------------
// [2] applyInversion
// ---------------------------------------------------------------------------
console.log('\n[2] applyInversion...');
assertEqual('null 透传', applyInversion(null, true), null);
assertEqual('null 透传 (no invert)', applyInversion(null, false), null);
assertEqual('NaN 透传 null', applyInversion(NaN, true), null);
assertEqual('80 no invert → 80', applyInversion(80, false), 80);
assertEqual('80 invert → 20', applyInversion(80, true), 20);
assertEqual('100 invert → 0', applyInversion(100, true), 0);
assertEqual('0 invert → 100', applyInversion(0, true), 100);
assertEqual('out-of-range -10 clamp to 0', applyInversion(-10, false), 0);
assertEqual('out-of-range 150 clamp to 100', applyInversion(150, false), 100);

// ---------------------------------------------------------------------------
// [3] computeAdjustment
// ---------------------------------------------------------------------------
console.log('\n[3] computeAdjustment...');
// stats=null → no_data
const r1 = computeAdjustment(80, null);
assertEqual('null stats → no_data', r1.adjustment_reason, 'no_data');
assertEqual('null stats → adjusted == raw', r1.confidence_score_adjusted, 80);

// insufficient samples
const r2 = computeAdjustment(80, {
  source_type: 'X',
  sample_size: 5,
  win_rate: 0.3,
  should_invert: false,
  computed_at: 0,
});
assertEqual('< 10 samples → insufficient', r2.adjustment_reason, 'insufficient_samples');
assertEqual('< 10 samples → adjusted == raw', r2.confidence_score_adjusted, 80);

// high win_rate → no_adjustment
const r3 = computeAdjustment(80, {
  source_type: 'X',
  sample_size: 50,
  win_rate: 0.6,
  should_invert: false,
  computed_at: 0,
});
assertEqual('high win_rate → no_adjustment', r3.adjustment_reason, 'no_adjustment');
assertEqual('high win_rate → adjusted == raw', r3.confidence_score_adjusted, 80);

// low win_rate + 样本足 → inverted
const r4 = computeAdjustment(80, {
  source_type: 'X',
  sample_size: 50,
  win_rate: 0.3,
  should_invert: true,
  computed_at: 0,
});
assertEqual('low win_rate → inverted', r4.adjustment_reason, 'inverted_source_winrate');
assertEqual('low win_rate → adjusted 100 - raw', r4.confidence_score_adjusted, 20);
assertEqual('raw 透传', r4.confidence_score_raw, 80);

// ---------------------------------------------------------------------------
// [4] adjust e2e + cache
// ---------------------------------------------------------------------------
console.log('\n[4] adjust e2e + cache...');

async function testHighWinRate(): Promise<void> {
  const counter = { count: 0 };
  const ds = makeFakeDS(
    { analysis_engine: { n_close: 50, n_win: 30 } }, // 60% win
    counter
  );
  const svc = new SourceTypeWinRateAdjuster({ dataSource: ds });
  const r = await svc.adjust(75, 'analysis_engine');
  assertEqual('high — reason', r.adjustment_reason, 'no_adjustment');
  assertEqual('high — adjusted == raw', r.confidence_score_adjusted, 75);
  assertEqual('high — DS called 1', counter.count, 1);
}

async function testLowWinRateInvert(): Promise<void> {
  const counter = { count: 0 };
  const ds = makeFakeDS(
    { quant_recommendation: { n_close: 100, n_win: 30 } }, // 30% win
    counter
  );
  const svc = new SourceTypeWinRateAdjuster({ dataSource: ds });
  const r = await svc.adjust(80, 'quant_recommendation');
  assertEqual('low — reason', r.adjustment_reason, 'inverted_source_winrate');
  assertEqual('low — adjusted = 100 - 80 = 20', r.confidence_score_adjusted, 20);
  assertEqual('low — raw preserved', r.confidence_score_raw, 80);
}

async function testInsufficientSamples(): Promise<void> {
  const counter = { count: 0 };
  const ds = makeFakeDS(
    { tradingagents: { n_close: 5, n_win: 1 } }, // 仅 5 条
    counter
  );
  const svc = new SourceTypeWinRateAdjuster({ dataSource: ds });
  const r = await svc.adjust(80, 'tradingagents');
  assertEqual('insufficient — reason', r.adjustment_reason, 'insufficient_samples');
  assertEqual('insufficient — adjusted == raw', r.confidence_score_adjusted, 80);
}

async function testThrowFailOpen(): Promise<void> {
  const counter = { count: 0 };
  const ds = makeFakeDS(
    { broken: { n_close: 0, n_win: 0, throws: true } },
    counter
  );
  const svc = new SourceTypeWinRateAdjuster({ dataSource: ds });
  const r = await svc.adjust(80, 'broken');
  assertEqual('throw — reason no_data', r.adjustment_reason, 'no_data');
  assertEqual('throw — adjusted == raw (fail-open)', r.confidence_score_adjusted, 80);
}

async function testCache(): Promise<void> {
  const counter = { count: 0 };
  const ds = makeFakeDS(
    { analysis_engine: { n_close: 100, n_win: 30 } },
    counter
  );
  const svc = new SourceTypeWinRateAdjuster({ dataSource: ds });
  await svc.adjust(70, 'analysis_engine');
  await svc.adjust(80, 'analysis_engine');
  await svc.adjust(60, 'analysis_engine');
  assertEqual('cache — DS called once', counter.count, 1);
}

async function testNullSourceType(): Promise<void> {
  const counter = { count: 0 };
  const ds = makeFakeDS({}, counter);
  const svc = new SourceTypeWinRateAdjuster({ dataSource: ds });
  const r = await svc.adjust(80, '');
  assertEqual('empty source_type → no_data', r.adjustment_reason, 'no_data');
  assertEqual('empty source_type — DS not called', counter.count, 0);
}

async function testNullRawConf(): Promise<void> {
  const counter = { count: 0 };
  const ds = makeFakeDS(
    { quant_recommendation: { n_close: 100, n_win: 20 } },
    counter
  );
  const svc = new SourceTypeWinRateAdjuster({ dataSource: ds });
  const r = await svc.adjust(null, 'quant_recommendation');
  assertEqual('null raw — adjusted null', r.confidence_score_adjusted, null);
  assertEqual('null raw — reason inverted (stats existed)', r.adjustment_reason, 'inverted_source_winrate');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  await testHighWinRate();
  await testLowWinRateInvert();
  await testInsufficientSamples();
  await testThrowFailOpen();
  await testCache();
  await testNullSourceType();
  await testNullRawConf();

  console.log(`\n[source-type-win-rate-adjuster] ${ok} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
})();
