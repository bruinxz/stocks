/**
 * EventIntelligenceLayer 单元测试 (Sprint 41-F):
 *   - normalizeEventIntelligenceOptions
 *   - aggregateEvents (空 / 单一 boost / dampen / veto / delay / 混合)
 *   - service.filter() 端到端 (fake DataSource 5 个 method)
 *
 * 不依赖 jest:
 *   cd backend && npx ts-node --transpile-only tests/services/event-intelligence.test.ts
 */

import {
  DEFAULT_EVENT_INTELLIGENCE_OPTIONS,
  normalizeEventIntelligenceOptions,
  aggregateEvents,
  EventIntelligenceLayer,
  EventIntelligenceDataSource,
} from '../../src/services/event-intelligence/EventIntelligenceLayer';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}
function close(name: string, a: number, b: number, eps = 1e-6): void {
  assert(name, Math.abs(a - b) < eps, `actual=${a} expected=${b}`);
}
function eq<T>(name: string, a: T, b: T): void {
  assert(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
}

// ===========================================================================
// normalizeOptions
// ===========================================================================

function testNormalize(): void {
  console.log('# normalizeEventIntelligenceOptions');
  eq('空 → default', normalizeEventIntelligenceOptions(), DEFAULT_EVENT_INTELLIGENCE_OPTIONS);
  const overridden = normalizeEventIntelligenceOptions({
    earnings_positive_yoy_threshold: 1.0,
    earnings_positive_boost: 1.5,
  });
  close('override threshold', overridden.earnings_positive_yoy_threshold, 1.0);
  close('override boost', overridden.earnings_positive_boost, 1.5);
  close('未 override 字段保留', overridden.northbound_inflow_pp_threshold, 1.0);
}

// ===========================================================================
// aggregateEvents
// ===========================================================================

function testAggregate(): void {
  console.log('# aggregateEvents');
  // 空 events
  const r0 = aggregateEvents('600519', []);
  eq('空 events → allow', r0.action, 'allow');
  close('multiplier=1', r0.score_multiplier, 1);

  // 单个 boost
  const r1 = aggregateEvents('600519', [
    {
      event_type: 'northbound_inflow',
      score_multiplier: 1.15,
      action_hint: 'boost',
      reason: 'test',
    },
  ]);
  eq('单 boost → boost', r1.action, 'boost');
  close('multiplier=1.15', r1.score_multiplier, 1.15);

  // 单个 dampen
  const r2 = aggregateEvents('600519', [
    {
      event_type: 'northbound_outflow',
      score_multiplier: 0.75,
      action_hint: 'dampen',
      reason: 'test',
    },
  ]);
  eq('单 dampen → dampen', r2.action, 'dampen');

  // veto 短路
  const r3 = aggregateEvents('600519', [
    {
      event_type: 'northbound_inflow',
      score_multiplier: 1.15,
      action_hint: 'boost',
      reason: 'a',
    },
    {
      event_type: 'st_warning',
      score_multiplier: 0,
      action_hint: 'veto',
      reason: 'ST',
    },
  ]);
  eq('有 veto → veto', r3.action, 'veto');
  close('veto multiplier=0', r3.score_multiplier, 0);
  assert('reason 含 ST', r3.reason.includes('ST'));

  // delay 优先 (无 veto 时)
  const r4 = aggregateEvents('600519', [
    {
      event_type: 'northbound_inflow',
      score_multiplier: 1.15,
      action_hint: 'boost',
      reason: 'a',
    },
    {
      event_type: 'earnings_report_window',
      score_multiplier: 1,
      action_hint: 'delay',
      delay_minutes: 1440,
      reason: '业绩前',
    },
  ]);
  eq('有 delay → delay', r4.action, 'delay');
  eq('delay 1440 min', r4.delay_minutes, 1440);

  // 多 delay 取 max
  const r5 = aggregateEvents('600519', [
    { event_type: 'earnings_report_window', score_multiplier: 1, action_hint: 'delay', delay_minutes: 60, reason: 'a' },
    { event_type: 'earnings_report_window', score_multiplier: 1, action_hint: 'delay', delay_minutes: 1440, reason: 'b' },
  ]);
  eq('多 delay 取 max', r5.delay_minutes, 1440);

  // boost × dampen 抵消 → allow
  const r6 = aggregateEvents('600519', [
    { event_type: 'northbound_inflow', score_multiplier: 1.15, action_hint: 'boost', reason: 'a' },
    { event_type: 'earnings_forecast_negative', score_multiplier: 0.87, action_hint: 'dampen', reason: 'b' },
  ]);
  // 1.15 × 0.87 = 1.0005, 在 [0.95, 1.05] → allow
  eq('boost×dampen 抵消 → allow', r6.action, 'allow');

  // 多 boost 累乘
  const r7 = aggregateEvents('600519', [
    { event_type: 'northbound_inflow', score_multiplier: 1.15, action_hint: 'boost', reason: 'a' },
    { event_type: 'dragon_tiger_inst_buy', score_multiplier: 1.1, action_hint: 'boost', reason: 'b' },
    { event_type: 'earnings_forecast_positive', score_multiplier: 1.2, action_hint: 'boost', reason: 'c' },
  ]);
  // 1.15 × 1.1 × 1.2 = 1.518
  close('多 boost 累乘 1.518', r7.score_multiplier, 1.518, 1e-3);
  eq('多 boost → boost', r7.action, 'boost');
}

// ===========================================================================
// service.filter() 端到端
// ===========================================================================

async function testFilter(): Promise<void> {
  console.log('# EventIntelligenceLayer.filter');

  // case 1: 全 allow (无任何事件)
  const ds1: EventIntelligenceDataSource = {
    async loadEarningsForecast() {
      return null;
    },
    async loadNorthboundDelta5d() {
      return null;
    },
    async loadDragonTigerSummary() {
      return null;
    },
    async isInEarningsWindow() {
      return false;
    },
    async isHardBlocked() {
      return { st: false, suspended: false };
    },
  };
  const svc1 = new EventIntelligenceLayer(ds1);
  const r1 = await svc1.filter({ symbol: '600519', as_of_date: '2026-06-16' });
  eq('无事件 → allow', r1.action, 'allow');
  close('multiplier=1', r1.score_multiplier, 1);

  // case 2: ST → veto
  const ds2: EventIntelligenceDataSource = {
    ...ds1,
    async isHardBlocked() {
      return { st: true, suspended: false };
    },
  };
  const r2 = await new EventIntelligenceLayer(ds2).filter({ symbol: '600519', as_of_date: '2026-06-16' });
  eq('ST → veto', r2.action, 'veto');

  // case 3: 业绩公告窗口 → delay
  const ds3: EventIntelligenceDataSource = {
    ...ds1,
    async isInEarningsWindow() {
      return true;
    },
  };
  const r3 = await new EventIntelligenceLayer(ds3).filter({ symbol: '600519', as_of_date: '2026-06-16' });
  eq('earnings window → delay', r3.action, 'delay');
  eq('delay 1440 min', r3.delay_minutes, 1440);

  // case 4: 业绩预告 +60% + 北向加仓 → 双 boost
  const ds4: EventIntelligenceDataSource = {
    ...ds1,
    async loadEarningsForecast() {
      return { yoy_growth: 0.6, report_period: '2026Q2' };
    },
    async loadNorthboundDelta5d() {
      return 1.5;
    },
  };
  const r4 = await new EventIntelligenceLayer(ds4).filter({ symbol: '600519', as_of_date: '2026-06-16' });
  eq('双 boost → boost', r4.action, 'boost');
  // 1.2 × 1.15 = 1.38
  close('multiplier=1.38', r4.score_multiplier, 1.38, 1e-3);

  // case 5: 业绩预警 -50% → dampen
  const ds5: EventIntelligenceDataSource = {
    ...ds1,
    async loadEarningsForecast() {
      return { yoy_growth: -0.5, report_period: '2026Q1' };
    },
  };
  const r5 = await new EventIntelligenceLayer(ds5).filter({ symbol: '600519', as_of_date: '2026-06-16' });
  eq('业绩预警 → dampen', r5.action, 'dampen');
  close('multiplier=0.6', r5.score_multiplier, 0.6);

  // case 6: 龙虎榜机构净买 7000 万 → boost
  const ds6: EventIntelligenceDataSource = {
    ...ds1,
    async loadDragonTigerSummary() {
      return { inst_net_buy: 70000000, yz_net_buy: 0 };
    },
  };
  const r6 = await new EventIntelligenceLayer(ds6).filter({ symbol: '600519', as_of_date: '2026-06-16' });
  eq('龙虎榜机构买 → boost', r6.action, 'boost');

  // case 7: 龙虎榜游资净卖 1.5 亿 → dampen
  const ds7: EventIntelligenceDataSource = {
    ...ds1,
    async loadDragonTigerSummary() {
      return { inst_net_buy: 0, yz_net_buy: -150000000 };
    },
  };
  const r7 = await new EventIntelligenceLayer(ds7).filter({ symbol: '600519', as_of_date: '2026-06-16' });
  eq('游资净卖 → dampen', r7.action, 'dampen');

  // case 8: ST + boost → veto 优先 (短路)
  const ds8: EventIntelligenceDataSource = {
    ...ds4, // 双 boost
    async isHardBlocked() {
      return { st: true, suspended: false };
    },
  };
  const r8 = await new EventIntelligenceLayer(ds8).filter({ symbol: '600519', as_of_date: '2026-06-16' });
  eq('ST 即使有 boost 也 veto', r8.action, 'veto');

  // case 9: 数据源失败不阻塞 (fail-open)
  const ds9: EventIntelligenceDataSource = {
    ...ds1,
    async loadEarningsForecast() {
      throw new Error('fake DB error');
    },
  };
  const r9 = await new EventIntelligenceLayer(ds9).filter({ symbol: '600519', as_of_date: '2026-06-16' });
  // 其他事件 source 都返回 null/false → 应该 allow
  eq('数据源失败 → allow', r9.action, 'allow');

  // case 10: 业绩预告 +60% 但同时业绩公告窗口 → delay 优先
  const ds10: EventIntelligenceDataSource = {
    ...ds1,
    async loadEarningsForecast() {
      return { yoy_growth: 0.6, report_period: '2026Q2' };
    },
    async isInEarningsWindow() {
      return true;
    },
  };
  const r10 = await new EventIntelligenceLayer(ds10).filter({ symbol: '600519', as_of_date: '2026-06-16' });
  eq('delay 优先于 boost', r10.action, 'delay');
}

// ===========================================================================
// Run
// ===========================================================================

(async () => {
  testNormalize();
  testAggregate();
  await testFilter();
  console.log('');
  console.log(`✅ passed=${passed}`);
  console.log(`❌ failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
