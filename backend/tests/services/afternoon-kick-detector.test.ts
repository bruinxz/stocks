/**
 * AfternoonKickDetector 单测 (PR-O6 2026-06-30).
 *
 * 跑: npx ts-node --transpile-only tests/services/afternoon-kick-detector.test.ts
 */

import {
  AfternoonKickDetector,
  AfternoonKickDataSource,
  QuoteLike,
  MorningKlineLike,
  CriticalAnnouncementLike,
  LimitUpRecordLike,
  SOURCE_TYPE_AFTERNOON_KICK,
  TIMING_TAG_AFTERNOON_KICK,
  PATTERN_RULE_IDS,
  PATTERN_LABELS,
  PATTERN_DECISIONS,
  STRONG_OPEN_MIN_PCT,
  STRONG_OPEN_MIN_VOL_RATIO,
  NOON_CATALYST_MIN_PCT,
  EXHAUSTION_MORNING_GAIN_PCT,
  SECTOR_KICK_MORNING_MAX,
  SECTOR_KICK_NOON_MIN,
  detectStrongOpen,
  detectNoonCatalyst,
  detectExhaustion,
  detectSectorKick,
  scoreAfternoonKick,
  buildReason,
  buildSourceId,
  todayTradeDate,
  isAfternoonKickWindow,
  emptyByPattern,
} from '../../src/services/AfternoonKickDetector';

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

// 2026-06-30 (周二) 13:01 Asia/Shanghai = 2026-06-30T05:01:00Z
const AFTERNOON_TICK = new Date('2026-06-30T05:01:00Z');
// 2026-06-30 12:00 Asia/Shanghai = 04:00Z (午休, 不在 13:00-13:30 窗口)
const BEFORE_WINDOW = new Date('2026-06-30T04:00:00Z');
// 2026-06-30 13:31 (超出窗口)
const AFTER_WINDOW = new Date('2026-06-30T05:31:00Z');
// 2026-06-28 (周日)
const SUNDAY = new Date('2026-06-28T05:01:00Z');

