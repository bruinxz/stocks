/**
 * IntradayPriceVolumeAnomalyDetector 单测 (PR-O3 2026-06-30).
 */

import {
  VOLUME_SURGE_RATIO_THRESHOLD,
  MAIN_INFLOW_CHANGE_PCT_THRESHOLD,
  LIMIT_UP_BREAKOUT_CHANGE_PCT_THRESHOLD,
  SECTOR_LINK_LIMIT_UP_COUNT,
  SECOND_BOARD_CONSECUTIVE_DAYS,
  SOURCE_TYPE_PRICE_VOLUME,
  TIMING_TAG_INTRADAY_ANOMALY,
  ANOMALY_RULE_IDS,
  detectVolumeSurge,
  detectMainForceInflow,
  detectLimitUpBreakout,
  detectSectorLinkUndermove,
  detectBrokenRefill,
  detectSecondBoardAcceleration,
  scoreAnomaly,
  buildAnomalyReason,
  buildAnomalySourceId,
  emptyAnomalyByType,
  isInIntradayTradingTime,
  IntradayPriceVolumeAnomalyDetector,
  PriceVolumeAnomalyDataSource,
  QuoteLike,
  LimitUpRecord,
  IndustryFlowLike,
} from '../../src/services/IntradayPriceVolumeAnomalyDetector';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}
function equal<T>(label: string, actual: T, expected: T): void {
  check(
    `${label} (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)})`,
    actual === expected
  );
}

