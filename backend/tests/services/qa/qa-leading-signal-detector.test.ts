/**
 * QALeadingSignalDetector 单元测试 (US-039 QA-003).
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/qa/qa-leading-signal-detector.test.ts
 *
 * 覆盖维度:
 *   - SIGNAL_THRESHOLDS / SIGNAL_TYPES / SIGNAL_LEVELS 常量冻结;
 *   - 纯函数:
 *     - computeQuestionsGrowthPct (持平/正常增/prev=0 curr>0=∞/prev=0 curr=0=null/负数/NaN);
 *     - classifySignalLevel;
 *     - detectForStat (各信号 happy 触发, 阈值边界, MIN_QUESTIONS_COUNT 噪音过滤,
 *       template_score=null/0, top_subtopic 不匹配, 多信号同时触发);
 *     - detectForStockStats (多周递增/递减/单周/空/排序);
 *     - rowToStatLike (Sequelize-like / plain obj 转 plain);
 *     - clampLookbackDays / getCutoffIso 边界;
 *   - service.detectForStocks:
 *     - happy path: 多股 + 多周 → 总信号 ≥ 5 (AC 主验收);
 *     - fail-OPEN: 单股 listByStock throws 不阻塞;
 *     - invalid code skip + 仍 continue;
 *     - lookback_days cutoff 过滤掉早于窗口的信号;
 *     - 全局排序: week_start desc + strong 先 + stock_code asc.
 */

import {
  SIGNAL_THRESHOLDS,
  SIGNAL_TYPES,
  SIGNAL_LEVELS,
  QALeadingSignal,
  QALeadingSignalType,
  computeQuestionsGrowthPct,
  classifySignalLevel,
  detectForStat,
  detectForStockStats,
  rowToStatLike,
  clampLookbackDays,
  getCutoffIso,
  StatLike,
  QALeadingSignalDataSource,
  QALeadingSignalDetector,
  DEFAULT_LOOKBACK_DAYS,
  MAX_LOOKBACK_WEEKS,
} from '../../../src/services/qa/QALeadingSignalDetector';
import { TOPIC_SUBCATEGORIES } from '../../../src/services/EastMoneyQATopicService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

function stat(
  code: string,
  week: string,
  q: number,
  a: number,
  rate: number,
  topSub: string,
  tmpl: number | null
): StatLike {
  return {
    stock_code: code,
    stock_name: code === '600519' ? '贵州茅台' : null,
    week_start: week,
    questions_count: q,
    answer_count: a,
    answer_rate: rate,
    top_subtopic: topSub,
    answer_template_score: tmpl,
  };
}

// ---------------------------------------------------------------------------
// 常量冻结
// ---------------------------------------------------------------------------

function testConstantsFrozen(): void {
  assert('SIGNAL_THRESHOLDS frozen', Object.isFrozen(SIGNAL_THRESHOLDS));
  assert('SIGNAL_TYPES frozen', Object.isFrozen(SIGNAL_TYPES));
  assert('SIGNAL_LEVELS frozen', Object.isFrozen(SIGNAL_LEVELS));
  assert('QUESTIONS_GROWTH_PCT_HIGH = 2.0', SIGNAL_THRESHOLDS.QUESTIONS_GROWTH_PCT_HIGH === 2.0);
  assert('ANSWER_RATE_HIGH = 0.5', SIGNAL_THRESHOLDS.ANSWER_RATE_HIGH === 0.5);
  assert('ANSWER_RATE_LOW = 0.1', SIGNAL_THRESHOLDS.ANSWER_RATE_LOW === 0.1);
  assert('TEMPLATE_SCORE_HIGH_QUALITY = 0.3', SIGNAL_THRESHOLDS.TEMPLATE_SCORE_HIGH_QUALITY === 0.3);
  assert('MIN_QUESTIONS_COUNT ≥ 1', SIGNAL_THRESHOLDS.MIN_QUESTIONS_COUNT >= 1);
  assert('MIN_ANSWER_COUNT ≥ 1', SIGNAL_THRESHOLDS.MIN_ANSWER_COUNT >= 1);
  assert(
    'SIGNAL_TYPES 三类齐',
    Object.values(SIGNAL_TYPES).length === 3 &&
      SIGNAL_TYPES.EARNINGS_BULLISH === 'earnings_bullish' &&
      SIGNAL_TYPES.EARNINGS_BEARISH === 'earnings_bearish' &&
      SIGNAL_TYPES.EARNINGS_FORECAST_LEADING === 'earnings_forecast_leading'
  );
  assert('DEFAULT_LOOKBACK_DAYS = 90', DEFAULT_LOOKBACK_DAYS === 90);
  assert('MAX_LOOKBACK_WEEKS = 104', MAX_LOOKBACK_WEEKS === 104);
}