(async () => {
  // ===========================================================================
  // 1. 常量校验
  // ===========================================================================
  equal('SOURCE_TYPE', SOURCE_TYPE_AFTERNOON_KICK, 'afternoon_kick_detector');
  equal('TIMING_TAG', TIMING_TAG_AFTERNOON_KICK, 'afternoon_kick');
  equal('rule_id strong_open', PATTERN_RULE_IDS.strong_open, 'afternoon_kick_strong_open');
  equal('rule_id noon_catalyst', PATTERN_RULE_IDS.noon_catalyst, 'afternoon_kick_noon_catalyst');
  equal('rule_id exhaustion', PATTERN_RULE_IDS.exhaustion, 'afternoon_kick_exhaustion');
  equal('rule_id sector_kick', PATTERN_RULE_IDS.sector_kick, 'afternoon_kick_sector_kick');
  equal('decision strong_open', PATTERN_DECISIONS.strong_open, 'buy');
  equal('decision noon_catalyst', PATTERN_DECISIONS.noon_catalyst, 'buy');
  equal('decision exhaustion', PATTERN_DECISIONS.exhaustion, 'reduce');
  equal('decision sector_kick', PATTERN_DECISIONS.sector_kick, 'buy');
  check('label strong_open 含 ☀️', PATTERN_LABELS.strong_open.includes('☀️'));
  check('label noon_catalyst 含 📢', PATTERN_LABELS.noon_catalyst.includes('📢'));
  check('label exhaustion 含 ⚠️', PATTERN_LABELS.exhaustion.includes('⚠️'));
  check('label sector_kick 含 🔗', PATTERN_LABELS.sector_kick.includes('🔗'));
  equal('STRONG_OPEN_MIN_PCT', STRONG_OPEN_MIN_PCT, 0.5);
  equal('STRONG_OPEN_MIN_VOL_RATIO', STRONG_OPEN_MIN_VOL_RATIO, 1.2);
  equal('NOON_CATALYST_MIN_PCT', NOON_CATALYST_MIN_PCT, 2.0);
  equal('EXHAUSTION_MORNING_GAIN_PCT', EXHAUSTION_MORNING_GAIN_PCT, 3.0);
  equal('SECTOR_KICK_MORNING_MAX', SECTOR_KICK_MORNING_MAX, 1);
  equal('SECTOR_KICK_NOON_MIN', SECTOR_KICK_NOON_MIN, 2);

  // ===========================================================================
  // 2. helpers
  // ===========================================================================
  equal('emptyByPattern strong_open=0', emptyByPattern().strong_open, 0);
  equal('emptyByPattern exhaustion=0', emptyByPattern().exhaustion, 0);

  equal('todayTradeDate', todayTradeDate(AFTERNOON_TICK), '2026-06-30');

  equal('13:01 in window', isAfternoonKickWindow(AFTERNOON_TICK), true);
  equal('12:00 not in window', isAfternoonKickWindow(BEFORE_WINDOW), false);
  equal('13:31 not in window', isAfternoonKickWindow(AFTER_WINDOW), false);

  equal(
    'buildSourceId',
    buildSourceId('strong_open', 'sh.600519', '2026-06-30'),
    'afternoon_kick::strong_open::sh.600519::2026-06-30'
  );

  // ===========================================================================
  // 3. detectStrongOpen — A19
  // ===========================================================================
  // 价升 + 量比够: hit
  equal(
    'A19 1130=100 1301=101 → +1% 量比2x → hit',
    detectStrongOpen({
      close_11_30: 100,
      price_13_01: 101,
      morning_volume: 12000, // 上午 120 min, perMin=100
      afternoon_volume: 200, // 1min 200, 量比 = 200/100 = 2x
    }),
    true
  );
  // 涨幅不足
  equal(
    'A19 1130=100 1301=100.3 → +0.3% 不到 0.5% → miss',
    detectStrongOpen({
      close_11_30: 100,
      price_13_01: 100.3,
      morning_volume: 12000,
      afternoon_volume: 200,
    }),
    false
  );
  // 量比不足
  equal(
    'A19 +1% 但量比 < 1.2 → miss',
    detectStrongOpen({
      close_11_30: 100,
      price_13_01: 101,
      morning_volume: 12000,
      afternoon_volume: 50, // 量比 0.5x
    }),
    false
  );
  // 价跌 → miss
  equal(
    'A19 1130=100 1301=99 → 跌 → miss',
    detectStrongOpen({
      close_11_30: 100,
      price_13_01: 99,
      morning_volume: 12000,
      afternoon_volume: 200,
    }),
    false
  );
  // close_11_30=null → miss
  equal(
    'A19 close_11_30=null → miss',
    detectStrongOpen({
      close_11_30: null,
      price_13_01: 101,
      morning_volume: 12000,
      afternoon_volume: 200,
    }),
    false
  );
  // morning_volume=null + 价升 → 弱判定 hit
  equal(
    'A19 morning_volume=null 但价 +1% → hit (新股弱判定)',
    detectStrongOpen({
      close_11_30: 100,
      price_13_01: 101,
      morning_volume: null,
      afternoon_volume: 100,
    }),
    true
  );
  // 边界: 涨幅 = 0.5% (严格 > 才触发, 等于不触发)
  equal(
    'A19 涨幅 = 0.5% 边界 → miss (要求严格 >)',
    detectStrongOpen({
      close_11_30: 100,
      price_13_01: 100.5,
      morning_volume: 12000,
      afternoon_volume: 200,
    }),
    false
  );
  // 边界: 量比 = 1.2 严格 >= 触发 (我们用 ratio >= STRONG_OPEN_MIN_VOL_RATIO)
  equal(
    'A19 量比 = 1.2 边界 → hit',
    detectStrongOpen({
      close_11_30: 100,
      price_13_01: 101,
      morning_volume: 12000,
      afternoon_volume: 120, // ratio = 120/100 = 1.2
    }),
    true
  );

  // ===========================================================================
  // 4. detectNoonCatalyst — A20
  // ===========================================================================
  equal(
    'A20 有critical + 涨 +3% → hit',
    detectNoonCatalyst({ has_noon_critical: true, change_percent_vs_prev_close: 3.0 }),
    true
  );
  equal(
    'A20 无critical → miss',
    detectNoonCatalyst({ has_noon_critical: false, change_percent_vs_prev_close: 5.0 }),
    false
  );
  equal(
    'A20 有critical 但涨 +1% < 2% → miss',
    detectNoonCatalyst({ has_noon_critical: true, change_percent_vs_prev_close: 1.5 }),
    false
  );
  equal(
    'A20 有critical 但跌 → miss',
    detectNoonCatalyst({ has_noon_critical: true, change_percent_vs_prev_close: -3.0 }),
    false
  );
  equal(
    'A20 涨 = 2% 边界 → miss (要求严格 >)',
    detectNoonCatalyst({ has_noon_critical: true, change_percent_vs_prev_close: 2.0 }),
    false
  );
  equal(
    'A20 change=null → miss',
    detectNoonCatalyst({ has_noon_critical: true, change_percent_vs_prev_close: null }),
    false
  );

  // ===========================================================================
  // 5. detectExhaustion — A21
  // ===========================================================================
  equal(
    'A21 prev=100 11:30=104 (+4%) 13:01=103 (低于11:30) → hit',
    detectExhaustion({ prev_close: 100, close_11_30: 104, price_13_01: 103 }),
    true
  );
  equal(
    'A21 上午只涨 +2% → miss',
    detectExhaustion({ prev_close: 100, close_11_30: 102, price_13_01: 101 }),
    false
  );
  equal(
    'A21 上午涨 +5% 但 13:01 仍 > 11:30 → miss',
    detectExhaustion({ prev_close: 100, close_11_30: 105, price_13_01: 106 }),
    false
  );
  equal(
    'A21 上午涨 = 3% 边界 → miss (要求严格 >)',
    detectExhaustion({ prev_close: 100, close_11_30: 103, price_13_01: 102 }),
    false
  );
  equal(
    'A21 prev_close=null → miss',
    detectExhaustion({ prev_close: null, close_11_30: 105, price_13_01: 102 }),
    false
  );
  equal(
    'A21 close_11_30=null → miss',
    detectExhaustion({ prev_close: 100, close_11_30: null, price_13_01: 102 }),
    false
  );

  // ===========================================================================
  // 6. detectSectorKick — A22
  // ===========================================================================
  equal(
    'A22 上午=0 午后=3 → hit',
    detectSectorKick({ morning_limit_up_count: 0, afternoon_limit_up_count: 3 }),
    true
  );
  equal(
    'A22 上午=1 午后=2 → hit',
    detectSectorKick({ morning_limit_up_count: 1, afternoon_limit_up_count: 2 }),
    true
  );
  equal(
    'A22 上午=2 → miss (上午已启动)',
    detectSectorKick({ morning_limit_up_count: 2, afternoon_limit_up_count: 5 }),
    false
  );
  equal(
    'A22 午后只 1 → miss',
    detectSectorKick({ morning_limit_up_count: 0, afternoon_limit_up_count: 1 }),
    false
  );
  equal(
    'A22 全 0 → miss',
    detectSectorKick({ morning_limit_up_count: 0, afternoon_limit_up_count: 0 }),
    false
  );

  // ===========================================================================
  // 7. scoring + reason
  // ===========================================================================
  equal('score noon_catalyst', scoreAfternoonKick('noon_catalyst'), 85);
  equal('score strong_open', scoreAfternoonKick('strong_open'), 78);
  equal('score sector_kick', scoreAfternoonKick('sector_kick'), 72);
  equal('score exhaustion', scoreAfternoonKick('exhaustion'), 70);

  const r1 = buildReason('strong_open', { afternoon_open_gain_pct: 1.23 });
  check('reason strong_open 含 +1.23%', r1.includes('+1.23%'));
  check('reason strong_open 含 ☀️', r1.includes('☀️'));

  const r2 = buildReason('noon_catalyst', {
    change_percent_vs_prev_close: 5.0,
    event_summary: '收购公告',
  });
  check('reason noon_catalyst 含收购公告', r2.includes('收购公告'));
  check('reason noon_catalyst 含 +5.00%', r2.includes('+5.00%'));

  const r3 = buildReason('exhaustion', { morning_gain_pct: 5.0 });
  check('reason exhaustion 含减仓', r3.includes('减仓'));
  check('reason exhaustion 含 +5.00%', r3.includes('+5.00%'));

  const r4 = buildReason('sector_kick', {
    industry: '光伏',
    morning_limit_up_count: 0,
    afternoon_limit_up_count: 3,
  });
  check('reason sector_kick 含光伏', r4.includes('光伏'));
  check('reason sector_kick 含上午0', r4.includes('上午0'));
  check('reason sector_kick 含午后3', r4.includes('午后3'));

  // ===========================================================================
  // 8. runOnce — skip flows
  // ===========================================================================
  const noopDs: AfternoonKickDataSource = {
    async loadUniverseSymbols() { return []; },
    async loadQuotes() { return []; },
    async loadMorningKlines() { return []; },
    async loadNoonCriticalAnnouncements() { return []; },
    async loadLimitUpToday() { return []; },
    async writeSignals() { return { created: 0, updated: 0, errors: 0 }; },
    async writeRiskAlerts() { return { written: 0, errors: 0 }; },
  };

  // Sunday skip
  let res = await new AfternoonKickDetector(noopDs).runOnce({ now: SUNDAY });
  equal('Sunday → skipped not_trading_day', res.skipped_reason, 'not_trading_day');

  // Before window skip
  res = await new AfternoonKickDetector(noopDs).runOnce({ now: BEFORE_WINDOW });
  equal(
    '12:00 → skipped not_in_afternoon_kick_window',
    res.skipped_reason,
    'not_in_afternoon_kick_window'
  );

  // force skip 越界
  res = await new AfternoonKickDetector(noopDs).runOnce({ now: AFTER_WINDOW, force: true });
  equal('force=true 越界但跑 → empty_universe', res.skipped_reason, 'empty_universe');

  // ===========================================================================
  // 9. runOnce — happy path: 4 patterns 全命中
  // ===========================================================================
  let wroteSignals: any[] = [];
  let wroteAlerts: any[] = [];

  const happyDs: AfternoonKickDataSource = {
    async loadUniverseSymbols() {
      return ['sh.600001', 'sh.600002', 'sh.600003', 'sz.300001'];
    },
    async loadQuotes(): Promise<QuoteLike[]> {
      return [
        {
          // A19 strong_open + 价 +1% vs 11:30
          symbol: 'sh.600001',
          name: '强开股',
          industry: '电子',
          current_price: 101,
          change_percent: 1.0, // vs prev_close=100
          volume: 12200, // 上午 12000 + 200 午后
          prev_close: 100,
        },
        {
          // A20 noon_catalyst: 公告 + 涨 +3%
          symbol: 'sh.600002',
          name: '利好股',
          industry: '医药',
          current_price: 103,
          change_percent: 3.0,
          volume: 5000,
          prev_close: 100,
        },
        {
          // A21 exhaustion: 上午涨 +5%, 13:01 < 11:30
          symbol: 'sh.600003',
          name: '衰竭股',
          industry: '军工',
          current_price: 103, // 13:01
          change_percent: 3.0, // 仍 +3% vs prev
          volume: 5000,
          prev_close: 100,
        },
        {
          // A22 sector_kick: 光伏板块, 上午没启动午后多板
          symbol: 'sz.300001',
          name: '板块股',
          industry: '光伏',
          current_price: 102,
          change_percent: 2.0,
          volume: 3000,
          prev_close: 100,
        },
      ];
    },
    async loadMorningKlines(): Promise<MorningKlineLike[]> {
      return [
        // 600001 strong_open: 11:30=100 13:01=101 → +1%
        { symbol: 'sh.600001', close_11_30: 100, volume_morning: 12000 },
        // 600002 noon_catalyst only: 11:30=103 13:01=103 → strong_open 不触发
        { symbol: 'sh.600002', close_11_30: 103, volume_morning: 4500 },
        // 600003 exhaustion only: 11:30=105 13:01=103 → 上午+5%, 午后跌
        { symbol: 'sh.600003', close_11_30: 105, volume_morning: 5000 },
        // 300001 sector_kick only: 11:30=102 13:01=102 → strong_open 不触发
        { symbol: 'sz.300001', close_11_30: 102, volume_morning: 2500 },
      ];
    },
    async loadNoonCriticalAnnouncements(): Promise<CriticalAnnouncementLike[]> {
      return [
        {
          stock_code: '600002',
          announce_date: '2026-06-30',
          priority: 'critical',
          event_type: '业绩',
          summary: '业绩超预期大涨',
        },
      ];
    },
    async loadLimitUpToday(): Promise<LimitUpRecordLike[]> {
      // 光伏板块: 上午 0 涨停, 午后 (13:01) 已有 3 个涨停 (注: 实际 13:01 时数据可能滞后)
      return [
        {
          trade_date: '2026-06-30',
          stock_code: '300002',
          industry: '光伏',
          limit_up_time: '13:05:00', // 午后涨停
        },
        {
          trade_date: '2026-06-30',
          stock_code: '300003',
          industry: '光伏',
          limit_up_time: '13:08:00',
        },
        {
          trade_date: '2026-06-30',
          stock_code: '300004',
          industry: '光伏',
          limit_up_time: '13:10:00',
        },
      ];
    },
    async writeSignals(rows) {
      wroteSignals = rows;
      return { created: rows.length, updated: 0, errors: 0 };
    },
    async writeRiskAlerts(rows) {
      wroteAlerts = rows;
      return { written: rows.length, errors: 0 };
    },
  };

  res = await new AfternoonKickDetector(happyDs).runOnce({ now: AFTERNOON_TICK, force: true });
  equal('happy scanned=4', res.scanned, 4);
  check('happy matched >= 4 (4 pattern 全中)', res.matched >= 4);
  equal('happy by_pattern.strong_open=1', res.by_pattern.strong_open, 1);
  equal('happy by_pattern.noon_catalyst=1', res.by_pattern.noon_catalyst, 1);
  equal('happy by_pattern.exhaustion=1', res.by_pattern.exhaustion, 1);
  equal('happy by_pattern.sector_kick=1', res.by_pattern.sector_kick, 1);
  check('happy hits 包含 strong_open', res.hits.some(h => h.pattern === 'strong_open'));
  check('happy hits 包含 noon_catalyst', res.hits.some(h => h.pattern === 'noon_catalyst'));
  check('happy hits 包含 exhaustion', res.hits.some(h => h.pattern === 'exhaustion'));
  check('happy hits 包含 sector_kick', res.hits.some(h => h.pattern === 'sector_kick'));
  check('happy wroteSignals.length >= 4', wroteSignals.length >= 4);
  check('happy wroteAlerts.length >= 4', wroteAlerts.length >= 4);

  // exhaustion alert 是 HIGH
  const exhaustAlert = wroteAlerts.find((a: any) => a.rule_id === 'afternoon_kick_exhaustion');
  check('exhaustion alert level=HIGH', exhaustAlert?.level === 'HIGH');
  const strongAlert = wroteAlerts.find((a: any) => a.rule_id === 'afternoon_kick_strong_open');
  check('strong_open alert level=MEDIUM', strongAlert?.level === 'MEDIUM');

  // signal metadata 透传 timing_tag
  const strongSignal = wroteSignals.find((s: any) => s.metadata?.pattern === 'strong_open');
  equal('signal metadata.timing_tag', strongSignal?.metadata?.timing_tag, TIMING_TAG_AFTERNOON_KICK);
  equal('signal source_id', strongSignal?.source_id, 'afternoon_kick::strong_open::sh.600001::2026-06-30');
  equal('signal signal_date', strongSignal?.signal_date, '2026-06-30');
  equal('signal decision=buy', strongSignal?.decision, 'buy');

  // exhaustion signal decision=reduce
  const exhaustSignal = wroteSignals.find((s: any) => s.metadata?.pattern === 'exhaustion');
  equal('exhaustion signal decision=reduce', exhaustSignal?.decision, 'reduce');

  // ===========================================================================
  // 10. runOnce — dry_run 不写库
  // ===========================================================================
  wroteSignals = [];
  wroteAlerts = [];
  res = await new AfternoonKickDetector(happyDs).runOnce({
    now: AFTERNOON_TICK,
    force: true,
    dry_run: true,
  });
  check('dry_run matched > 0', res.matched > 0);
  equal('dry_run written_signals=0', res.written_signals, 0);
  equal('dry_run written_alerts=0', res.written_alerts, 0);
  equal('dry_run wroteSignals=0', wroteSignals.length, 0);
  equal('dry_run wroteAlerts=0', wroteAlerts.length, 0);

  // ===========================================================================
  // 11. fail-OPEN: universe throw → empty_universe, runOnce 不抛
  // ===========================================================================
  const throwDs: AfternoonKickDataSource = {
    async loadUniverseSymbols() {
      throw new Error('boom universe');
    },
    async loadQuotes() { return []; },
    async loadMorningKlines() { return []; },
    async loadNoonCriticalAnnouncements() { return []; },
    async loadLimitUpToday() { return []; },
    async writeSignals() { return { created: 0, updated: 0, errors: 0 }; },
    async writeRiskAlerts() { return { written: 0, errors: 0 }; },
  };
  res = await new AfternoonKickDetector(throwDs).runOnce({ now: AFTERNOON_TICK, force: true });
  equal('universe throw → empty_universe', res.skipped_reason, 'empty_universe');
  check('universe throw 不抛, errors > 0', res.errors.length > 0);

  // ===========================================================================
  // 12. fail-OPEN: 部分子查询 throw 仅 log error, 主流程跑完
  // ===========================================================================
  const partialThrowDs: AfternoonKickDataSource = {
    async loadUniverseSymbols() { return ['sh.600001']; },
    async loadQuotes() {
      return [
        {
          symbol: 'sh.600001',
          name: 'X',
          industry: '电子',
          current_price: 101,
          change_percent: 1.0,
          volume: 12200,
          prev_close: 100,
        },
      ];
    },
    async loadMorningKlines() {
      return [{ symbol: 'sh.600001', close_11_30: 100, volume_morning: 12000 }];
    },
    async loadNoonCriticalAnnouncements() {
      throw new Error('ann boom');
    },
    async loadLimitUpToday() {
      throw new Error('limitup boom');
    },
    async writeSignals(rows) { return { created: rows.length, updated: 0, errors: 0 }; },
    async writeRiskAlerts(rows) { return { written: rows.length, errors: 0 }; },
  };
  res = await new AfternoonKickDetector(partialThrowDs).runOnce({
    now: AFTERNOON_TICK,
    force: true,
  });
  equal('partial throw scanned=1', res.scanned, 1);
  // strong_open 仍能命中 (它不依赖 ann/limit_up)
  check('partial throw 仍命中 strong_open', res.by_pattern.strong_open === 1);
  check('partial throw errors 含 anns', res.errors.some(e => e.includes('anns')));
  check('partial throw errors 含 limit_ups', res.errors.some(e => e.includes('limit_ups')));

  // ===========================================================================
  // 13. runOnce — 已涨停票不出 sector_kick (避免重复推)
  // ===========================================================================
  const limitUpQuoteDs: AfternoonKickDataSource = {
    async loadUniverseSymbols() { return ['sh.600001']; },
    async loadQuotes() {
      return [
        {
          symbol: 'sh.600001',
          name: '已涨停股',
          industry: '光伏',
          current_price: 110,
          change_percent: 10.0, // 已涨停
          volume: 5000,
          prev_close: 100,
        },
      ];
    },
    async loadMorningKlines() {
      return [{ symbol: 'sh.600001', close_11_30: 110, volume_morning: 5000 }];
    },
    async loadNoonCriticalAnnouncements() { return []; },
    async loadLimitUpToday() {
      return [
        { trade_date: '2026-06-30', stock_code: '300002', industry: '光伏', limit_up_time: '13:05:00' },
        { trade_date: '2026-06-30', stock_code: '300003', industry: '光伏', limit_up_time: '13:08:00' },
        { trade_date: '2026-06-30', stock_code: '300004', industry: '光伏', limit_up_time: '13:10:00' },
      ];
    },
    async writeSignals(rows) { return { created: rows.length, updated: 0, errors: 0 }; },
    async writeRiskAlerts(rows) { return { written: rows.length, errors: 0 }; },
  };
  res = await new AfternoonKickDetector(limitUpQuoteDs).runOnce({
    now: AFTERNOON_TICK,
    force: true,
  });
  equal('已涨停 → sector_kick 不出', res.by_pattern.sector_kick, 0);

  // ===========================================================================
  // 14. top_k 限制
  // ===========================================================================
  const manyDs: AfternoonKickDataSource = {
    async loadUniverseSymbols() {
      const out: string[] = [];
      for (let i = 0; i < 30; i++) out.push(`sh.60${String(i).padStart(4, '0')}`);
      return out;
    },
    async loadQuotes() {
      const out: QuoteLike[] = [];
      for (let i = 0; i < 30; i++) {
        out.push({
          symbol: `sh.60${String(i).padStart(4, '0')}`,
          name: `n${i}`,
          industry: '电子',
          current_price: 101,
          change_percent: 1.0,
          volume: 12200,
          prev_close: 100,
        });
      }
      return out;
    },
    async loadMorningKlines() {
      const out: MorningKlineLike[] = [];
      for (let i = 0; i < 30; i++) {
        out.push({
          symbol: `sh.60${String(i).padStart(4, '0')}`,
          close_11_30: 100,
          volume_morning: 12000,
        });
      }
      return out;
    },
    async loadNoonCriticalAnnouncements() { return []; },
    async loadLimitUpToday() { return []; },
    async writeSignals(rows) { return { created: rows.length, updated: 0, errors: 0 }; },
    async writeRiskAlerts(rows) { return { written: rows.length, errors: 0 }; },
  };
  res = await new AfternoonKickDetector(manyDs).runOnce({
    now: AFTERNOON_TICK,
    force: true,
    top_k: 5,
  });
  check('top_k=5 matched=30 但 hits<=5', res.hits.length <= 5);
  check('top_k=5 written_signals<=5', res.written_signals <= 5);

  // ===========================================================================
  // 15. trade_date override
  // ===========================================================================
  res = await new AfternoonKickDetector(noopDs).runOnce({
    now: AFTERNOON_TICK,
    force: true,
    trade_date: '2025-12-31',
  });
  equal('trade_date override', res.trade_date, '2025-12-31');

  console.log(`\n========= AfternoonKickDetector tests: ${pass} pass, ${fail} fail =========`);
  if (fail > 0) process.exit(1);
})();
