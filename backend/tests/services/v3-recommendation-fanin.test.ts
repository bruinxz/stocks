/**
 * V3RecommendationController Signal-First fan-in 单测.
 *
 * 覆盖:
 *   - V3_FANIN_SOURCE_TYPES 精确收敛到 ETF 核心 + 题材卫星 + 历史兼容源
 *   - CANDIDATE_SOURCE_TYPES 与 funnel 口径一致
 *   - normalizeTimingTagFromMetadata 5 timing 值
 *   - parseTimingFilter 解析 comma-list + 'all' + 单值
 *   - AISignalSourceType 不再复活已删除的 4 个 intraday detector source
 */

import {
  V3_FANIN_SOURCE_TYPES,
  CANDIDATE_SOURCE_TYPES,
  TIMING_TAG_VALUES,
  normalizeTimingTagFromMetadata,
  parseTimingFilter,
  dedupBySymbol,
} from '../../src/api/controllers/V3RecommendationController';
import { AISignalSourceType } from '../../src/models/AIInvestmentSignal';

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
  equal('enum ETF_FACTOR_ROTATION', AISignalSourceType.ETF_FACTOR_ROTATION, 'etf_factor_rotation');
  equal('enum THEME_EVENT', AISignalSourceType.THEME_EVENT, 'theme_event');
  equal('enum THEME_FERMENTATION', AISignalSourceType.THEME_FERMENTATION, 'theme_fermentation');
  equal('enum CASH_MANAGEMENT', AISignalSourceType.CASH_MANAGEMENT, 'cash_management');

  for (const removed of [
    'OPENING_RUSH_DETECTOR',
    'INTRADAY_PRICE_VOLUME_ANOMALY',
    'LAST_HOUR_MOMENTUM',
    'LIMIT_UP_BOARD',
  ]) {
    equal(`removed enum ${removed}`, (AISignalSourceType as any)[removed], undefined);
  }

  check(
    'fan_in contains etf_factor_rotation',
    V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.ETF_FACTOR_ROTATION)
  );
  check('fan_in contains theme_event', V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.THEME_EVENT));
  check(
    'fan_in contains theme_fermentation',
    V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.THEME_FERMENTATION)
  );
  check(
    'fan_in contains analysis_engine (legacy)',
    V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.ANALYSIS_ENGINE)
  );
  check(
    'fan_in contains quant_recommendation (legacy)',
    V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.QUANT_RECOMMENDATION)
  );
  check(
    'fan_in does NOT contain daily_screener',
    !V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.DAILY_SCREENER)
  );
  check(
    'fan_in does NOT contain cash_management',
    !V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.CASH_MANAGEMENT)
  );
  equal('fan_in exact source count', V3_FANIN_SOURCE_TYPES.length, 5);

  check(
    'candidate contains etf_factor_rotation',
    CANDIDATE_SOURCE_TYPES.includes(AISignalSourceType.ETF_FACTOR_ROTATION)
  );
  check(
    'candidate contains theme_event',
    CANDIDATE_SOURCE_TYPES.includes(AISignalSourceType.THEME_EVENT)
  );
  check(
    'candidate contains theme_fermentation',
    CANDIDATE_SOURCE_TYPES.includes(AISignalSourceType.THEME_FERMENTATION)
  );
  check(
    'candidate contains tradingagents',
    CANDIDATE_SOURCE_TYPES.includes(AISignalSourceType.TRADING_AGENTS)
  );
  check(
    'candidate does NOT contain daily_screener',
    !CANDIDATE_SOURCE_TYPES.includes(AISignalSourceType.DAILY_SCREENER)
  );
  equal('candidate exact source count', CANDIDATE_SOURCE_TYPES.length, 6);

  equal('TIMING_TAG_VALUES length=5', TIMING_TAG_VALUES.length, 5);
  check('TIMING includes opening_rush', TIMING_TAG_VALUES.includes('opening_rush'));
  check('TIMING includes intraday_anomaly', TIMING_TAG_VALUES.includes('intraday_anomaly'));
  check('TIMING includes closing_grab', TIMING_TAG_VALUES.includes('closing_grab'));

  equal('null → overnight default', normalizeTimingTagFromMetadata(null), 'overnight');
  equal('{} → overnight default', normalizeTimingTagFromMetadata({}), 'overnight');
  equal(
    'opening_rush from metadata',
    normalizeTimingTagFromMetadata({ timing_tag: 'opening_rush' }),
    'opening_rush'
  );
  equal(
    'OPENING_RUSH uppercase → lower',
    normalizeTimingTagFromMetadata({ timing_tag: 'OPENING_RUSH' }),
    'opening_rush'
  );
  equal(
    'unknown → overnight',
    normalizeTimingTagFromMetadata({ timing_tag: 'unknown_xyz' }),
    'overnight'
  );
  equal(
    'intraday_anomaly from metadata',
    normalizeTimingTagFromMetadata({ timing_tag: 'intraday_anomaly' }),
    'intraday_anomaly'
  );

  equal('null → null (no filter)', parseTimingFilter(null), null);
  equal('"" → null', parseTimingFilter(''), null);
  equal('"all" → null', parseTimingFilter('all'), null);
  equal('non-string → null', parseTimingFilter(123 as any), null);

  const r1 = parseTimingFilter('opening_rush');
  check(
    '"opening_rush" → [opening_rush]',
    Array.isArray(r1) && r1.length === 1 && r1[0] === 'opening_rush'
  );

  const r2 = parseTimingFilter('opening_rush,closing_grab,intraday_anomaly');
  check(
    'comma list → 3 tags',
    Array.isArray(r2) &&
      r2.length === 3 &&
      r2.includes('opening_rush') &&
      r2.includes('closing_grab') &&
      r2.includes('intraday_anomaly')
  );

  const r3 = parseTimingFilter('opening_rush,foo_bar,closing_grab');
  check(
    'comma list with invalid → filter invalid',
    Array.isArray(r3) &&
      r3.length === 2 &&
      r3.includes('opening_rush') &&
      r3.includes('closing_grab')
  );

  equal('all invalid → null', parseTimingFilter('foo,bar,baz'), null);

  // -------- PR-S Bug B3 (2026-06-30) — dedupBySymbol --------
  const fakeRow = (symbol: string, conf: number, source_type: string, id: number): any => ({
    symbol,
    confidence_score: conf,
    source_type,
    id,
  });

  // 同股 4 条 → 留 1 条 (最高 conf)
  const dup4 = [
    fakeRow('sh.600113', 70, 'theme_event', 1),
    fakeRow('sh.600113', 85, 'theme_event', 2),
    fakeRow('sh.600113', 60, 'theme_event', 3),
    fakeRow('sh.600113', 80, 'theme_event', 4),
  ];
  const dedup1 = dedupBySymbol(dup4);
  equal('B3 dedup 4→1', dedup1.length, 1);
  equal('B3 dedup 留 conf=85', dedup1[0].confidence_score, 85);

  // 多股各 N 条 → 每股 1 条 (最高)
  const dup5 = [
    fakeRow('sh.600519', 90, 'analysis_engine', 1),
    fakeRow('sh.600519', 85, 'theme_event', 2),
    fakeRow('sz.000001', 80, 'analysis_engine', 3),
    fakeRow('sz.000001', 75, 'theme_event', 4),
    fakeRow('sh.600036', 70, 'analysis_engine', 5),
  ];
  const dedup2 = dedupBySymbol(dup5);
  equal('B3 dedup 3 股各 1 条', dedup2.length, 3);
  equal('B3 dedup top 是 600519 (90)', dedup2[0].symbol, 'sh.600519');
  equal('B3 dedup 排序降序 → 600036 末尾', dedup2[2].symbol, 'sh.600036');

  // 同分 tie-break: analysis_engine 优先于 theme_event (字典序 a < t)
  const tieDup = [
    fakeRow('sh.600113', 80, 'theme_event', 1),
    fakeRow('sh.600113', 80, 'analysis_engine', 2),
  ];
  const tieDedup = dedupBySymbol(tieDup);
  equal('B3 dedup tie 保 analysis_engine', tieDedup[0].source_type, 'analysis_engine');

  // 空数组 → 空数组
  equal('B3 dedup [] → []', dedupBySymbol([]).length, 0);

  // 单条 → 不变
  const single = dedupBySymbol([fakeRow('sh.600519', 90, 'analysis_engine', 1)]);
  equal('B3 dedup [1] → [1]', single.length, 1);

  console.log(
    `\n========= V3RecommendationController fan-in tests: ${pass} pass, ${fail} fail =========`
  );
  if (fail > 0) process.exit(1);
})();