(async () => {
  equal('VOLUME_SURGE=2', VOLUME_SURGE_RATIO_THRESHOLD, 2.0);
  equal('MAIN_INFLOW pct=5', MAIN_INFLOW_CHANGE_PCT_THRESHOLD, 5.0);
  equal('LIMIT_UP_BREAKOUT pct=9', LIMIT_UP_BREAKOUT_CHANGE_PCT_THRESHOLD, 9.0);
  equal('SECTOR_LINK_LIMIT_UP=3', SECTOR_LINK_LIMIT_UP_COUNT, 3);
  equal('SECOND_BOARD days=2', SECOND_BOARD_CONSECUTIVE_DAYS, 2);
  equal('SOURCE_TYPE', SOURCE_TYPE_PRICE_VOLUME, 'intraday_price_volume_anomaly');
  equal('TIMING_TAG', TIMING_TAG_INTRADAY_ANOMALY, 'intraday_anomaly');
  equal('rule_id volume_surge', ANOMALY_RULE_IDS.volume_surge, 'intraday_volume_surge');
  equal(
    'rule_id main_force_inflow',
    ANOMALY_RULE_IDS.main_force_inflow,
    'intraday_main_force_inflow'
  );
  equal(
    'rule_id second_board_acceleration',
    ANOMALY_RULE_IDS.second_board_acceleration,
    'intraday_second_board_acceleration'
  );

  const at1100 = new Date('2026-06-30T03:00:00Z'); // 11:00 Shanghai = 90min elapsed
  const baseQ: QuoteLike = {
    symbol: 'sh.600519',
    name: 'A',
    industry: '白酒',
    current_price: 100,
    change_percent: 3,
    volume: 1000000,
    turnover: 100000000,
  };
  equal('volume_surge 6x → true', detectVolumeSurge(baseQ, 400000, at1100), true);
  equal('volume_surge 0.67x → false', detectVolumeSurge(baseQ, 4000000, at1100), false);
  equal('volume_surge null avg → false', detectVolumeSurge(baseQ, null, at1100), false);
  equal('volume_surge null vol → false', detectVolumeSurge({ ...baseQ, volume: null }, 100, at1100), false);

  const flow: IndustryFlowLike = { industry_name: '白酒', main_inflow: 1e8, change_pct: 2 };
  equal('main +6%, inflow>0 → true', detectMainForceInflow({ ...baseQ, change_percent: 6 }, flow), true);
  equal('main +4%, inflow>0 → false', detectMainForceInflow({ ...baseQ, change_percent: 4 }, flow), false);
  equal(
    'main +6%, inflow<0 → false',
    detectMainForceInflow({ ...baseQ, change_percent: 6 }, { ...flow, main_inflow: -1e8 }),
    false
  );
  equal('main null flow → false', detectMainForceInflow(baseQ, null), false);

  equal('change +9.5% → true', detectLimitUpBreakout({ ...baseQ, change_percent: 9.5 }), true);
  equal('change +8.9% → false', detectLimitUpBreakout({ ...baseQ, change_percent: 8.9 }), false);
  equal('change null → false', detectLimitUpBreakout({ ...baseQ, change_percent: null }), false);

  equal(
    'industry 3 limit_up, self +1% → true',
    detectSectorLinkUndermove({ ...baseQ, change_percent: 1 }, 3),
    true
  );
  equal(
    'industry 2 limit_up (< 3) → false',
    detectSectorLinkUndermove({ ...baseQ, change_percent: 1 }, 2),
    false
  );
  equal(
    'industry 3 limit_up, self +3% → false',
    detectSectorLinkUndermove({ ...baseQ, change_percent: 3 }, 3),
    false
  );

  const baseLu: LimitUpRecord = {
    trade_date: '2026-06-30',
    stock_code: '600519',
    stock_name: 'A',
    industry: '白酒',
    continuous_days: 1,
    limit_up_time: '10:00:00',
    limit_up_open_times: 0,
  };
  equal('opens=0 → false', detectBrokenRefill(baseLu), false);
  equal('opens=2 → true', detectBrokenRefill({ ...baseLu, limit_up_open_times: 2 }), true);

  equal(
    '2板 + 9:32:00 封 → true',
    detectSecondBoardAcceleration({ ...baseLu, continuous_days: 2, limit_up_time: '09:32:00' }),
    true
  );
  equal(
    '2板 + 10:00 封 → false (晚于 9:35)',
    detectSecondBoardAcceleration({ ...baseLu, continuous_days: 2, limit_up_time: '10:00:00' }),
    false
  );
  equal(
    '3板 + 9:32 → false (非 2板)',
    detectSecondBoardAcceleration({ ...baseLu, continuous_days: 3, limit_up_time: '09:32:00' }),
    false
  );
  equal(
    '2板 + null time → false',
    detectSecondBoardAcceleration({ ...baseLu, continuous_days: 2, limit_up_time: null }),
    false
  );

  equal('second_board 88', scoreAnomaly('second_board_acceleration'), 88);
  equal('limit_up_breakout 82', scoreAnomaly('limit_up_breakout'), 82);
  equal('volume_surge 72', scoreAnomaly('volume_surge'), 72);
  equal('sector_link 68', scoreAnomaly('sector_link_undermove'), 68);

  const reason1 = buildAnomalyReason('volume_surge', baseQ, { avg20d: 200000 });
  check('reason volume_surge 含量比', reason1.includes('量比'));
  const reason2 = buildAnomalyReason('main_force_inflow', baseQ, { industryName: '白酒' });
  check('reason main_force 含白酒', reason2.includes('白酒'));
  const reason3 = buildAnomalyReason('second_board_acceleration', baseQ, {
    record: { ...baseLu, continuous_days: 2, limit_up_time: '09:32:00' },
  });
  check('reason second_board 含时间', reason3.includes('09:32'));

  const id1 = buildAnomalySourceId(
    'volume_surge',
    'sh.600519',
    '2026-06-30',
    30 * 60 * 1000,
    new Date('2026-06-30T03:00:00Z')
  );
  const id2 = buildAnomalySourceId(
    'volume_surge',
    'sh.600519',
    '2026-06-30',
    30 * 60 * 1000,
    new Date('2026-06-30T03:29:00Z')
  );
  equal('30min 窗内同 source_id', id1, id2);
  const id3 = buildAnomalySourceId(
    'volume_surge',
    'sh.600519',
    '2026-06-30',
    30 * 60 * 1000,
    new Date('2026-06-30T03:31:00Z')
  );
  check('30min 窗外不同 source_id', id1 !== id3);

  const cnt = emptyAnomalyByType();
  equal(
    'cnt all 0',
    cnt.volume_surge + cnt.broken_refill + cnt.main_force_inflow + cnt.limit_up_breakout,
    0
  );

  equal('9:30 → true', isInIntradayTradingTime(new Date('2026-06-30T01:30:00Z')), true);
  equal('11:31 → false', isInIntradayTradingTime(new Date('2026-06-30T03:31:00Z')), false);
  equal('13:00 → true', isInIntradayTradingTime(new Date('2026-06-30T05:00:00Z')), true);
  equal('15:01 → false', isInIntradayTradingTime(new Date('2026-06-30T07:01:00Z')), false);

  const noopDs: PriceVolumeAnomalyDataSource = {
    async loadUniverseSymbols() { return []; },
    async loadQuotes() { return []; },
    async loadAvgVolume20D() { return []; },
    async loadLimitUpToday() { return []; },
    async loadLimitUpYesterday() { return []; },
    async loadIndustryFlowsRecent() { return []; },
    async writeRiskAlerts() { return { written: 0, errors: 0 }; },
    async writeSignals() { return { created: 0, updated: 0, errors: 0 }; },
  };
  const svc = new IntradayPriceVolumeAnomalyDetector(noopDs);

  let res = await svc.runOnce({ now: new Date('2026-06-28T03:00:00Z') });
  equal('Sunday → not_trading_day', res.skipped_reason, 'not_trading_day');

  res = await svc.runOnce({ now: new Date('2026-06-30T04:00:00Z') });
  equal('12:00 → not_in_trading_session', res.skipped_reason, 'not_in_trading_session');

  res = await svc.runOnce({ now: at1100, force: true });
  equal('empty universe → skipped', res.skipped_reason, 'empty_universe');

  let wroteAlerts: any[] = [];
  let wroteSignals: any[] = [];
  const happyDs: PriceVolumeAnomalyDataSource = {
    async loadUniverseSymbols() {
      return ['sh.600519', 'sz.000001', 'sh.600036', 'sh.600000'];
    },
    async loadQuotes() {
      return [
        { symbol: 'sh.600519', name: '量比飙', industry: '白酒', current_price: 100, change_percent: 3, volume: 1000000, turnover: 100000000 },
        { symbol: 'sz.000001', name: '主力领涨', industry: '白酒', current_price: 100, change_percent: 6, volume: 100000, turnover: 10000000 },
        { symbol: 'sh.600036', name: '准涨停', industry: '银行', current_price: 100, change_percent: 9.5, volume: 100000, turnover: 10000000 },
        { symbol: 'sh.600000', name: '滞涨票', industry: '半导体', current_price: 100, change_percent: 1, volume: 100000, turnover: 10000000 },
      ];
    },
    async loadAvgVolume20D() {
      return [
        { symbol: 'sh.600519', avg_volume_20d: 200000 },
        { symbol: 'sz.000001', avg_volume_20d: 1000000 },
        { symbol: 'sh.600036', avg_volume_20d: 1000000 },
        { symbol: 'sh.600000', avg_volume_20d: 1000000 },
      ];
    },
    async loadLimitUpToday() {
      return [
        { trade_date: '2026-06-30', stock_code: '300999', stock_name: 'a', industry: '半导体', continuous_days: 1, limit_up_time: '09:35:00', limit_up_open_times: 0 },
        { trade_date: '2026-06-30', stock_code: '300998', stock_name: 'b', industry: '半导体', continuous_days: 1, limit_up_time: '09:35:00', limit_up_open_times: 0 },
        { trade_date: '2026-06-30', stock_code: '300997', stock_name: 'c', industry: '半导体', continuous_days: 1, limit_up_time: '09:35:00', limit_up_open_times: 0 },
        { trade_date: '2026-06-30', stock_code: '600519', stock_name: '量比飙', industry: '白酒', continuous_days: 2, limit_up_time: '09:32:00', limit_up_open_times: 1 },
      ];
    },
    async loadLimitUpYesterday() { return []; },
    async loadIndustryFlowsRecent() {
      return [{ industry_name: '白酒', main_inflow: 1e8, change_pct: 3 }];
    },
    async writeRiskAlerts(rows) {
      wroteAlerts = rows;
      return { written: rows.length, errors: 0 };
    },
    async writeSignals(rows) {
      wroteSignals = rows;
      return { created: rows.length, updated: 0, errors: 0 };
    },
  };
  res = await new IntradayPriceVolumeAnomalyDetector(happyDs).runOnce({
    now: at1100,
    force: true,
  });
  equal('happy matched=6', res.matched, 6);
  equal('happy by_type.volume_surge=1', res.by_type.volume_surge, 1);
  equal('happy by_type.main_force_inflow=1', res.by_type.main_force_inflow, 1);
  equal('happy by_type.limit_up_breakout=1', res.by_type.limit_up_breakout, 1);
  equal('happy by_type.sector_link_undermove=1', res.by_type.sector_link_undermove, 1);
  equal('happy by_type.broken_refill=1', res.by_type.broken_refill, 1);
  equal('happy by_type.second_board_acceleration=1', res.by_type.second_board_acceleration, 1);
  equal('happy wroteSignals=6', wroteSignals.length, 6);

  wroteAlerts = [];
  wroteSignals = [];
  res = await new IntradayPriceVolumeAnomalyDetector(happyDs).runOnce({
    now: at1100,
    force: true,
    dry_run: true,
  });
  equal('dry_run matched=6', res.matched, 6);
  equal('dry_run wroteSignals=0', wroteSignals.length, 0);
  equal('dry_run wroteAlerts=0', wroteAlerts.length, 0);

  console.log(`\n========= IntradayPriceVolumeAnomalyDetector tests: ${pass} pass, ${fail} fail =========`);
  if (fail > 0) process.exit(1);
})();
