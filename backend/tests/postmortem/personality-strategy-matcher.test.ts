/**
 * PersonalityStrategyMatcher 单元测试 (US-127 [PM-025]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/postmortem/personality-strategy-matcher.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 / 枚举 sanity (LOOKBACK_DAYS / SUMMARY_MAX / 5 维 dim / 3 态 status / 4 类 category)
 *   [2] date / 截断 / safe helpers (computePeriodStart / daysBetween / clampChars)
 *   [3] personality 反推 (aggregatePreferredIndustries / estimateVolatility / classifiers /
 *       avgHoldDays / buildPersonality)
 *   [4] strategy 反推 (inferStrategyIndustries / inferStrategyVol / inferStrategyTurnover /
 *       inferStrategyHoldClass)
 *   [5] 5 维 score (scoreIndustryOverlap / scoreVolMatch / scoreTurnoverMatch /
 *       scoreHoldMatch / scoreQualityBonus / computeStrategyMatch)
 *   [6] 总体 matches (buildStrategyProfiles / computeOverallScore / buildSuggestions /
 *       buildMatches)
 *   [7] heuristic summary (buildHeuristicSummary cap + 内容)
 *   [8] matchForUser AC 主验收:
 *        (a) happy → ok + persisted + matches.suggestions ≥ 1
 *        (b) 全空 → skipped reason=no_data + 留痕
 *        (c) load throw → failed reason=load_threw + 留痕
 *        (d) upsert 返 ok=false → failed + reason 透传 + persisted=false
 *        (e) upsert throw → failed reason=upsert_threw + persisted=false
 *        (f) cron_run_id 流入 metadata
 *        (g) disabled 策略被过滤
 *   [9] PRODUCTION DataSource factory — 不抛 (lazy require)
 *   [10] META-GUARD fs+regex (model + migration up + migration down + database.ts + index.ts)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_LOOKBACK_DAYS,
  PERSONALITY_MATCH_SUMMARY_MAX_CHARS,
  PREFERRED_INDUSTRIES_TOP_N,
  SUGGESTIONS_MAX,
  REASON_MAX_CHARS,
  MATCH_DIMENSION_POINTS,
  MATCH_DIMENSIONS,
  OVERALL_SCORE_LOW_THRESHOLD,
  PERSONALITY_MATCH_SOURCE,
  PERSONALITY_MATCH_STATUS,
  SUGGESTION_SEVERITY,
  SUGGESTION_CATEGORY,
  TRADE_FREQ_HIGH_PER_DAY,
  TRADE_FREQ_MEDIUM_PER_DAY,
  HOLD_LONG_MIN_DAYS,
  HOLD_MEDIUM_MIN_DAYS,
  VOL_HIGH_PCT,
  VOL_MEDIUM_PCT,
  computePeriodStart,
  daysBetween,
  clampChars,
  aggregatePreferredIndustries,
  estimateVolatility,
  classifyRiskTolerance,
  classifyTradeFrequency,
  classifyHoldingPeriod,
  avgHoldDays,
  buildPersonality,
  inferStrategyIndustries,
  inferStrategyVol,
  inferStrategyTurnover,
  inferStrategyHoldClass,
  scoreIndustryOverlap,
  scoreVolMatch,
  scoreTurnoverMatch,
  scoreHoldMatch,
  scoreQualityBonus,
  computeStrategyMatch,
  buildStrategyProfiles,
  computeOverallScore,
  buildSuggestions,
  buildMatches,
  buildHeuristicSummary,
  matchForUser,
  createProductionPersonalityStrategyMatcherDataSource,
  TradeRecord,
  PositionRecord,
  ActiveStrategyRecord,
  DailyPnlPoint,
  Personality,
  PersonalityStrategyMatcherDataSource,
  PersonalityMatchUpsertRow,
} from '../../src/services/postmortem/PersonalityStrategyMatcher';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    symbol: '600519',
    industry: '白酒',
    direction: 'BUY',
    amount: 10000,
    trade_date: '2026-05-15',
    ...overrides,
  };
}

function makePosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    symbol: '600519',
    industry: '白酒',
    market_value: 100000,
    opened_at: '2026-05-01',
    ...overrides,
  };
}

function makeStrategy(overrides: Partial<ActiveStrategyRecord> = {}): ActiveStrategyRecord {
  return {
    strategy_key: 'CTA100',
    strategy_name: 'CTA100 日频动量',
    category: 'momentum',
    weight: 0.5,
    action: 'enabled',
    quality_score: 0.7,
    tags: ['行业:白酒'],
    default_params: {},
    ...overrides,
  };
}

function makePnl(date: string, pct: number): DailyPnlPoint {
  return { date, pnl_pct: pct };
}

(async function main(): Promise<void> {
  // ---- [1] 常量 / 枚举 sanity ----------------------------------------------
  assert('[1.1] DEFAULT_LOOKBACK_DAYS=90', DEFAULT_LOOKBACK_DAYS === 90);
  assert(
    '[1.2] PERSONALITY_MATCH_SUMMARY_MAX_CHARS=500',
    PERSONALITY_MATCH_SUMMARY_MAX_CHARS === 500
  );
  assert('[1.3] PREFERRED_INDUSTRIES_TOP_N=5', PREFERRED_INDUSTRIES_TOP_N === 5);
  assert('[1.4] SUGGESTIONS_MAX=5', SUGGESTIONS_MAX === 5);
  assert('[1.5] REASON_MAX_CHARS=60', REASON_MAX_CHARS === 60);
  assert('[1.6] MATCH_DIMENSION_POINTS=20', MATCH_DIMENSION_POINTS === 20);
  assert(
    '[1.7] MATCH_DIMENSIONS 5 维',
    MATCH_DIMENSIONS.length === 5 &&
      MATCH_DIMENSIONS.includes('industry_overlap') &&
      MATCH_DIMENSIONS.includes('vol_match') &&
      MATCH_DIMENSIONS.includes('turnover_match') &&
      MATCH_DIMENSIONS.includes('hold_match') &&
      MATCH_DIMENSIONS.includes('quality_bonus')
  );
  assert('[1.8] OVERALL_SCORE_LOW_THRESHOLD=50', OVERALL_SCORE_LOW_THRESHOLD === 50);
  assert(
    '[1.9] PERSONALITY_MATCH_SOURCE 三态',
    PERSONALITY_MATCH_SOURCE.HEURISTIC === 'heuristic' &&
      PERSONALITY_MATCH_SOURCE.LLM === 'llm' &&
      PERSONALITY_MATCH_SOURCE.MANUAL === 'manual'
  );
  assert(
    '[1.10] PERSONALITY_MATCH_STATUS 三态',
    PERSONALITY_MATCH_STATUS.OK === 'ok' &&
      PERSONALITY_MATCH_STATUS.SKIPPED === 'skipped' &&
      PERSONALITY_MATCH_STATUS.FAILED === 'failed'
  );
  assert(
    '[1.11] SUGGESTION_SEVERITY 三态',
    SUGGESTION_SEVERITY.LOW === 'low' &&
      SUGGESTION_SEVERITY.MEDIUM === 'medium' &&
      SUGGESTION_SEVERITY.HIGH === 'high'
  );
  assert(
    '[1.12] SUGGESTION_CATEGORY 四态',
    SUGGESTION_CATEGORY.ADD === 'add' &&
      SUGGESTION_CATEGORY.REDUCE === 'reduce' &&
      SUGGESTION_CATEGORY.REMOVE === 'remove' &&
      SUGGESTION_CATEGORY.TUNE === 'tune'
  );
  assert(
    '[1.13] 阈值 sanity (freq high > medium, hold long > medium, vol high > medium)',
    TRADE_FREQ_HIGH_PER_DAY > TRADE_FREQ_MEDIUM_PER_DAY &&
      HOLD_LONG_MIN_DAYS > HOLD_MEDIUM_MIN_DAYS &&
      VOL_HIGH_PCT > VOL_MEDIUM_PCT
  );

  // ---- [2] date / clamp / safe helpers --------------------------------------
  assert(
    '[2.1] computePeriodStart 2026-06-30 - 90 = 2026-04-02',
    computePeriodStart('2026-06-30', 90) === '2026-04-02'
  );
  assert(
    '[2.2] computePeriodStart 非法 → 兜底返 periodEnd',
    computePeriodStart('not-a-date', 90) === 'not-a-date'
  );
  assert(
    '[2.3] computePeriodStart lookback<=0 → 默认 90',
    computePeriodStart('2026-06-30', 0) === '2026-04-02'
  );
  assert('[2.4] daysBetween 同日 = 0', daysBetween('2026-06-30', '2026-06-30') === 0);
  assert(
    '[2.5] daysBetween b>a 正数',
    daysBetween('2026-06-01', '2026-06-30') === 29
  );
  assert('[2.6] daysBetween 非法 = 0', daysBetween('x', '2026-06-30') === 0);
  assert('[2.7] clampChars 短串不动', clampChars('abc', 10) === 'abc');
  assert('[2.8] clampChars 超 cap 加 …', clampChars('abcdefg', 4) === 'abc…');
  assert(
    '[2.9] clampChars 中文 surrogate-safe',
    Array.from(clampChars('一二三四五六七', 4)).length === 4
  );

  // ---- [3] personality 反推 -------------------------------------------------
  {
    const trades = [
      makeTrade({ industry: '白酒', amount: 6000 }),
      makeTrade({ industry: '白酒', amount: 4000 }),
      makeTrade({ industry: '消费', amount: 3000 }),
      makeTrade({ industry: null, amount: 1000 }),
    ];
    const out = aggregatePreferredIndustries(trades);
    assert('[3.1] 行业聚合按 share 降序', out[0].industry === '白酒');
    assert(
      '[3.2] 白酒 share = 10000/14000',
      Math.abs(out[0].share - 10000 / 14000) < 1e-9
    );
    assert(
      '[3.3] null industry 归 unknown 桶',
      out.some(o => o.industry === 'unknown')
    );
    assert('[3.4] 全部 share 加起来 = 1', Math.abs(out.reduce((s, o) => s + o.share, 0) - 1) < 1e-9);
  }
  {
    const out = aggregatePreferredIndustries([]);
    assert('[3.5] 空 trades → []', Array.isArray(out) && out.length === 0);
  }
  {
    // share 同款 tie-break 字母序
    const trades = [
      makeTrade({ industry: 'B', amount: 100 }),
      makeTrade({ industry: 'A', amount: 100 }),
    ];
    const out = aggregatePreferredIndustries(trades);
    assert('[3.6] tie-break A 在 B 前', out[0].industry === 'A');
  }
  {
    // estimateVolatility — sample SD
    const pnls = [
      makePnl('2026-06-01', 1.0),
      makePnl('2026-06-02', -1.0),
      makePnl('2026-06-03', 1.0),
      makePnl('2026-06-04', -1.0),
    ];
    const vol = estimateVolatility(pnls);
    assert('[3.7] estimateVolatility ≈ 1.0', Math.abs(vol - 1.0) < 1e-6);
  }
  assert('[3.8] estimateVolatility <2 点 = 0', estimateVolatility([makePnl('d', 1)]) === 0);
  assert('[3.9] estimateVolatility 空 = 0', estimateVolatility([]) === 0);
  assert('[3.10] classifyRiskTolerance vol 3 = high', classifyRiskTolerance(3) === 'high');
  assert('[3.11] classifyRiskTolerance vol 1 = medium', classifyRiskTolerance(1) === 'medium');
  assert('[3.12] classifyRiskTolerance vol 0.1 = low', classifyRiskTolerance(0.1) === 'low');
  assert('[3.13] classifyTradeFrequency 100/90 = high', classifyTradeFrequency(100, 90) === 'high');
  assert('[3.14] classifyTradeFrequency 20/90 = medium', classifyTradeFrequency(20, 90) === 'medium');
  assert('[3.15] classifyTradeFrequency 5/90 = low', classifyTradeFrequency(5, 90) === 'low');
  assert('[3.16] classifyTradeFrequency lookback=0 = low', classifyTradeFrequency(10, 0) === 'low');
  assert('[3.17] classifyHoldingPeriod 60 = long', classifyHoldingPeriod(60) === 'long');
  assert('[3.18] classifyHoldingPeriod 10 = medium', classifyHoldingPeriod(10) === 'medium');
  assert('[3.19] classifyHoldingPeriod 2 = short', classifyHoldingPeriod(2) === 'short');
  {
    const positions = [
      makePosition({ opened_at: '2026-06-01' }),
      makePosition({ opened_at: '2026-06-15' }),
    ];
    const avg = avgHoldDays(positions, '2026-06-30');
    assert('[3.20] avgHoldDays (29+15)/2 = 22', Math.abs(avg - 22) < 1e-6);
  }
  assert('[3.21] avgHoldDays 空 = 0', avgHoldDays([], '2026-06-30') === 0);
  assert(
    '[3.22] avgHoldDays 缺 opened_at = 0 但计数',
    avgHoldDays([makePosition({ opened_at: null })], '2026-06-30') === 0
  );
  {
    const p = buildPersonality({
      trades: [makeTrade({ industry: '白酒', amount: 10000 })],
      positions: [makePosition({ opened_at: '2026-06-01' })],
      pnls: [makePnl('2026-06-01', 1.0), makePnl('2026-06-02', -1.0)],
      period_end: '2026-06-30',
      lookback_days: 90,
    });
    assert('[3.23] buildPersonality 6 字段齐全',
      p.preferred_industries.length === 1 &&
        ['low', 'medium', 'high'].includes(p.risk_tolerance) &&
        ['low', 'medium', 'high'].includes(p.trade_frequency) &&
        ['short', 'medium', 'long'].includes(p.holding_period) &&
        typeof p.avg_hold_days === 'number' &&
        typeof p.estimated_volatility === 'number'
    );
  }

  // ---- [4] strategy 反推 ----------------------------------------------------
  {
    const s = makeStrategy({ tags: ['行业:白酒', '消费', 'industry:科技'] });
    const inds = inferStrategyIndustries(s);
    assert('[4.1] inferStrategyIndustries 去前缀', inds.includes('白酒') && inds.includes('消费') && inds.includes('科技'));
  }
  {
    const s = makeStrategy({ tags: [], default_params: { industries: ['白酒', '消费'] } });
    const inds = inferStrategyIndustries(s);
    assert('[4.2] inferStrategyIndustries 读 default_params.industries', inds.length === 2);
  }
  {
    const s = makeStrategy({ tags: ['行业:白酒', '行业:白酒'] });
    const inds = inferStrategyIndustries(s);
    assert('[4.3] inferStrategyIndustries 去重', inds.length === 1);
  }
  {
    const s = makeStrategy({ tags: [], default_params: {} });
    assert('[4.4] inferStrategyIndustries 全空 = []', inferStrategyIndustries(s).length === 0);
  }
  assert('[4.5] inferStrategyVol momentum = high', inferStrategyVol(makeStrategy({ category: 'momentum', tags: [] })) === 'high');
  assert('[4.6] inferStrategyVol value = low', inferStrategyVol(makeStrategy({ category: 'value', tags: [] })) === 'low');
  assert('[4.7] inferStrategyVol default medium', inferStrategyVol(makeStrategy({ category: 'other', tags: [] })) === 'medium');
  assert('[4.8] inferStrategyTurnover daily = high', inferStrategyTurnover(makeStrategy({ category: 'daily', tags: [] })) === 'high');
  assert('[4.9] inferStrategyTurnover weekly = medium', inferStrategyTurnover(makeStrategy({ category: 'weekly', tags: [] })) === 'medium');
  assert('[4.10] inferStrategyTurnover monthly = low', inferStrategyTurnover(makeStrategy({ category: 'monthly', tags: [] })) === 'low');
  assert('[4.11] inferStrategyTurnover 默认 medium', inferStrategyTurnover(makeStrategy({ category: 'foo', tags: [] })) === 'medium');
  assert('[4.12] inferStrategyHoldClass intraday = short', inferStrategyHoldClass(makeStrategy({ category: 'intraday', tags: [] })) === 'short');
  assert('[4.13] inferStrategyHoldClass value = long', inferStrategyHoldClass(makeStrategy({ category: 'value', tags: [] })) === 'long');
  assert('[4.14] inferStrategyHoldClass 默认 medium', inferStrategyHoldClass(makeStrategy({ category: 'foo', tags: [] })) === 'medium');
  assert('[4.15] inferStrategyVol 中文 高股息 = low', inferStrategyVol(makeStrategy({ category: '', tags: ['高股息'] })) === 'low');
  assert('[4.16] inferStrategyVol 中文 动量 = high', inferStrategyVol(makeStrategy({ category: '', tags: ['动量'] })) === 'high');

  // ---- [5] 5 维 score -------------------------------------------------------
  {
    const r = scoreIndustryOverlap([], ['白酒']);
    assert('[5.1] 无偏好 → 满分中性', r.points === MATCH_DIMENSION_POINTS);
  }
  {
    const r = scoreIndustryOverlap([{ industry: '白酒', share: 1 }], []);
    assert('[5.2] 策略无 focus → 0.6 * 满分', r.points === MATCH_DIMENSION_POINTS * 0.6);
  }
  {
    const r = scoreIndustryOverlap(
      [{ industry: '白酒', share: 0.5 }, { industry: '消费', share: 0.5 }],
      ['白酒']
    );
    assert('[5.3] 半命中 = 10 分', Math.abs(r.points - 10) < 1e-9);
  }
  {
    const r = scoreIndustryOverlap(
      [{ industry: '白酒', share: 1 }],
      ['科技']
    );
    assert('[5.4] 全不命中 = 0', r.points === 0);
  }
  assert('[5.5] scoreVolMatch 同档满分', scoreVolMatch('high', 'high').points === MATCH_DIMENSION_POINTS);
  assert('[5.6] scoreVolMatch 相邻 0.5×', scoreVolMatch('high', 'medium').points === MATCH_DIMENSION_POINTS * 0.5);
  assert('[5.7] scoreVolMatch 极端失配 = 0', scoreVolMatch('high', 'low').points === 0);
  assert('[5.8] scoreTurnoverMatch 同档满分', scoreTurnoverMatch('low', 'low').points === MATCH_DIMENSION_POINTS);
  assert('[5.9] scoreHoldMatch short vs long = 0', scoreHoldMatch('short', 'long').points === 0);
  assert('[5.10] scoreHoldMatch short vs medium = 10', scoreHoldMatch('short', 'medium').points === MATCH_DIMENSION_POINTS * 0.5);
  {
    const r = scoreQualityBonus(null);
    assert('[5.11] quality null → 中性 0.5×', r.points === MATCH_DIMENSION_POINTS * 0.5);
  }
  {
    const r = scoreQualityBonus(0.8);
    assert('[5.12] quality 0.8 → 16 分', Math.abs(r.points - 16) < 1e-9);
  }
  {
    const r = scoreQualityBonus(1.5);
    assert('[5.13] quality clamp 上界 1', r.points === MATCH_DIMENSION_POINTS);
  }
  {
    const r = scoreQualityBonus(-0.5);
    assert('[5.14] quality clamp 下界 0', r.points === 0);
  }
  {
    const personality: Personality = {
      preferred_industries: [{ industry: '白酒', share: 1 }],
      risk_tolerance: 'high',
      trade_frequency: 'high',
      holding_period: 'short',
      avg_hold_days: 3,
      estimated_volatility: 2.5,
    };
    const s = makeStrategy({
      category: 'cta',
      tags: ['行业:白酒'],
      quality_score: 1,
    });
    const r = computeStrategyMatch(personality, s);
    assert('[5.15] computeStrategyMatch 全匹配 = 100',
      r.match_score === 100 &&
        r.match_reasons.length === 3 &&
        r.profile.industries_focus.includes('白酒')
    );
  }
  {
    const personality: Personality = {
      preferred_industries: [{ industry: '科技', share: 1 }],
      risk_tolerance: 'low',
      trade_frequency: 'low',
      holding_period: 'long',
      avg_hold_days: 60,
      estimated_volatility: 0.1,
    };
    const s = makeStrategy({
      category: 'cta',
      tags: ['行业:白酒'],
      quality_score: 0,
    });
    const r = computeStrategyMatch(personality, s);
    assert('[5.16] computeStrategyMatch 全失配低分', r.match_score === 0);
  }

  // ---- [6] 总体 matches -----------------------------------------------------
  {
    const personality: Personality = {
      preferred_industries: [{ industry: '白酒', share: 1 }],
      risk_tolerance: 'high',
      trade_frequency: 'high',
      holding_period: 'short',
      avg_hold_days: 3,
      estimated_volatility: 2.5,
    };
    const strategies = [
      makeStrategy({ strategy_key: 'A', weight: 0.7, category: 'momentum', tags: ['行业:白酒', '日频'], quality_score: 1 }),
      makeStrategy({ strategy_key: 'B', weight: 0.3, category: 'value', tags: ['行业:科技'], quality_score: 0 }),
    ];
    const profiles = buildStrategyProfiles(personality, strategies);
    assert('[6.1] buildStrategyProfiles 排序按 weight desc', profiles[0].strategy_key === 'A');
    const overall = computeOverallScore(profiles);
    assert('[6.2] overall_score 加权平均 in [0,100]', overall >= 0 && overall <= 100);
    const matches = buildMatches(profiles, personality);
    assert('[6.3] best_match A', matches.best_match?.strategy_key === 'A');
    assert('[6.4] worst_match B', matches.worst_match?.strategy_key === 'B');
    assert('[6.5] suggestions ≥ 1 (PRD AC)', matches.suggestions.length >= 1);
  }
  {
    // 空策略 → suggestions 仍 ≥ 1
    const personality: Personality = {
      preferred_industries: [],
      risk_tolerance: 'low',
      trade_frequency: 'low',
      holding_period: 'short',
      avg_hold_days: 0,
      estimated_volatility: 0,
    };
    const sug = buildSuggestions(personality, [], 0);
    assert('[6.6] 空策略 suggestion = 1 条 ADD', sug.length === 1 && sug[0].category === 'add');
  }
  {
    // 高分 → ADD low; 低分 → REMOVE high
    const personality: Personality = {
      preferred_industries: [{ industry: '白酒', share: 1 }],
      risk_tolerance: 'high',
      trade_frequency: 'high',
      holding_period: 'short',
      avg_hold_days: 0,
      estimated_volatility: 0,
    };
    const items = [
      { strategy_key: 'H', strategy_name: 'H', weight: 1, industries_focus: ['白酒'], expected_vol: 'high' as const, turnover_class: 'high' as const, hold_class: 'short' as const, quality_score: 1, match_score: 90, match_reasons: [] },
      { strategy_key: 'L', strategy_name: 'L', weight: 1, industries_focus: [], expected_vol: 'low' as const, turnover_class: 'low' as const, hold_class: 'long' as const, quality_score: 0, match_score: 20, match_reasons: [] },
    ];
    const sug = buildSuggestions(personality, items, 55);
    assert('[6.7] 含 REMOVE high', sug.some(s => s.category === 'remove' && s.severity === 'high'));
    assert('[6.8] 含 ADD low', sug.some(s => s.category === 'add' && s.severity === 'low'));
    assert('[6.9] severity 排序 high 在前', sug[0].severity === 'high');
  }
  {
    // overall < 50 触发 TUNE high
    const personality: Personality = {
      preferred_industries: [],
      risk_tolerance: 'medium',
      trade_frequency: 'medium',
      holding_period: 'medium',
      avg_hold_days: 10,
      estimated_volatility: 1,
    };
    const items = [
      { strategy_key: 'M', strategy_name: 'M', weight: 1, industries_focus: [], expected_vol: 'medium' as const, turnover_class: 'medium' as const, hold_class: 'medium' as const, quality_score: 0.5, match_score: 65, match_reasons: [] },
    ];
    const sug = buildSuggestions(personality, items, 40);
    assert('[6.10] overall < 50 触发 TUNE high', sug.some(s => s.category === 'tune' && s.severity === 'high'));
  }
  {
    // 兜底 — 中等分 + 无低无高 + overall ≥ 50 → 至少 1 条 TUNE low
    const personality: Personality = {
      preferred_industries: [],
      risk_tolerance: 'medium',
      trade_frequency: 'medium',
      holding_period: 'medium',
      avg_hold_days: 10,
      estimated_volatility: 1,
    };
    const items = [
      { strategy_key: 'M', strategy_name: 'M', weight: 1, industries_focus: [], expected_vol: 'medium' as const, turnover_class: 'medium' as const, hold_class: 'medium' as const, quality_score: 0.5, match_score: 70, match_reasons: [] },
    ];
    const sug = buildSuggestions(personality, items, 70);
    assert('[6.11] 兜底 1 条 TUNE low', sug.length >= 1);
  }
  assert('[6.12] computeOverallScore 空 = 0', computeOverallScore([]) === 0);
  {
    // weight 全 0 → 走平均
    const items = [
      { strategy_key: 'A', strategy_name: 'A', weight: 0, industries_focus: [], expected_vol: 'medium' as const, turnover_class: 'medium' as const, hold_class: 'medium' as const, quality_score: null, match_score: 80, match_reasons: [] },
      { strategy_key: 'B', strategy_name: 'B', weight: 0, industries_focus: [], expected_vol: 'medium' as const, turnover_class: 'medium' as const, hold_class: 'medium' as const, quality_score: null, match_score: 40, match_reasons: [] },
    ];
    assert('[6.13] weight 全 0 → 平均 60', computeOverallScore(items) === 60);
  }
  {
    const sug = buildSuggestions(
      {
        preferred_industries: [],
        risk_tolerance: 'medium',
        trade_frequency: 'medium',
        holding_period: 'medium',
        avg_hold_days: 0,
        estimated_volatility: 0,
      },
      Array.from({ length: 10 }, (_, i) => ({
        strategy_key: `s${i}`, strategy_name: `s${i}`, weight: 1, industries_focus: [], expected_vol: 'medium' as const, turnover_class: 'medium' as const, hold_class: 'medium' as const, quality_score: null, match_score: 30, match_reasons: [],
      })),
      30
    );
    assert('[6.14] suggestions ≤ SUGGESTIONS_MAX', sug.length <= SUGGESTIONS_MAX);
  }

  // ---- [7] heuristic summary ------------------------------------------------
  {
    const personality: Personality = {
      preferred_industries: [{ industry: '白酒', share: 0.6 }, { industry: '消费', share: 0.4 }],
      risk_tolerance: 'high',
      trade_frequency: 'medium',
      holding_period: 'short',
      avg_hold_days: 5,
      estimated_volatility: 1.5,
    };
    const items = [
      { strategy_key: 'CTA100', strategy_name: 'CTA100', weight: 0.6, industries_focus: ['白酒'], expected_vol: 'high' as const, turnover_class: 'high' as const, hold_class: 'short' as const, quality_score: 0.7, match_score: 85, match_reasons: [] },
    ];
    const matches = buildMatches(items, personality);
    const txt = buildHeuristicSummary(personality, items, matches, '2026-04-02', '2026-06-30');
    assert('[7.1] summary 含日期', /2026-04-02~2026-06-30/.test(txt));
    assert('[7.2] summary 含 风险=high', /风险=high/.test(txt));
    assert('[7.3] summary 含 白酒', /白酒/.test(txt));
    assert('[7.4] summary 含 整体匹配度', /整体匹配度/.test(txt));
    assert('[7.5] summary ≤ MAX', Array.from(txt).length <= PERSONALITY_MATCH_SUMMARY_MAX_CHARS);
  }
  {
    const personality: Personality = {
      preferred_industries: [],
      risk_tolerance: 'low',
      trade_frequency: 'low',
      holding_period: 'short',
      avg_hold_days: 0,
      estimated_volatility: 0,
    };
    const matches = buildMatches([], personality);
    const txt = buildHeuristicSummary(personality, [], matches, '2026-04-02', '2026-06-30');
    assert('[7.6] 空策略 summary 含占位语', /无活跃策略/.test(txt));
  }

  // ---- [8] matchForUser AC 主验收 ------------------------------------------
  function makeFakeDS(opts: {
    trades?: TradeRecord[];
    positions?: PositionRecord[];
    strategies?: ActiveStrategyRecord[];
    pnls?: DailyPnlPoint[];
    loadThrows?: 'trades' | 'positions' | 'strategies' | 'pnls' | false;
    upsertResult?: { ok: boolean; reason?: string; error?: string };
    upsertThrows?: boolean;
  }): PersonalityStrategyMatcherDataSource & { lastUpsert?: PersonalityMatchUpsertRow } {
    const state: { lastUpsert?: PersonalityMatchUpsertRow } = {};
    return {
      async loadTrades() {
        if (opts.loadThrows === 'trades') throw new Error('boom-trades');
        return opts.trades ?? [];
      },
      async loadPositions() {
        if (opts.loadThrows === 'positions') throw new Error('boom-positions');
        return opts.positions ?? [];
      },
      async loadActiveStrategies() {
        if (opts.loadThrows === 'strategies') throw new Error('boom-strategies');
        return opts.strategies ?? [];
      },
      async loadDailyPnl() {
        if (opts.loadThrows === 'pnls') throw new Error('boom-pnls');
        return opts.pnls ?? [];
      },
      async upsertPersonalityMatchReport(row) {
        state.lastUpsert = row;
        if (opts.upsertThrows) throw new Error('boom-upsert');
        return opts.upsertResult ?? { ok: true };
      },
      get lastUpsert() {
        return state.lastUpsert;
      },
    } as PersonalityStrategyMatcherDataSource & { lastUpsert?: PersonalityMatchUpsertRow };
  }

  {
    // (a) happy → ok + persisted + suggestions ≥ 1
    const ds = makeFakeDS({
      trades: [
        makeTrade({ industry: '白酒', amount: 10000, trade_date: '2026-06-01' }),
        makeTrade({ industry: '白酒', amount: 5000, trade_date: '2026-06-15' }),
      ],
      positions: [makePosition({ opened_at: '2026-06-01' })],
      strategies: [makeStrategy()],
      pnls: [makePnl('2026-06-01', 1), makePnl('2026-06-02', -1)],
    });
    const r = await matchForUser(1, { period_end: '2026-06-30', data_source: ds });
    assert('[8.a.1] status=ok', r.status === 'ok');
    assert('[8.a.2] persisted=true', r.persisted === true);
    assert('[8.a.3] strategies 非空', r.strategies.length === 1);
    assert('[8.a.4] matches.suggestions ≥ 1 (PRD AC)', r.matches.suggestions.length >= 1);
    assert('[8.a.5] summary 非空 + ≤ MAX', r.summary.length > 0 && Array.from(r.summary).length <= PERSONALITY_MATCH_SUMMARY_MAX_CHARS);
    assert(
      '[8.a.6] upsert row user_id=1 + period_end',
      ds.lastUpsert != null && ds.lastUpsert.user_id === 1 && ds.lastUpsert.period_end === '2026-06-30'
    );
    assert(
      '[8.a.7] upsert row period_start 90 天前',
      ds.lastUpsert != null && ds.lastUpsert.period_start === '2026-04-02'
    );
    assert(
      '[8.a.8] upsert row source=heuristic',
      ds.lastUpsert != null && ds.lastUpsert.source === 'heuristic'
    );
    assert(
      '[8.a.9] metadata trade_count + strategy_count',
      ds.lastUpsert != null &&
        (ds.lastUpsert.metadata as Record<string, unknown>).trade_count === 2 &&
        (ds.lastUpsert.metadata as Record<string, unknown>).strategy_count === 1
    );
  }
  {
    // (b) 全空 → skipped reason=no_data + 留痕
    const ds = makeFakeDS({});
    const r = await matchForUser(2, { period_end: '2026-06-30', data_source: ds });
    assert('[8.b.1] status=skipped', r.status === 'skipped');
    assert('[8.b.2] reason=no_data', r.reason === 'no_data');
    assert('[8.b.3] persisted=true (留痕)', r.persisted === true);
    assert(
      '[8.b.4] upsert row status=skipped',
      ds.lastUpsert != null && ds.lastUpsert.status === 'skipped'
    );
  }
  {
    // (c) load throw → failed + 留痕
    const ds = makeFakeDS({ loadThrows: 'trades' });
    const r = await matchForUser(3, { period_end: '2026-06-30', data_source: ds });
    assert('[8.c.1] status=failed', r.status === 'failed');
    assert('[8.c.2] reason=load_threw', r.reason === 'load_threw');
    assert('[8.c.3] persisted=true (尝试留痕)', r.persisted === true);
    assert(
      '[8.c.4] upsert metadata 含 error',
      ds.lastUpsert != null && (ds.lastUpsert.metadata as Record<string, unknown>).error === 'boom-trades'
    );
  }
  {
    // (d) upsert 返 ok=false → failed + persisted=false
    const ds = makeFakeDS({
      trades: [makeTrade()],
      strategies: [makeStrategy()],
      upsertResult: { ok: false, reason: 'unique_conflict' },
    });
    const r = await matchForUser(4, { period_end: '2026-06-30', data_source: ds });
    assert('[8.d.1] status=failed', r.status === 'failed');
    assert('[8.d.2] reason=unique_conflict 透传', r.reason === 'unique_conflict');
    assert('[8.d.3] persisted=false', r.persisted === false);
  }
  {
    // (e) upsert throw → failed reason=upsert_threw
    const ds = makeFakeDS({
      trades: [makeTrade()],
      strategies: [makeStrategy()],
      upsertThrows: true,
    });
    const r = await matchForUser(5, { period_end: '2026-06-30', data_source: ds });
    assert('[8.e.1] status=failed', r.status === 'failed');
    assert('[8.e.2] reason=upsert_threw', r.reason === 'upsert_threw');
    assert('[8.e.3] persisted=false', r.persisted === false);
  }
  {
    // (f) cron_run_id 流入 metadata
    const ds = makeFakeDS({ trades: [makeTrade()], strategies: [makeStrategy()] });
    await matchForUser(6, {
      period_end: '2026-06-30',
      data_source: ds,
      cron_run_id: 'run-abc-123',
    });
    assert(
      '[8.f.1] metadata.cron_run_id 透传',
      ds.lastUpsert != null && (ds.lastUpsert.metadata as Record<string, unknown>).cron_run_id === 'run-abc-123'
    );
  }
  {
    // (g) disabled 策略被过滤
    const ds = makeFakeDS({
      trades: [makeTrade()],
      strategies: [
        makeStrategy({ strategy_key: 'A', action: 'enabled' }),
        makeStrategy({ strategy_key: 'B', action: 'disabled' }),
      ],
    });
    const r = await matchForUser(7, { period_end: '2026-06-30', data_source: ds });
    assert('[8.g.1] disabled 被过滤, 仅 1 个 strategy', r.strategies.length === 1 && r.strategies[0].strategy_key === 'A');
  }
  {
    // 自定义 lookback_days 流入 metadata + period_start
    const ds = makeFakeDS({ trades: [makeTrade()], strategies: [makeStrategy()] });
    const r = await matchForUser(8, {
      period_end: '2026-06-30',
      data_source: ds,
      lookback_days: 30,
    });
    assert('[8.h.1] 自定义 lookback period_start 对应', ds.lastUpsert != null && ds.lastUpsert.lookback_days === 30);
    assert('[8.h.2] period_start = 2026-06-01', ds.lastUpsert != null && ds.lastUpsert.period_start === '2026-06-01');
    assert('[8.h.3] r.status 仍 ok', r.status === 'ok');
  }

  // ---- [9] PRODUCTION DataSource factory 不抛 ------------------------------
  {
    try {
      const ds = createProductionPersonalityStrategyMatcherDataSource();
      assert(
        '[9.1] PRODUCTION factory 返 5 个方法',
        typeof ds.loadTrades === 'function' &&
          typeof ds.loadPositions === 'function' &&
          typeof ds.loadActiveStrategies === 'function' &&
          typeof ds.loadDailyPnl === 'function' &&
          typeof ds.upsertPersonalityMatchReport === 'function'
      );
    } catch (e) {
      assert('[9.1] PRODUCTION factory 不抛', false, String(e));
    }
  }

  // ---- [10] META-GUARD fs+regex --------------------------------------------
  {
    const modelPath = join(__dirname, '../../src/models/PersonalityStrategyMatchReport.ts');
    const upPath = join(
      __dirname,
      '../../scripts/migrations/2026-06-20-personality-strategy-match-reports.sql'
    );
    const downPath = join(
      __dirname,
      '../../scripts/migrations/2026-06-20-personality-strategy-match-reports-rollback.sql'
    );
    const modelSrc = readFileSync(modelPath, 'utf8');
    const upSrc = readFileSync(upPath, 'utf8');
    const downSrc = readFileSync(downPath, 'utf8');
    // model
    assert(
      '[10.1] model tableName personality_strategy_match_reports',
      /tableName:\s*'personality_strategy_match_reports'/.test(modelSrc)
    );
    assert(
      '[10.2] model UNIQUE (user_id, period_end)',
      /unique:\s*true/.test(modelSrc) &&
        /personality_strategy_match_reports_user_period_uniq/.test(modelSrc)
    );
    assert('[10.3] model 含 personality JSONB', /declare personality/.test(modelSrc));
    assert('[10.4] model 含 strategies JSONB', /declare strategies/.test(modelSrc));
    assert('[10.5] model 含 matches JSONB', /declare matches/.test(modelSrc));
    assert('[10.6] model 含 summary TEXT', /declare summary:\s*string/.test(modelSrc));
    assert(
      '[10.7] model status 三态注释 (ok/skipped/failed)',
      /ok/.test(modelSrc) && /skipped/.test(modelSrc) && /failed/.test(modelSrc)
    );
    assert(
      '[10.8] model reason nullable',
      /declare reason:\s*string \| null/.test(modelSrc)
    );
    // migration up
    assert(
      '[10.9] up 含 CREATE TABLE IF NOT EXISTS',
      /CREATE TABLE IF NOT EXISTS personality_strategy_match_reports/.test(upSrc)
    );
    assert(
      '[10.10] up 含 UNIQUE INDEX user_period_uniq',
      /UNIQUE INDEX IF NOT EXISTS personality_strategy_match_reports_user_period_uniq/.test(upSrc)
    );
    assert('[10.11] up 含 BEGIN/COMMIT', /BEGIN;[\s\S]*COMMIT;/.test(upSrc));
    assert(
      '[10.12] up 默认值安全态',
      /status\s+VARCHAR\(20\)\s+NOT NULL DEFAULT\s+'ok'/.test(upSrc) &&
        /source\s+VARCHAR\(20\)\s+NOT NULL DEFAULT\s+'heuristic'/.test(upSrc) &&
        /lookback_days\s+INTEGER\s+NOT NULL DEFAULT 90/.test(upSrc) &&
        /personality\s+JSONB\s+NOT NULL DEFAULT '\{\}'::jsonb/.test(upSrc)
    );
    // migration down
    assert(
      '[10.13] down 含 DROP TABLE IF EXISTS',
      /DROP TABLE IF EXISTS personality_strategy_match_reports/.test(downSrc)
    );
    assert(
      '[10.14] down 含 DROP INDEX IF EXISTS user_period_uniq',
      /DROP INDEX IF EXISTS personality_strategy_match_reports_user_period_uniq/.test(downSrc)
    );
    // database.ts 已注册 model
    const dbPath = join(__dirname, '../../src/config/database.ts');
    const dbSrc = readFileSync(dbPath, 'utf8');
    assert(
      '[10.15] database.ts import + register PersonalityStrategyMatchReport',
      /import\s*\{\s*PersonalityStrategyMatchReport\s*\}/.test(dbSrc) &&
        /\bPersonalityStrategyMatchReport\b/.test(dbSrc.split('models:')[1] || '')
    );
    // models/index.ts re-export
    const indexPath = join(__dirname, '../../src/models/index.ts');
    const indexSrc = readFileSync(indexPath, 'utf8');
    assert(
      '[10.16] models/index.ts re-export PersonalityStrategyMatchReport',
      /export \* from '\.\/PersonalityStrategyMatchReport'/.test(indexSrc)
    );
  }

  // ---- summary -------------------------------------------------------------
  console.log(`\n[personality-strategy-matcher.test] ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('TEST RUNNER THREW', err);
  process.exit(1);
});
