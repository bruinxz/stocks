/**
 * meta-v2 单元测试 (Sprint 41-B):
 *   - TripleBarrierLabeler 纯函数 + service (fake DataSource)
 *   - IsotonicCalibrator (PAV 算法 + calibrate 边界)
 *   - EVDecisionService (3 级 fallback + EV 公式)
 *
 * 不依赖 jest, node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/meta-v2.test.ts
 */

import {
  TRIPLE_BARRIER_LABELS,
  DEFAULT_BARRIER_OPTIONS,
  normalizeBarrierOptions,
  evaluateBarBarrier,
  applyTripleBarrier,
  TripleBarrierLabeler,
  TripleBarrierDataSource,
  DailyBarSnapshot,
} from '../../src/services/meta-v2/TripleBarrierLabeler';

import {
  identityCalibrationModel,
  poolAdjacentViolators,
  trainIsotonicCalibration,
  calibrate,
  brierScore,
  IsotonicCalibrator,
} from '../../src/services/meta-v2/IsotonicCalibrator';

import {
  DEFAULT_EV_OPTIONS,
  normalizeEVOptions,
  computeEV,
  decideByEV,
  EVDecisionService,
  EVDecisionDataSource,
} from '../../src/services/meta-v2/EVDecisionService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}
function eq<T>(name: string, a: T, b: T): void {
  assert(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
}
function close(name: string, a: number, b: number, eps = 1e-6): void {
  assert(name, Math.abs(a - b) < eps, `actual=${a} expected=${b}`);
}

// ===========================================================================
// TripleBarrierLabeler
// ===========================================================================

function testTripleBarrier(): void {
  console.log('# TripleBarrierLabeler');
  // 常量
  eq('UPPER_HIT=1', TRIPLE_BARRIER_LABELS.UPPER_HIT, 1);
  eq('LOWER_HIT=-1', TRIPLE_BARRIER_LABELS.LOWER_HIT, -1);
  eq('TIME_HIT=0', TRIPLE_BARRIER_LABELS.TIME_HIT, 0);
  eq('默认 max_holding_days=15', DEFAULT_BARRIER_OPTIONS.max_holding_days, 15);

  // normalizeBarrierOptions
  eq('空 input 用默认', normalizeBarrierOptions(), DEFAULT_BARRIER_OPTIONS);
  eq('NaN 用默认', normalizeBarrierOptions({ profit_take_pct: NaN } as any), DEFAULT_BARRIER_OPTIONS);
  eq('负数用默认', normalizeBarrierOptions({ stop_loss_pct: -0.1 }), DEFAULT_BARRIER_OPTIONS);
  eq(
    '有效 override',
    normalizeBarrierOptions({ profit_take_pct: 0.1, max_holding_days: 30 }),
    { profit_take_pct: 0.1, stop_loss_pct: 0.03, max_holding_days: 30 }
  );

  // evaluateBarBarrier
  const opts = { profit_take_pct: 0.05, stop_loss_pct: 0.03, max_holding_days: 15 };
  const r1 = evaluateBarBarrier({ date: '2026-06-01', high: 106, low: 99, close: 104 }, 100, opts);
  eq('上涨 6% 触发 upper', r1.hit, 'upper');
  close('upper trigger_price=105', r1.trigger_price, 105);
  close('upper pnl_pct=0.05', r1.pnl_pct, 0.05);

  const r2 = evaluateBarBarrier({ date: '2026-06-01', high: 102, low: 96, close: 97 }, 100, opts);
  eq('下跌 4% 触发 lower', r2.hit, 'lower');
  close('lower trigger_price=97', r2.trigger_price, 97);
  close('lower pnl_pct=-0.03', r2.pnl_pct, -0.03);

  const r3 = evaluateBarBarrier({ date: '2026-06-01', high: 103, low: 98, close: 101 }, 100, opts);
  eq('未触发', r3.hit, 'none');
  close('none pnl_pct=(close-entry)/entry', r3.pnl_pct, 0.01);

  // 同 bar 上下都触发 → 保守按 lower
  const r4 = evaluateBarBarrier({ date: '2026-06-01', high: 106, low: 96, close: 104 }, 100, opts);
  eq('同 bar 上下都触发 → lower', r4.hit, 'lower');

  // entry_price <= 0 → none
  const r5 = evaluateBarBarrier({ date: '2026-06-01', high: 106, low: 96, close: 104 }, 0, opts);
  eq('entry_price=0 → none', r5.hit, 'none');

  // applyTripleBarrier - upper hit on day 2
  const bars: DailyBarSnapshot[] = [
    { date: '2026-06-02', high: 101, low: 99, close: 100 },
    { date: '2026-06-03', high: 106, low: 100, close: 105 }, // upper hit
    { date: '2026-06-04', high: 110, low: 102, close: 108 }, // should not be reached
  ];
  const apply1 = applyTripleBarrier(bars, 100, opts);
  eq('upper hit', apply1.trigger, 'upper');
  eq('upper trigger_date', apply1.trigger_date, '2026-06-03');
  eq('upper bars_scanned=2', apply1.bars_scanned, 2);

  // lower hit on day 3
  const bars2: DailyBarSnapshot[] = [
    { date: '2026-06-02', high: 101, low: 99, close: 100 },
    { date: '2026-06-03', high: 102, low: 100, close: 101 },
    { date: '2026-06-04', high: 100, low: 96, close: 97 }, // lower hit
  ];
  const apply2 = applyTripleBarrier(bars2, 100, opts);
  eq('lower hit', apply2.trigger, 'lower');

  // time hit (15 bars 全 none)
  const flatBars = Array.from({ length: 15 }, (_, i) => ({
    date: `2026-06-0${i + 1}`,
    high: 102,
    low: 99,
    close: 101,
  }));
  const apply3 = applyTripleBarrier(flatBars, 100, opts);
  eq('time hit', apply3.trigger, 'time');
  eq('time bars_scanned=15', apply3.bars_scanned, 15);

  // no_data
  const apply4 = applyTripleBarrier([], 100, opts);
  eq('no_data', apply4.label, null);

  // service with fake DataSource
  const fakeDS: TripleBarrierDataSource = {
    async loadBarsAfterEntry(symbol) {
      if (symbol === '600519') return bars;
      return [];
    },
  };
  const labeler = new TripleBarrierLabeler(fakeDS);
  labeler
    .label({ symbol: '600519', entry_price: 100, entry_date: '2026-06-01' })
    .then(r => {
      eq('service.label 触发 upper', r.trigger, 'upper');
      eq('service.label symbol 保留', r.symbol, '600519');
    });
}

// ===========================================================================
// IsotonicCalibrator
// ===========================================================================

function testIsotonic(): void {
  console.log('# IsotonicCalibrator');
  // identity
  const id = identityCalibrationModel();
  eq('identity points', id.points.length, 2);
  close('identity calibrate(0.5)=0.5', calibrate(id, 0.5), 0.5);

  // PAV monotonic
  const pavResult = poolAdjacentViolators([
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.4 },
    { x: 0.3, y: 0.3 }, // violation
    { x: 0.4, y: 0.5 },
    { x: 0.5, y: 0.8 },
  ]);
  // 验证单调
  for (let i = 1; i < pavResult.length; i++) {
    assert(`PAV monotonic at ${i}`, pavResult[i].y >= pavResult[i - 1].y);
  }
  // 合并 (0.2,0.4)+(0.3,0.3) → (0.3, 0.35)
  // 期望 4 个 pool: 0.1, 0.3, 0.4, 0.5
  eq('PAV 合并后 4 个 pool', pavResult.length, 4);
  close('PAV 合并后第 2 个 y=0.35', pavResult[1].y, 0.35);

  // PAV 完美单调不合并
  const pavOk = poolAdjacentViolators([
    { x: 0.1, y: 0.1 },
    { x: 0.5, y: 0.5 },
    { x: 0.9, y: 0.9 },
  ]);
  eq('完美单调 3 个 pool', pavOk.length, 3);

  // train
  const samples = [
    { raw_confidence: 0.1, outcome: 0 as const },
    { raw_confidence: 0.2, outcome: 0 as const },
    { raw_confidence: 0.5, outcome: 1 as const },
    { raw_confidence: 0.6, outcome: 1 as const },
    { raw_confidence: 0.8, outcome: 1 as const },
    { raw_confidence: 0.9, outcome: 1 as const },
  ];
  const model = trainIsotonicCalibration(samples);
  assert('trained_samples=6', model.trained_samples === 6);
  close('base_win_rate=0.667', model.base_win_rate, 4 / 6, 1e-3);
  // 单调 verify
  for (let i = 1; i < model.points.length; i++) {
    assert(`trained model monotonic at ${i}`, model.points[i].y >= model.points[i - 1].y);
  }

  // calibrate 边界
  close('calibrate(0)=points[0].y', calibrate(model, 0), model.points[0].y);
  close('calibrate(1)=points[-1].y', calibrate(model, 1), model.points[model.points.length - 1].y);
  // 中间值线性插值
  const midRaw = (model.points[0].x + model.points[model.points.length - 1].x) / 2;
  const midCal = calibrate(model, midRaw);
  assert('calibrate 中间值在 [0,1]', midCal >= 0 && midCal <= 1);

  // brierScore
  const brier = brierScore(model, samples);
  assert('brierScore in [0, 1]', brier >= 0 && brier <= 1);

  // 空样本 → identity
  const empty = trainIsotonicCalibration([]);
  eq('空样本返回 identity', empty.trained_samples, 0);

  // 单样本
  const single = trainIsotonicCalibration([{ raw_confidence: 0.5, outcome: 1 as const }]);
  eq('单样本 trained_samples=1', single.trained_samples, 1);
  close('单样本 calibrate(0.3)=1', calibrate(single, 0.3), 1);

  // 全非法样本 → identity
  const allBad = trainIsotonicCalibration([
    { raw_confidence: NaN, outcome: 0 as const },
    { raw_confidence: 1.5, outcome: 1 as const },
  ]);
  eq('全非法 → identity', allBad.trained_samples, 0);

  // service
  const calib = new IsotonicCalibrator();
  calib.train(samples);
  assert('service.calibrate works', Number.isFinite(calib.calibrate(0.5)));
}