// ---------------------------------------------------------------------------
// computeQuestionsGrowthPct
// ---------------------------------------------------------------------------

function testComputeQuestionsGrowthPct(): void {
  assertEqual('持平 (10→10) = 0', computeQuestionsGrowthPct(10, 10), 0);
  assertEqual('+200% (10→30)', computeQuestionsGrowthPct(30, 10), 2);
  assertEqual('-50% (10→5)', computeQuestionsGrowthPct(5, 10), -0.5);
  assert(
    'prev=0 curr>0 → +Inf',
    computeQuestionsGrowthPct(5, 0) === Number.POSITIVE_INFINITY
  );
  assertEqual('prev=0 curr=0 → null', computeQuestionsGrowthPct(0, 0), null);
  assertEqual('负 curr → null', computeQuestionsGrowthPct(-1, 10), null);
  assertEqual('NaN curr → null', computeQuestionsGrowthPct(NaN, 10), null);
  assertEqual('NaN prev → null', computeQuestionsGrowthPct(10, NaN), null);
  assertEqual('+50% 精度', computeQuestionsGrowthPct(15, 10), 0.5);
}

// ---------------------------------------------------------------------------
// classifySignalLevel
// ---------------------------------------------------------------------------

function testClassifySignalLevel(): void {
  assertEqual('bullish=strong', classifySignalLevel(SIGNAL_TYPES.EARNINGS_BULLISH), SIGNAL_LEVELS.STRONG);
  assertEqual('bearish=strong', classifySignalLevel(SIGNAL_TYPES.EARNINGS_BEARISH), SIGNAL_LEVELS.STRONG);
  assertEqual(
    'forecast_leading=moderate',
    classifySignalLevel(SIGNAL_TYPES.EARNINGS_FORECAST_LEADING),
    SIGNAL_LEVELS.MODERATE
  );
}

// ---------------------------------------------------------------------------
// detectForStat
// ---------------------------------------------------------------------------

function testDetectForStatBullishHappy(): void {
  // 上周 5 → 本周 20 (+300%), 答复率 60%
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 20, 14, 0.7, TOPIC_SUBCATEGORIES.FINANCE_OTHER, 0.4),
    prev: stat('600519', '2026-06-08', 5, 0, 0, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
  });
  assertEqual('bullish 单触发数量', sigs.length, 1);
  assertEqual('type=bullish', sigs[0].signal_type, SIGNAL_TYPES.EARNINGS_BULLISH);
  assertEqual('level=strong', sigs[0].level, SIGNAL_LEVELS.STRONG);
  assert('growth=3.0', sigs[0].questions_growth_pct === 3);
}

function testDetectForStatBearishHappy(): void {
  // 上周 4 → 本周 30 (+650%), 答复率 5%
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 30, 1, 0.05, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    prev: stat('600519', '2026-06-08', 4, 1, 0.25, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
  });
  assertEqual('bearish 单触发数量', sigs.length, 1);
  assertEqual('type=bearish', sigs[0].signal_type, SIGNAL_TYPES.EARNINGS_BEARISH);
  assertEqual('level=strong', sigs[0].level, SIGNAL_LEVELS.STRONG);
}

function testDetectForStatLeadingHappy(): void {
  // top_subtopic=EARNINGS_FORECAST, template_score=0.15 (高质量), answer_count=5
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.15),
    prev: null,
  });
  assertEqual('leading 单触发数量', sigs.length, 1);
  assertEqual('type=leading', sigs[0].signal_type, SIGNAL_TYPES.EARNINGS_FORECAST_LEADING);
  assertEqual('level=moderate', sigs[0].level, SIGNAL_LEVELS.MODERATE);
}

