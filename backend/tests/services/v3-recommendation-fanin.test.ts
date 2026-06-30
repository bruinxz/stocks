/**
 * V3RecommendationController fan-in 单测 (PR-O3 2026-06-30).
 *
 * 覆盖:
 *   - V3_FANIN_SOURCE_TYPES 含 4 个新 detector source (META-GUARD)
 *   - CANDIDATE_SOURCE_TYPES 与 funnel 口径一致
 *   - normalizeTimingTagFromMetadata 5 timing 值
 *   - parseTimingFilter 解析 comma-list + 'all' + 单值
 *   - AISignalSourceType enum 含 5 个新 source
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
  equal(
    'enum OPENING_RUSH_DETECTOR',
    AISignalSourceType.OPENING_RUSH_DETECTOR,
    'opening_rush_detector'
  );
  equal(
    'enum INTRADAY_PRICE_VOLUME_ANOMALY',
    AISignalSourceType.INTRADAY_PRICE_VOLUME_ANOMALY,
    'intraday_price_volume_anomaly'
  );
  equal('enum LAST_HOUR_MOMENTUM', AISignalSourceType.LAST_HOUR_MOMENTUM, 'last_hour_momentum');
  equal('enum LIMIT_UP_BOARD', AISignalSourceType.LIMIT_UP_BOARD, 'limit_up_board');
  equal('enum THEME_FERMENTATION', AISignalSourceType.THEME_FERMENTATION, 'theme_fermentation');

  check(
    'fan_in contains opening_rush_detector',
    V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.OPENING_RUSH_DETECTOR)
  );
  check(
    'fan_in contains intraday_price_volume_anomaly',
    V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.INTRADAY_PRICE_VOLUME_ANOMALY)
  );
  check(
    'fan_in contains last_hour_momentum',
    V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.LAST_HOUR_MOMENTUM)
  );
  check(
    'fan_in contains limit_up_board',
    V3_FANIN_SOURCE_TYPES.includes(AISignalSourceType.LIMIT_UP_BOARD)
  );
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
    'candidate contains opening_rush_detector',
    CANDIDATE_SOURCE_TYPES.includes(AISignalSourceType.OPENING_RUSH_DETECTOR)
  );
  check(
    'candidate contains intraday_price_volume_anomaly',
    CANDIDATE_SOURCE_TYPES.includes(AISignalSourceType.INTRADAY_PRICE_VOLUME_ANOMALY)
  );
  check(
    'candidate contains last_hour_momentum',
    CANDIDATE_SOURCE_TYPES.includes(AISignalSourceType.LAST_HOUR_MOMENTUM)
  );
  check(
    'candidate contains tradingagents',
    CANDIDATE_SOURCE_TYPES.includes(AISignalSourceType.TRADING_AGENTS)
  );

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
    fakeRow('sh.600113', 70, 'intraday_price_volume_anomaly', 1),
    fakeRow('sh.600113', 85, 'intraday_price_volume_anomaly', 2),
    fakeRow('sh.600113', 60, 'intraday_price_volume_anomaly', 3),
    fakeRow('sh.600113', 80, 'intraday_price_volume_anomaly', 4),
  ];
  const dedup1 = dedupBySymbol(dup4);
  equal('B3 dedup 4→1', dedup1.length, 1);
  equal('B3 dedup 留 conf=85', dedup1[0].confidence_score, 85);

  // 多股各 N 条 → 每股 1 条 (最高)
  const dup5 = [
    fakeRow('sh.600519', 90, 'analysis_engine', 1),
    fakeRow('sh.600519', 85, 'intraday_price_volume_anomaly', 2),
    fakeRow('sz.000001', 80, 'analysis_engine', 3),
    fakeRow('sz.000001', 75, 'intraday_price_volume_anomaly', 4),
    fakeRow('sh.600036', 70, 'analysis_engine', 5),
  ];
  const dedup2 = dedupBySymbol(dup5);
  equal('B3 dedup 3 股各 1 条', dedup2.length, 3);
  equal('B3 dedup top 是 600519 (90)', dedup2[0].symbol, 'sh.600519');
  equal('B3 dedup 排序降序 → 600036 末尾', dedup2[2].symbol, 'sh.600036');

  // 同分 tie-break: analysis_engine 优先于 intraday_price_volume_anomaly (字典序 a < i)
  const tieDup = [
    fakeRow('sh.600113', 80, 'intraday_price_volume_anomaly', 1),
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