// ===========================================================================
// EVDecisionService
// ===========================================================================

async function testEV(): Promise<void> {
  console.log('# EVDecisionService');
  // 常量
  close('默认 cost=0.3%', DEFAULT_EV_OPTIONS.default_cost_pct, 0.003);
  close('默认 threshold=0.5%', DEFAULT_EV_OPTIONS.min_ev_threshold, 0.005);

  // normalizeEVOptions
  const opts = normalizeEVOptions({ default_cost_pct: 0.005, min_ev_threshold: 0.01 });
  close('override cost', opts.default_cost_pct, 0.005);
  close('override threshold', opts.min_ev_threshold, 0.01);
  close('未 override 字段保留默认', opts.lookback_days, 180);

  // computeEV
  // p=0.7, win=0.05, loss=0.03, cost=0.003 → 0.7×0.05 - 0.3×0.03 - 0.003 = 0.035 - 0.009 - 0.003 = 0.023
  close('computeEV(0.7, 0.05, 0.03, 0.003)=0.023', computeEV(0.7, 0.05, 0.03, 0.003), 0.023);
  // p=0.5 break-even
  close('computeEV(0.5, 0.05, 0.05, 0.001)=-0.001', computeEV(0.5, 0.05, 0.05, 0.001), -0.001);
  // clamp p
  close('computeEV(p>1) clamp to 1', computeEV(1.5, 0.05, 0.03, 0), 0.05);
  close('computeEV(p<0) clamp to 0', computeEV(-0.5, 0.05, 0.03, 0), -0.03);

  // decideByEV
  eq('EV > threshold → bet', decideByEV(0.01, 0.005), 'bet');
  eq('EV = threshold → bet', decideByEV(0.005, 0.005), 'bet');
  eq('EV < threshold → skip', decideByEV(0.004, 0.005), 'skip');
  eq('EV negative → skip', decideByEV(-0.01, 0.005), 'skip');

  // service - 3 fallback levels
  // L1: strategy_regime stats exists & sample >= min
  const fakeWithStrategy: EVDecisionDataSource = {
    async loadStrategyRegimeStats() {
      return {
        strategy_key: 'mfa',
        regime: 'bull',
        sample_count: 20,
        avg_win_pct: 0.08,
        avg_loss_pct: 0.04,
        historical_win_rate: 0.6,
      };
    },
    async loadGlobalStats() {
      return null;
    },
  };
  const svc1 = new EVDecisionService(fakeWithStrategy);
  const r1 = await svc1.decide({
    symbol: '600519',
    strategy_key: 'mfa',
    regime: 'bull',
    calibrated_win_prob: 0.7,
    as_of_date: '2026-06-16',
  });
  eq('L1: stats_source=strategy_regime', r1.stats_source, 'strategy_regime');
  eq('L1: stats_sample_count=20', r1.stats_sample_count, 20);
  close('L1: avg_win=0.08', r1.avg_win_pct, 0.08);
  // EV = 0.7×0.08 - 0.3×0.04 - 0.003 = 0.056 - 0.012 - 0.003 = 0.041
  close('L1: ev=0.041', r1.ev, 0.041);
  eq('L1: decision=bet (0.041 > 0.005)', r1.decision, 'bet');

  // L2: strategy_regime stats 不足 (sample < min), fallback to global
  const fakeWithGlobal: EVDecisionDataSource = {
    async loadStrategyRegimeStats() {
      return {
        strategy_key: 'mfa',
        regime: 'bull',
        sample_count: 3,
        avg_win_pct: 0.08,
        avg_loss_pct: 0.04,
        historical_win_rate: 0.6,
      };
    },
    async loadGlobalStats() {
      return { sample_count: 50, avg_win_pct: 0.06, avg_loss_pct: 0.035 };
    },
  };
  const svc2 = new EVDecisionService(fakeWithGlobal);
  const r2 = await svc2.decide({
    symbol: '600519',
    strategy_key: 'mfa',
    regime: 'bull',
    calibrated_win_prob: 0.7,
    as_of_date: '2026-06-16',
  });
  eq('L2: stats_source=global_fallback', r2.stats_source, 'global_fallback');
  close('L2: avg_win=0.06', r2.avg_win_pct, 0.06);

  // L3: 全都缺 → default_fallback
  const fakeEmpty: EVDecisionDataSource = {
    async loadStrategyRegimeStats() {
      return null;
    },
    async loadGlobalStats() {
      return null;
    },
  };
  const svc3 = new EVDecisionService(fakeEmpty);
  const r3 = await svc3.decide({
    symbol: '600519',
    strategy_key: 'mfa',
    regime: 'bull',
    calibrated_win_prob: 0.7,
    as_of_date: '2026-06-16',
  });
  eq('L3: stats_source=default_fallback', r3.stats_source, 'default_fallback');
  close('L3: avg_win=0.05 (default)', r3.avg_win_pct, 0.05);
  eq('L3: stats_sample_count=0', r3.stats_sample_count, 0);

  // cost_pct_override
  const r4 = await svc3.decide({
    symbol: '600519',
    strategy_key: 'mfa',
    regime: 'bull',
    calibrated_win_prob: 0.6,
    as_of_date: '2026-06-16',
    cost_pct_override: 0.01,
  });
  close('cost override=0.01', r4.cost_pct, 0.01);

  // low win_prob → skip
  const r5 = await svc3.decide({
    symbol: '600519',
    strategy_key: 'mfa',
    regime: 'bull',
    calibrated_win_prob: 0.3,
    as_of_date: '2026-06-16',
  });
  // EV = 0.3×0.05 - 0.7×0.03 - 0.003 = 0.015 - 0.021 - 0.003 = -0.009
  close('low p → ev=-0.009', r5.ev, -0.009);
  eq('low p → skip', r5.decision, 'skip');
}

// ===========================================================================
// Run
// ===========================================================================

(async () => {
  testTripleBarrier();
  testIsotonic();
  await testEV();
  console.log('');
  console.log(`✅ passed=${passed}`);
  console.log(`❌ failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