function testDetectForStatBullishAndLeading(): void {
  // 同周 bullish (growth + answer_rate) + leading (earnings_forecast + template < 0.3)
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 30, 25, 0.83, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.2),
    prev: stat('600519', '2026-06-08', 5, 0, 0, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
  });
  assertEqual('同周双触发', sigs.length, 2);
  const types = sigs.map(s => s.signal_type).sort();
  assertEqual('包含 bullish+leading', types, ['earnings_bullish', 'earnings_forecast_leading']);
}

function testDetectForStatMinQuestionsNoise(): void {
  // 本周 3 < MIN_QUESTIONS_COUNT, 即使 growth = +200% 也不触发
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 3, 3, 0.8, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    prev: stat('600519', '2026-06-08', 1, 0, 0, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
  });
  assertEqual('小样本 0 信号', sigs.length, 0);
}

function testDetectForStatMinAnswerCountNoise(): void {
  // earnings_forecast + 高质量 但 answer_count=2 < MIN_ANSWER_COUNT
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 10, 2, 0.2, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.1),
    prev: null,
  });
  assertEqual('leading 小回答样本 0 信号', sigs.length, 0);
}

function testDetectForStatTemplateNullNoLeading(): void {
  // template_score=null (本周无回答) — 即使 top_subtopic 是 EF, 也不触发
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 10, 0, 0, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, null),
    prev: null,
  });
  assertEqual('leading null template 0 信号', sigs.length, 0);
}

function testDetectForStatTemplateAtThreshold(): void {
  // template_score = 0.3 (严格 <), 不触发
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.3),
    prev: null,
  });
  assertEqual('leading 边界 = 0.3 不触发', sigs.length, 0);
}

function testDetectForStatGrowthAtThreshold(): void {
  // growth = 200% (严格 >), 不触发 bullish
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 15, 12, 0.8, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    prev: stat('600519', '2026-06-08', 5, 0, 0, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
  });
  // growth = (15-5)/5 = 2.0; 严格 > 2.0 不满足 → 不触发
  assertEqual('growth=200 边界不触发', sigs.length, 0);
}

function testDetectForStatRateAtThreshold(): void {
  // answer_rate = 0.5 (严格 >), 不触发 bullish
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 20, 10, 0.5, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    prev: stat('600519', '2026-06-08', 5, 0, 0, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
  });
  // growth = +300% (满足); answer_rate = 0.5 (不严格 >), 不触发 bullish;
  // answer_rate = 0.5 也不 < 0.1, 不触发 bearish.
  assertEqual('rate=0.5 边界不触发', sigs.length, 0);
}

function testDetectForStatNullPrev(): void {
  // 无 prev — growth 类不触发, leading 仍可
  const sigsLead = detectForStat({
    curr: stat('600519', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.2),
    prev: null,
  });
  assertEqual('无 prev leading 仍触发', sigsLead.length, 1);

  const sigsBull = detectForStat({
    curr: stat('600519', '2026-06-15', 30, 25, 0.83, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    prev: null,
  });
  // prev=null → growth=null → 不触发 growth 类
  assertEqual('无 prev growth 类不触发', sigsBull.length, 0);
}

function testDetectForStatPrevZeroInfinityGrowth(): void {
  // prev questions=0 curr>0 → growth=+Inf, > 2.0 → bullish 触发
  const sigs = detectForStat({
    curr: stat('600519', '2026-06-15', 20, 15, 0.75, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    prev: stat('600519', '2026-06-08', 0, 0, 0, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
  });
  assertEqual('prev=0 curr>0 → bullish 触发', sigs.length, 1);
  assertEqual('type=bullish', sigs[0].signal_type, SIGNAL_TYPES.EARNINGS_BULLISH);
  assert('growth = Infinity', sigs[0].questions_growth_pct === Number.POSITIVE_INFINITY);
}

// ---------------------------------------------------------------------------
// detectForStockStats
// ---------------------------------------------------------------------------

function testDetectForStockStatsMultiWeek(): void {
  // 4 周, 每周对前周计算 growth; 期望最少 1 个 signal
  const stats: StatLike[] = [
    stat('600519', '2026-05-25', 4, 0, 0, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    stat('600519', '2026-06-01', 5, 0, 0, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    stat('600519', '2026-06-08', 30, 25, 0.83, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.2),
    stat('600519', '2026-06-15', 50, 5, 0.1, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
  ];
  const sigs = detectForStockStats(stats);
  // 06-08: bullish + leading; 06-15: bearish?  growth = (50-30)/30 ≈ 0.67 — 不到 200%
  // → 仅 06-08 双触发
  assert('signals ≥ 2', sigs.length >= 2);
  assertEqual('排序 week_start desc', sigs[0].week_start, '2026-06-08');
  // strong 先 → bullish (strong) 排前 leading (moderate)
  assertEqual('strong 先', sigs[0].level, SIGNAL_LEVELS.STRONG);
}

function testDetectForStockStatsEmpty(): void {
  assertEqual('空 → []', detectForStockStats([]), []);
  assertEqual('非数组 → []', detectForStockStats(null as any), []);
}

function testDetectForStockStatsUnsorted(): void {
  // 乱序输入仍按 week ASC 排序识别 growth baseline
  const stats: StatLike[] = [
    stat('600519', '2026-06-15', 30, 25, 0.83, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    stat('600519', '2026-06-08', 5, 0, 0, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
  ];
  const sigs = detectForStockStats(stats);
  assertEqual('乱序仍 1 bullish', sigs.length, 1);
  assertEqual('type=bullish', sigs[0].signal_type, SIGNAL_TYPES.EARNINGS_BULLISH);
}

// ---------------------------------------------------------------------------
// rowToStatLike
// ---------------------------------------------------------------------------

function testRowToStatLikePlain(): void {
  const r = stat('600519', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.2);
  const out = rowToStatLike(r);
  assertEqual('plain 转 plain stock_code', out.stock_code, '600519');
  assertEqual('plain 转 plain template', out.answer_template_score, 0.2);
}

function testRowToStatLikeStringTemplate(): void {
  // Sequelize DECIMAL 列常返字符串 — 应转 number
  const r: any = {
    stock_code: '600519',
    stock_name: '贵州茅台',
    week_start: '2026-06-15',
    questions_count: '10',
    answer_count: '5',
    answer_rate: '0.500',
    top_subtopic: 'earnings_forecast',
    answer_template_score: '0.200',
  };
  const out = rowToStatLike(r);
  assert('string questions_count → number', typeof out.questions_count === 'number' && out.questions_count === 10);
  assert('string answer_rate → number', typeof out.answer_rate === 'number' && out.answer_rate === 0.5);
  assert(
    'string template → number',
    typeof out.answer_template_score === 'number' && out.answer_template_score === 0.2
  );
}

function testRowToStatLikeNullTemplate(): void {
  const r: any = {
    stock_code: '600519',
    stock_name: null,
    week_start: '2026-06-15',
    questions_count: 0,
    answer_count: 0,
    answer_rate: 0,
    top_subtopic: 'other_general',
    answer_template_score: null,
  };
  const out = rowToStatLike(r);
  assertEqual('null template 保留 null', out.answer_template_score, null);
  assertEqual('null stock_name 保留 null', out.stock_name, null);
}

// ---------------------------------------------------------------------------
// clampLookbackDays / getCutoffIso
// ---------------------------------------------------------------------------

function testClampLookbackDays(): void {
  assertEqual('默认 = 90', clampLookbackDays(undefined), 90);
  assertEqual('合法 30', clampLookbackDays(30), 30);
  assertEqual('< 1 → 1', clampLookbackDays(0), 1);
  assertEqual('负数 → 1', clampLookbackDays(-100), 1);
  assertEqual('> max → cap', clampLookbackDays(99999), MAX_LOOKBACK_WEEKS * 7);
  assertEqual('NaN → 默认', clampLookbackDays(NaN), DEFAULT_LOOKBACK_DAYS);
  assertEqual('小数向下', clampLookbackDays(7.9), 7);
}

function testGetCutoffIso(): void {
  const now = new Date('2026-06-19T00:00:00Z');
  assertEqual('90 天前', getCutoffIso(90, now), '2026-03-21');
  assertEqual('7 天前', getCutoffIso(7, now), '2026-06-12');
  assertEqual('0 天 = 今天 UTC', getCutoffIso(0, now), '2026-06-19');
}

// ---------------------------------------------------------------------------
// Fake DataSource
// ---------------------------------------------------------------------------

interface FakeDSState {
  fixturesByStock: Record<string, StatLike[]>;
  throwForStock?: Set<string>;
}

function makeFakeDS(state: FakeDSState): QALeadingSignalDataSource {
  return {
    async listByStock(stockCode: string, _weeks: number): Promise<StatLike[]> {
      if (state.throwForStock?.has(stockCode)) {
        throw new Error(`fake: ${stockCode} unavailable`);
      }
      return state.fixturesByStock[stockCode] ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// service.detectForStocks
// ---------------------------------------------------------------------------

async function testDetectForStocksAcAtLeast5Signals(): Promise<void> {
  // AC 主验收: 90 天内 ≥ 5 信号
  // 准备 5 只股票, 每只都注入双周序列触发某种 signal — 总信号 ≥ 5
  const today = new Date();
  // 用最近 6 周日期
  function weekIso(weeksAgo: number): string {
    const d = new Date(today.getTime());
    d.setUTCDate(d.getUTCDate() - weeksAgo * 7);
    return d.toISOString().slice(0, 10);
  }

  const fixturesByStock: Record<string, StatLike[]> = {
    '600001': [
      // bullish: 5 → 30 + answer_rate 0.7
      stat('600001', weekIso(2), 5, 1, 0.2, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
      stat('600001', weekIso(1), 30, 21, 0.7, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    ],
    '600002': [
      // bearish: 5 → 40 + answer_rate 0.05
      stat('600002', weekIso(2), 5, 1, 0.2, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
      stat('600002', weekIso(1), 40, 2, 0.05, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    ],
    '600003': [
      // leading: earnings_forecast + template 0.15
      stat('600003', weekIso(1), 10, 5, 0.5, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.15),
    ],
    '600004': [
      // bullish + leading 双触发
      stat('600004', weekIso(2), 5, 1, 0.2, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
      stat('600004', weekIso(1), 35, 30, 0.86, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.2),
    ],
    '600005': [
      // 另一只 leading
      stat('600005', weekIso(3), 12, 6, 0.5, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.1),
    ],
  };

  const ds = makeFakeDS({ fixturesByStock });
  const detector = new QALeadingSignalDetector(ds);
  const result = await detector.detectForStocks(Object.keys(fixturesByStock));
  assertEqual('5 stocks total', result.total_stocks, 5);
  assertEqual('5 succeeded', result.stocks_succeeded, 5);
  assertEqual('0 failed', result.stocks_failed, 0);
  // 期望: 600001 bull (1) + 600002 bear (1) + 600003 lead (1) + 600004 bull+lead (2) + 600005 lead (1) = 6
  assert(`≥ 5 signals (got ${result.signals.length})`, result.signals.length >= 5);

  // 全局排序: week_start desc; strong 先
  for (let i = 1; i < result.signals.length; i++) {
    assert(
      `sorted desc at i=${i}`,
      result.signals[i - 1].week_start >= result.signals[i].week_start
    );
  }
}

async function testDetectForStocksFailOpen(): Promise<void> {
  const fixturesByStock: Record<string, StatLike[]> = {
    '600001': [
      stat('600001', '2026-06-08', 5, 1, 0.2, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
      stat('600001', '2026-06-15', 30, 25, 0.83, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    ],
    '600002': [],
  };
  const ds = makeFakeDS({
    fixturesByStock,
    throwForStock: new Set(['600002']),
  });
  const detector = new QALeadingSignalDetector(ds);
  const result = await detector.detectForStocks(['600001', '600002']);
  assertEqual('fail-OPEN total', result.total_stocks, 2);
  assertEqual('fail-OPEN succeeded', result.stocks_succeeded, 1);
  assertEqual('fail-OPEN failed', result.stocks_failed, 1);
  assert('600001 仍有 signal', result.signals.some(s => s.stock_code === '600001'));
}

async function testDetectForStocksInvalidCode(): Promise<void> {
  const fixturesByStock: Record<string, StatLike[]> = {
    '600001': [
      stat('600001', '2026-06-08', 5, 1, 0.2, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
      stat('600001', '2026-06-15', 30, 25, 0.83, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    ],
  };
  const ds = makeFakeDS({ fixturesByStock });
  const detector = new QALeadingSignalDetector(ds);
  const result = await detector.detectForStocks(['BADCODE', '600001', '', '1234']);
  assertEqual('invalid total', result.total_stocks, 4);
  // 3 invalid + 1 valid; invalid 都计入 failed
  assertEqual('invalid succeeded', result.stocks_succeeded, 1);
  assertEqual('invalid failed', result.stocks_failed, 3);
}

async function testDetectForStocksLookbackCutoff(): Promise<void> {
  // 用一个非常远的过去日期 — lookback_days=7 应该把它过滤掉
  const fixturesByStock: Record<string, StatLike[]> = {
    '600001': [
      stat('600001', '2020-01-06', 5, 1, 0.2, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
      stat('600001', '2020-01-13', 30, 25, 0.83, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    ],
  };
  const ds = makeFakeDS({ fixturesByStock });
  const detector = new QALeadingSignalDetector(ds);
  const result = await detector.detectForStocks(['600001'], { lookback_days: 7 });
  assertEqual('cutoff 过滤 → 0 signal', result.signals.length, 0);
}

async function testDetectForStocksEmpty(): Promise<void> {
  const ds = makeFakeDS({ fixturesByStock: {} });
  const detector = new QALeadingSignalDetector(ds);
  const result = await detector.detectForStocks([]);
  assertEqual('空 codes total', result.total_stocks, 0);
  assertEqual('空 codes signals 空', result.signals.length, 0);
}

async function testDetectForStocksGlobalSortOrder(): Promise<void> {
  // 同一周多股: stock_code asc; strong 在 moderate 前
  const fixturesByStock: Record<string, StatLike[]> = {
    '600002': [
      stat('600002', '2026-06-15', 10, 5, 0.5, TOPIC_SUBCATEGORIES.EARNINGS_FORECAST, 0.15),
    ],
    '600001': [
      stat('600001', '2026-06-08', 5, 1, 0.2, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
      stat('600001', '2026-06-15', 30, 25, 0.83, TOPIC_SUBCATEGORIES.OTHER_GENERAL, null),
    ],
  };
  const ds = makeFakeDS({ fixturesByStock });
  const detector = new QALeadingSignalDetector(ds);
  const result = await detector.detectForStocks(['600001', '600002']);

  // signals 在同一 week_start=2026-06-15 内: strong (600001 bullish) 先于 moderate (600002 leading)
  const same = result.signals.filter(s => s.week_start === '2026-06-15');
  assert('同周两 signal', same.length === 2);
  assertEqual('strong 先', same[0].level, SIGNAL_LEVELS.STRONG);
  assertEqual('strong stock_code 600001', same[0].stock_code, '600001');
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testConstantsFrozen();
  testComputeQuestionsGrowthPct();
  testClassifySignalLevel();
  testDetectForStatBullishHappy();
  testDetectForStatBearishHappy();
  testDetectForStatLeadingHappy();
  testDetectForStatBullishAndLeading();
  testDetectForStatMinQuestionsNoise();
  testDetectForStatMinAnswerCountNoise();
  testDetectForStatTemplateNullNoLeading();
  testDetectForStatTemplateAtThreshold();
  testDetectForStatGrowthAtThreshold();
  testDetectForStatRateAtThreshold();
  testDetectForStatNullPrev();
  testDetectForStatPrevZeroInfinityGrowth();
  testDetectForStockStatsMultiWeek();
  testDetectForStockStatsEmpty();
  testDetectForStockStatsUnsorted();
  testRowToStatLikePlain();
  testRowToStatLikeStringTemplate();
  testRowToStatLikeNullTemplate();
  testClampLookbackDays();
  testGetCutoffIso();

  await testDetectForStocksAcAtLeast5Signals();
  await testDetectForStocksFailOpen();
  await testDetectForStocksInvalidCode();
  await testDetectForStocksLookbackCutoff();
  await testDetectForStocksEmpty();
  await testDetectForStocksGlobalSortOrder();

  console.log(`\n${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});

// type-only ref to keep unused-import warning quiet
const _typecheck: QALeadingSignal | null = null;
const _typecheck2: QALeadingSignalType = SIGNAL_TYPES.EARNINGS_BULLISH;
void _typecheck;
void _typecheck2;
