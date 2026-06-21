/**
 * ErrorPatternAggregator 单元测试 (US-092 [PM-021]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/postmortem/error-pattern-aggregator.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 / 枚举 sanity (LOOKBACK=90 / SUMMARY_MAX=500 / MIN_DATA_DAYS / 枚举 frozen)
 *   [2] pure helpers — date math (computePeriodStart / classifyDataCompleteness / isoWeekKey / classifyTrending)
 *   [3] aggregateBiasPatterns — 频次降序 / weeks_active / sample_trades / trending up|down|flat
 *   [4] aggregateOutcomePatterns — total_loss 升序 / worst_examples cap / pnl_pct 平均
 *   [5] aggregateAttributionPatterns — 6 维 breakdown + worst_day + sign_consistency + 排序
 *   [6] extractDimensionContrib — industry / factor / 同名字段三路 + NaN/null 安全
 *   [7] buildTopFindings — 三类合并 + score 排序 + cap ≤ 5
 *   [8] buildSummaryStats — win_rate / avg_pnl_pct / data_completeness
 *   [9] buildHeuristicSummary — ≤ MAX 字 + 含日期 + 空数据降级 + 截断 …
 *   [10] aggregateForUser — AC 主验收 (PRD US-092 "周日生成"):
 *        (a) happy → status=ok + persisted=true (b) sparse → skipped + 留痕
 *        (c) load throw → failed + 留痕 (d) upsert 失败 → failed + persisted=false
 *        (e) cron_run_id 流入 metadata (f) lookback_days override
 *   [11] PRODUCTION DataSource factory — 不抛 (lazy require)
 *   [12] META-GUARD fs+regex (model + migration up + migration down)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_LOOKBACK_DAYS,
  ERROR_PATTERN_SUMMARY_MAX_CHARS,
  MIN_DATA_DAYS,
  DATA_COMPLETENESS_FULL_DAYS,
  DATA_COMPLETENESS_PARTIAL_DAYS,
  TOP_FINDINGS_MAX,
  WORST_EXAMPLES_MAX,
  SAMPLE_TRADES_MAX,
  TRENDING_UP_RATIO,
  TRENDING_DOWN_RATIO,
  ERROR_PATTERN_SOURCE,
  ERROR_PATTERN_STATUS,
  DATA_COMPLETENESS,
  computePeriodStart,
  classifyDataCompleteness,
  isoWeekKey,
  classifyTrending,
  aggregateBiasPatterns,
  aggregateOutcomePatterns,
  aggregateAttributionPatterns,
  extractDimensionContrib,
  buildTopFindings,
  buildSummaryStats,
  buildHeuristicSummary,
  aggregateForUser,
  AttributionDailyRecord,
  ErrorPatternAggregatorDataSource,
  ErrorPatternUpsertRow,
} from '../../src/services/postmortem/ErrorPatternAggregator';

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

function makeRec(overrides: Partial<AttributionDailyRecord> = {}): AttributionDailyRecord {
  return {
    date: '2026-06-19',
    total_pnl: 100,
    total_pnl_pct: 0.5,
    trade_count: 3,
    bias_findings: [],
    breakdown: {},
    best_trades: [],
    worst_trades: [],
    ...overrides,
  };
}

(async () => {
  // ---- [1] 常量 sanity ------------------------------------------------------
  {
    assert('[1.1] LOOKBACK_DAYS = 90 (PRD AC)', DEFAULT_LOOKBACK_DAYS === 90);
    assert('[1.2] SUMMARY_MAX = 500', ERROR_PATTERN_SUMMARY_MAX_CHARS === 500);
    assert('[1.3] MIN_DATA_DAYS > 0', MIN_DATA_DAYS > 0 && MIN_DATA_DAYS < DEFAULT_LOOKBACK_DAYS);
    assert('[1.4] FULL > PARTIAL', DATA_COMPLETENESS_FULL_DAYS > DATA_COMPLETENESS_PARTIAL_DAYS);
    assert('[1.5] cap 数', TOP_FINDINGS_MAX > 0 && WORST_EXAMPLES_MAX > 0 && SAMPLE_TRADES_MAX > 0);
    assert('[1.6] trending ratio sanity', TRENDING_UP_RATIO > 1 && TRENDING_DOWN_RATIO < 1);
    assert(
      '[1.7] SOURCE 枚举三态',
      ERROR_PATTERN_SOURCE.HEURISTIC === 'heuristic' &&
        ERROR_PATTERN_SOURCE.LLM === 'llm' &&
        ERROR_PATTERN_SOURCE.MANUAL === 'manual'
    );
    assert(
      '[1.8] STATUS 枚举三态',
      ERROR_PATTERN_STATUS.OK === 'ok' &&
        ERROR_PATTERN_STATUS.SKIPPED === 'skipped' &&
        ERROR_PATTERN_STATUS.FAILED === 'failed'
    );
    assert(
      '[1.9] DATA_COMPLETENESS 三档',
      DATA_COMPLETENESS.FULL === 'full' &&
        DATA_COMPLETENESS.PARTIAL === 'partial' &&
        DATA_COMPLETENESS.SPARSE === 'sparse'
    );
    assert('[1.10] SOURCE frozen', Object.isFrozen(ERROR_PATTERN_SOURCE));
    assert('[1.11] STATUS frozen', Object.isFrozen(ERROR_PATTERN_STATUS));
    assert('[1.12] DATA_COMPLETENESS frozen', Object.isFrozen(DATA_COMPLETENESS));
  }

  // ---- [2] date math --------------------------------------------------------
  {
    // 90 天窗口含 period_end 当天 → period_start = end - 89 天
    assert(
      '[2.1] computePeriodStart 90 天',
      computePeriodStart('2026-06-30', 90) === '2026-04-02'
    );
    assert(
      '[2.2] computePeriodStart 1 天 → 同日',
      computePeriodStart('2026-06-30', 1) === '2026-06-30'
    );
    assert(
      '[2.3] computePeriodStart 非法 end → 返同串兜底',
      computePeriodStart('not-a-date', 90) === 'not-a-date'
    );
    assert(
      '[2.4] computePeriodStart lookback<=0 → fallback DEFAULT',
      computePeriodStart('2026-06-30', 0) === computePeriodStart('2026-06-30', DEFAULT_LOOKBACK_DAYS)
    );
    assert(
      '[2.5] computePeriodStart 跨月跨年',
      computePeriodStart('2026-01-05', 10) === '2025-12-27'
    );
  }
  {
    assert('[2.6] classifyDataCompleteness FULL ≥ 60', classifyDataCompleteness(60) === 'full');
    assert('[2.7] classifyDataCompleteness 59 → PARTIAL', classifyDataCompleteness(59) === 'partial');
    assert('[2.8] classifyDataCompleteness PARTIAL ≥ 30', classifyDataCompleteness(30) === 'partial');
    assert('[2.9] classifyDataCompleteness 29 → SPARSE', classifyDataCompleteness(29) === 'sparse');
    assert('[2.10] classifyDataCompleteness 0 → SPARSE', classifyDataCompleteness(0) === 'sparse');
  }
  {
    // isoWeekKey 形如 YYYY-Www
    const k = isoWeekKey('2026-06-19');
    assert('[2.11] isoWeekKey 形态', /^\d{4}-W\d{2}$/.test(k), k);
    assert('[2.12] isoWeekKey 同周同 key', isoWeekKey('2026-06-15') === isoWeekKey('2026-06-19'));
    assert(
      '[2.13] isoWeekKey 跨周不同 key',
      isoWeekKey('2026-06-15') !== isoWeekKey('2026-06-08')
    );
    assert('[2.14] isoWeekKey 非法返原值', isoWeekKey('bad') === 'bad');
  }
  {
    // classifyTrending — recent rate / earlier rate
    assert(
      '[2.15] earlier=0 + recent>0 → up',
      classifyTrending(3, 0, 30) === 'up'
    );
    assert('[2.16] 全 0 → flat', classifyTrending(0, 0, 30) === 'flat');
    // recent_days = ceil(30/3)=10, earlier_days=20
    // recent_rate=4/10=0.4, earlier_rate=2/20=0.1 → ratio=4 ≥ TRENDING_UP_RATIO=1.5 → up
    assert('[2.17] ratio ≥ 1.5 → up', classifyTrending(4, 2, 30) === 'up');
    // recent_rate=1/10=0.1, earlier_rate=4/20=0.2 → ratio=0.5 ≤ TRENDING_DOWN_RATIO=0.5 → down
    assert('[2.18] ratio ≤ 0.5 → down', classifyTrending(1, 4, 30) === 'down');
    // recent_rate=1/10=0.1, earlier_rate=2/20=0.1 → ratio=1 → flat
    assert('[2.19] ratio=1 → flat', classifyTrending(1, 2, 30) === 'flat');
    assert('[2.20] totalDays<=0 → flat', classifyTrending(5, 5, 0) === 'flat');
  }

  // ---- [3] aggregateBiasPatterns -------------------------------------------
  {
    const recs: AttributionDailyRecord[] = [];
    // 30 天数据, 前 20 天 chase_high 命中 4 次, 后 10 天 chase_high 命中 6 次 (up)
    for (let i = 0; i < 30; i++) {
      const day = `2026-06-${String(i + 1).padStart(2, '0')}`;
      const findings = [];
      if (i < 20 && i % 5 === 0) {
        findings.push({ bias_type: 'chase_high', severity: 0.7, related_trades: ['600519'] });
      }
      if (i >= 20) {
        findings.push({
          bias_type: 'chase_high',
          severity: 0.5,
          related_trades: [`60000${i % 5}`],
        });
      }
      if (i === 5) {
        findings.push({ bias_type: 'hold_loss', severity: 0.4, related_trades: [] });
      }
      recs.push(makeRec({ date: day, bias_findings: findings }));
    }
    const out = aggregateBiasPatterns(recs);
    assert('[3.1] 两类 bias 全识别', out.length === 2);
    const chase = out.find(b => b.bias_type === 'chase_high');
    const hold = out.find(b => b.bias_type === 'hold_loss');
    assert('[3.2] chase_high 频次最高', out[0].bias_type === 'chase_high', String(out[0]));
    assert('[3.3] chase_high total_count', chase != null && chase.total_count === 14);
    assert(
      '[3.4] chase_high avg_severity ≈ 0.557',
      chase != null && Math.abs(chase.avg_severity - (4 * 0.7 + 10 * 0.5) / 14) < 1e-9
    );
    assert(
      '[3.5] chase_high trending up',
      chase != null && chase.trending === 'up',
      chase?.trending
    );
    assert(
      '[3.6] sample_trades ≤ cap',
      chase != null && chase.sample_trades.length <= SAMPLE_TRADES_MAX
    );
    assert(
      '[3.7] hold_loss total_count=1',
      hold != null && hold.total_count === 1 && hold.weeks_active >= 1
    );
  }
  {
    // 空 + 缺 bias_type 跳过
    const recs = [
      makeRec({ bias_findings: [{ severity: 0.5 }, { bias_type: '', severity: 0.5 }] }),
    ];
    const out = aggregateBiasPatterns(recs);
    assert('[3.8] 缺 bias_type 不入', out.length === 0);
  }

  // ---- [4] aggregateOutcomePatterns ----------------------------------------
  {
    const recs = [
      makeRec({
        date: '2026-06-01',
        worst_trades: [
          { symbol: '600519', pnl: -1000, pnl_pct: -0.05 },
          { symbol: '000858', pnl: -500, pnl_pct: -0.03 },
        ],
      }),
      makeRec({
        date: '2026-06-02',
        worst_trades: [
          { symbol: '300750', pnl: -2000, pnl_pct: -0.08 },
          { symbol: '600036', pnl: -100, pnl_pct: -0.01 },
        ],
      }),
    ];
    const out = aggregateOutcomePatterns(recs);
    assert('[4.1] 单一 outcome_type loss_trade', out.length === 1);
    const lt = out[0];
    assert('[4.2] total_count=4', lt.total_count === 4);
    assert('[4.3] total_loss=-3600', Math.abs(lt.total_loss - -3600) < 1e-9);
    assert(
      '[4.4] avg_loss_pct ≈ -0.0425',
      Math.abs(lt.avg_loss_pct - (-0.05 + -0.03 + -0.08 + -0.01) / 4) < 1e-9
    );
    assert('[4.5] worst_examples cap', lt.worst_examples.length <= WORST_EXAMPLES_MAX);
    assert('[4.6] worst_examples 最负在前', lt.worst_examples[0].symbol === '300750');
  }
  {
    // 多 outcome_type 显式区分
    const recs = [
      makeRec({
        worst_trades: [
          { symbol: 'A', pnl: -100, pnl_pct: -0.01, outcome_type: 'stop_loss_late' },
          { symbol: 'B', pnl: -50, pnl_pct: -0.02, outcome_type: 'chase_high' },
        ],
      }),
    ];
    const out = aggregateOutcomePatterns(recs);
    assert('[4.7] 两类 outcome_type', out.length === 2);
    assert('[4.8] 排序 最负 (-100) 在前', out[0].outcome_type === 'stop_loss_late');
  }
  {
    // 空 worst_trades 不产生 outcome
    const recs = [makeRec({ worst_trades: [] })];
    const out = aggregateOutcomePatterns(recs);
    assert('[4.9] 空 worst → 空 outcome', out.length === 0);
  }

  // ---- [5] aggregateAttributionPatterns -------------------------------------
  {
    const recs = [
      makeRec({
        date: '2026-06-01',
        breakdown: {
          industry_contrib: [{ pnl: 100 }, { pnl: -50 }], // sum=50
          timing_contrib: 30,
          sizing_contrib: -20,
          selection_contrib: 10,
          factor_contrib_total: -200,
          execution_cost_contrib: -5,
          residual: 0,
        },
      }),
      makeRec({
        date: '2026-06-02',
        breakdown: {
          industry_contrib: [{ pnl: -500 }],
          timing_contrib: 10,
          sizing_contrib: 5,
          selection_contrib: -8,
          factor_contrib_total: 30,
          execution_cost_contrib: -3,
          residual: 1,
        },
      }),
    ];
    const out = aggregateAttributionPatterns(recs);
    assert('[5.1] 7 个 dimension 全在', out.length === 7);
    // 排序按 |total_contrib| 降序 → industry total=-450 / factor total=-170 / timing=40
    assert('[5.2] industry 排第一', out[0].dimension === 'industry');
    const industry = out.find(d => d.dimension === 'industry')!;
    assert('[5.3] industry total=-450', Math.abs(industry.total_contrib - -450) < 1e-9);
    assert('[5.4] industry avg=-225', Math.abs(industry.avg_per_day - -225) < 1e-9);
    assert(
      '[5.5] industry worst_day=2026-06-02 (-500)',
      industry.worst_day === '2026-06-02' && industry.worst_day_contrib === -500
    );
    // day 1 industry sum=50 (正), day 2=-500 (负) → 1/2=0.5
    assert(
      '[5.6] industry sign_consistency=0.5 (一正一负)',
      industry.sign_consistency === 0.5
    );
    const factor = out.find(d => d.dimension === 'factor')!;
    assert('[5.7] factor total=-170', Math.abs(factor.total_contrib - -170) < 1e-9);
    const selection = out.find(d => d.dimension === 'selection')!;
    assert(
      '[5.8] selection sign_consistency=0.5 (一天正一天负)',
      selection.sign_consistency === 0.5
    );
  }

  // ---- [6] extractDimensionContrib -----------------------------------------
  {
    assert(
      '[6.1] industry sum',
      extractDimensionContrib({ industry_contrib: [{ pnl: 5 }, { pnl: 3 }] }, 'industry') === 8
    );
    assert(
      '[6.2] industry 非数组 → 0',
      extractDimensionContrib({ industry_contrib: 'bad' }, 'industry') === 0
    );
    assert('[6.3] industry 缺字段 → 0', extractDimensionContrib({}, 'industry') === 0);
    assert(
      '[6.4] factor total 优先',
      extractDimensionContrib({ factor_contrib_total: 10, factor_contrib: [{ pnl: 999 }] }, 'factor') === 10
    );
    assert(
      '[6.5] factor 缺 total 走 sum',
      extractDimensionContrib({ factor_contrib: [{ pnl: 2 }, { pnl: 3 }] }, 'factor') === 5
    );
    assert(
      '[6.6] timing 同名 _contrib',
      extractDimensionContrib({ timing_contrib: 7 }, 'timing') === 7
    );
    assert(
      '[6.7] residual 兜底 dimension 同名字段',
      extractDimensionContrib({ residual: 9 }, 'residual') === 9
    );
    assert(
      '[6.8] NaN / null 安全',
      extractDimensionContrib({ timing_contrib: NaN }, 'timing') === 0 &&
        extractDimensionContrib({ timing_contrib: null }, 'timing') === 0
    );
  }

  // ---- [7] buildTopFindings -------------------------------------------------
  {
    const bias = [
      { bias_type: 'chase_high', total_count: 10, avg_severity: 0.8, weeks_active: 8, trending: 'up' as const, sample_trades: [] },
      { bias_type: 'hold_loss', total_count: 2, avg_severity: 0.4, weeks_active: 2, trending: 'flat' as const, sample_trades: [] },
    ];
    const outcome = [
      { outcome_type: 'loss_trade', total_count: 5, avg_loss_pct: -0.05, total_loss: -5000, worst_examples: [] },
    ];
    const attribution = [
      {
        dimension: 'industry',
        total_contrib: -3000,
        avg_per_day: -300,
        worst_day: '2026-06-19',
        worst_day_contrib: -800,
        sign_consistency: 0.7,
      },
      {
        dimension: 'timing',
        total_contrib: 500,
        avg_per_day: 50,
        worst_day: '',
        worst_day_contrib: 0,
        sign_consistency: 0,
      },
    ];
    const t = buildTopFindings(bias, outcome, attribution);
    assert('[7.1] top_findings cap', t.length <= TOP_FINDINGS_MAX);
    assert('[7.2] 排序 score 降序', t.every((f, i, arr) => i === 0 || arr[i - 1].score >= f.score));
    // outcome 累积亏损 5000 > attribution 3000 > bias 10*0.8=8
    assert('[7.3] outcome 在 attribution 前', t[0].category === 'outcome' && t[1].category === 'attribution');
    // 正贡献 attribution timing 应被过滤
    assert('[7.4] 正 attribution 不入 top', t.every(f => !(f.category === 'attribution' && f.key === 'timing')));
    assert('[7.5] detail 含 key', t[0].detail.includes('loss_trade'));
  }
  {
    // 全空 → 空
    const t = buildTopFindings([], [], []);
    assert('[7.6] 全空 → []', t.length === 0);
  }

  // ---- [8] buildSummaryStats ------------------------------------------------
  {
    const recs = [
      makeRec({ date: '2026-06-01', total_pnl: 100, total_pnl_pct: 0.5 }),
      makeRec({ date: '2026-06-02', total_pnl: -200, total_pnl_pct: -1 }),
      makeRec({ date: '2026-06-03', total_pnl: 300, total_pnl_pct: null }),
    ];
    const bias = [
      { bias_type: 'a', total_count: 4, avg_severity: 0, weeks_active: 0, trending: 'flat' as const, sample_trades: [] },
      { bias_type: 'b', total_count: 1, avg_severity: 0, weeks_active: 0, trending: 'flat' as const, sample_trades: [] },
    ];
    const out = [
      { outcome_type: 'loss_trade', total_count: 3, avg_loss_pct: 0, total_loss: 0, worst_examples: [] },
    ];
    const stats = buildSummaryStats(recs, bias, out);
    assert('[8.1] total_attribution_days=3', stats.total_attribution_days === 3);
    assert('[8.2] win_rate=2/3', Math.abs(stats.win_rate - 2 / 3) < 1e-9);
    // null 的 pct 不计入平均
    assert('[8.3] avg_pnl_pct=(0.5-1)/2=-0.25', Math.abs(stats.avg_pnl_pct - -0.25) < 1e-9);
    assert('[8.4] total_bias_count=5', stats.total_bias_count === 5);
    assert('[8.5] total_outcome_count=3', stats.total_outcome_count === 3);
    assert('[8.6] sparse', stats.data_completeness === 'sparse');
  }
  {
    const stats = buildSummaryStats([], [], []);
    assert('[8.7] 全空 → 默认值', stats.total_attribution_days === 0 && stats.win_rate === 0 && stats.avg_pnl_pct === 0);
  }

  // ---- [9] buildHeuristicSummary --------------------------------------------
  {
    const patterns = {
      bias_patterns: [
        { bias_type: 'chase_high', total_count: 10, avg_severity: 0.7, weeks_active: 5, trending: 'up' as const, sample_trades: [] },
      ],
      outcome_patterns: [
        { outcome_type: 'loss_trade', total_count: 4, avg_loss_pct: -0.03, total_loss: -2500, worst_examples: [] },
      ],
      attribution_patterns: [
        {
          dimension: 'industry',
          total_contrib: -1500,
          avg_per_day: -50,
          worst_day: '2026-06-19',
          worst_day_contrib: -800,
          sign_consistency: 0.6,
        },
      ],
      top_findings: [
        { category: 'outcome' as const, key: 'loss_trade', score: 2500, detail: 'loss_trade 命中 4 笔' },
      ],
    };
    const stats = buildSummaryStats(
      [
        makeRec({ date: '2026-06-01', total_pnl: 100, total_pnl_pct: 0.5 }),
        makeRec({ date: '2026-06-02', total_pnl: 200, total_pnl_pct: 1 }),
      ],
      patterns.bias_patterns,
      patterns.outcome_patterns
    );
    const text = buildHeuristicSummary(patterns, stats, '2026-04-01', '2026-06-30');
    assert(
      '[9.1] summary ≤ MAX',
      Array.from(text).length <= ERROR_PATTERN_SUMMARY_MAX_CHARS,
      String(Array.from(text).length)
    );
    assert('[9.2] 含起止日期', text.includes('2026-04-01') && text.includes('2026-06-30'));
    assert('[9.3] 含 chase_high', text.includes('chase_high'));
    assert('[9.4] 含 loss_trade', text.includes('loss_trade'));
    assert('[9.5] 含 industry', text.includes('industry'));
    assert('[9.6] 含 top finding', text.includes('重点建议'));
  }
  {
    // 空数据降级
    const empty = {
      bias_patterns: [],
      outcome_patterns: [],
      attribution_patterns: [],
      top_findings: [],
    };
    const stats = buildSummaryStats([], [], []);
    const text = buildHeuristicSummary(empty, stats, '2026-04-01', '2026-06-30');
    assert('[9.7] 空数据降级文案', text.includes('无有效归因数据'));
  }
  {
    // 截断到 MAX
    const bias = Array.from({ length: 50 }, (_, i) => ({
      bias_type: `type_${i}_with_long_name`,
      total_count: 100,
      avg_severity: 0.5,
      weeks_active: 5,
      trending: 'flat' as const,
      sample_trades: [],
    }));
    const patterns = { bias_patterns: bias, outcome_patterns: [], attribution_patterns: [], top_findings: [] };
    const stats = buildSummaryStats(
      Array.from({ length: 30 }, () => makeRec({})),
      bias,
      []
    );
    const text = buildHeuristicSummary(patterns, stats, '2026-04-01', '2026-06-30');
    assert(
      '[9.8] 超 cap 时截到 MAX',
      Array.from(text).length <= ERROR_PATTERN_SUMMARY_MAX_CHARS
    );
  }

  // ---- [10] aggregateForUser AC 主验收 ------------------------------------
  function makeFakeDS(opts: {
    records?: AttributionDailyRecord[];
    loadThrows?: boolean;
    upsertResult?: { ok: boolean; reason?: string; error?: string };
    upsertThrows?: boolean;
  }): ErrorPatternAggregatorDataSource & { lastUpsert?: ErrorPatternUpsertRow } {
    const state: { lastUpsert?: ErrorPatternUpsertRow } = {};
    return {
      async loadAttributionReports() {
        if (opts.loadThrows) throw new Error('boom-load');
        return opts.records ?? [];
      },
      async upsertErrorPatternReport(row) {
        state.lastUpsert = row;
        if (opts.upsertThrows) throw new Error('boom-upsert');
        return opts.upsertResult ?? { ok: true };
      },
      get lastUpsert() {
        return state.lastUpsert;
      },
    } as ErrorPatternAggregatorDataSource & { lastUpsert?: ErrorPatternUpsertRow };
  }

  {
    // (a) happy → ok + persisted=true
    const records: AttributionDailyRecord[] = [];
    for (let i = 0; i < 30; i++) {
      const day = `2026-06-${String(i + 1).padStart(2, '0')}`;
      records.push(
        makeRec({
          date: day,
          total_pnl: i % 2 === 0 ? 100 : -50,
          total_pnl_pct: i % 2 === 0 ? 0.5 : -0.2,
          bias_findings: i % 5 === 0 ? [{ bias_type: 'chase_high', severity: 0.5 }] : [],
          worst_trades: i % 7 === 0 ? [{ symbol: 'X', pnl: -200, pnl_pct: -0.02 }] : [],
          breakdown: { industry_contrib: [{ pnl: -10 }], timing_contrib: 5 },
        })
      );
    }
    const ds = makeFakeDS({ records });
    const r = await aggregateForUser(1, { period_end: '2026-06-30', data_source: ds });
    assert('[10.a.1] status=ok', r.status === 'ok');
    assert('[10.a.2] persisted=true', r.persisted === true);
    assert('[10.a.3] patterns.bias_patterns 非空', r.patterns.bias_patterns.length > 0);
    assert('[10.a.4] summary 非空 + ≤ MAX', r.summary.length > 0 && Array.from(r.summary).length <= ERROR_PATTERN_SUMMARY_MAX_CHARS);
    assert(
      '[10.a.5] upsert row 含 user_id=1 + status=ok',
      ds.lastUpsert != null && ds.lastUpsert.user_id === 1 && ds.lastUpsert.status === 'ok'
    );
    assert(
      '[10.a.6] upsert row 含 period 区间',
      ds.lastUpsert != null && ds.lastUpsert.period_end === '2026-06-30' && ds.lastUpsert.period_start === '2026-04-02'
    );
    assert(
      '[10.a.7] upsert row lookback_days=90',
      ds.lastUpsert != null && ds.lastUpsert.lookback_days === DEFAULT_LOOKBACK_DAYS
    );
    assert(
      '[10.a.8] upsert row source=heuristic',
      ds.lastUpsert != null && ds.lastUpsert.source === 'heuristic'
    );
  }
  {
    // (b) sparse → skipped + 留痕
    const records: AttributionDailyRecord[] = [
      makeRec({ date: '2026-06-29' }),
      makeRec({ date: '2026-06-30' }),
    ];
    const ds = makeFakeDS({ records });
    const r = await aggregateForUser(2, { period_end: '2026-06-30', data_source: ds });
    assert('[10.b.1] status=skipped', r.status === 'skipped');
    assert('[10.b.2] reason=data_too_sparse', r.reason === 'data_too_sparse');
    assert('[10.b.3] persisted=true (留痕)', r.persisted === true);
    assert(
      '[10.b.4] upsert row status=skipped',
      ds.lastUpsert != null && ds.lastUpsert.status === 'skipped'
    );
  }
  {
    // (c) load throw → failed + 留痕
    const ds = makeFakeDS({ loadThrows: true });
    const r = await aggregateForUser(3, { period_end: '2026-06-30', data_source: ds });
    assert('[10.c.1] status=failed', r.status === 'failed');
    assert('[10.c.2] reason=load_threw', r.reason === 'load_threw');
    assert('[10.c.3] persisted=true (尝试留痕)', r.persisted === true);
    assert(
      '[10.c.4] upsert metadata 含 error',
      ds.lastUpsert != null && (ds.lastUpsert.metadata as any).error === 'boom-load'
    );
  }
  {
    // (d) upsert 返 ok=false → failed + persisted=false
    const ds = makeFakeDS({
      records: Array.from({ length: 20 }, (_, i) =>
        makeRec({ date: `2026-06-${String(i + 1).padStart(2, '0')}` })
      ),
      upsertResult: { ok: false, reason: 'duplicate_key' },
    });
    const r = await aggregateForUser(4, { period_end: '2026-06-30', data_source: ds });
    assert('[10.d.1] status=failed', r.status === 'failed');
    assert('[10.d.2] persisted=false', r.persisted === false);
    assert('[10.d.3] reason=duplicate_key', r.reason === 'duplicate_key');
  }
  {
    // (d2) upsert throw → 顶层 catch 兜底
    const ds = makeFakeDS({
      records: Array.from({ length: 20 }, (_, i) =>
        makeRec({ date: `2026-06-${String(i + 1).padStart(2, '0')}` })
      ),
      upsertThrows: true,
    });
    const r = await aggregateForUser(5, { period_end: '2026-06-30', data_source: ds });
    assert('[10.d.4] status=failed (upsert throw)', r.status === 'failed');
    assert('[10.d.5] persisted=false', r.persisted === false);
    assert('[10.d.6] reason=upsert_threw', r.reason === 'upsert_threw');
  }
  {
    // (e) cron_run_id 流入 metadata
    const ds = makeFakeDS({
      records: Array.from({ length: 10 }, (_, i) =>
        makeRec({ date: `2026-06-${String(i + 1).padStart(2, '0')}` })
      ),
    });
    await aggregateForUser(6, {
      period_end: '2026-06-30',
      data_source: ds,
      cron_run_id: 'cron-2026-06-21',
    });
    assert(
      '[10.e.1] metadata.cron_run_id 流入',
      ds.lastUpsert != null && (ds.lastUpsert.metadata as any).cron_run_id === 'cron-2026-06-21'
    );
    assert(
      '[10.e.2] metadata.data_sources_used 含 daily_attribution_report',
      ds.lastUpsert != null &&
        Array.isArray((ds.lastUpsert.metadata as any).data_sources_used) &&
        (ds.lastUpsert.metadata as any).data_sources_used.includes('daily_attribution_report')
    );
    assert(
      '[10.e.3] metadata.attribution_days_loaded=10',
      ds.lastUpsert != null && (ds.lastUpsert.metadata as any).attribution_days_loaded === 10
    );
  }
  {
    // (f) lookback_days override
    const ds = makeFakeDS({
      records: Array.from({ length: 10 }, (_, i) =>
        makeRec({ date: `2026-06-${String(i + 1).padStart(2, '0')}` })
      ),
    });
    await aggregateForUser(7, {
      period_end: '2026-06-30',
      data_source: ds,
      lookback_days: 30,
    });
    assert(
      '[10.f.1] lookback override 流入 row',
      ds.lastUpsert != null && ds.lastUpsert.lookback_days === 30
    );
    assert(
      '[10.f.2] period_start 用 override 算',
      ds.lastUpsert != null && ds.lastUpsert.period_start === '2026-06-01'
    );
  }

  // ---- [11] PRODUCTION DataSource factory ----------------------------------
  {
    // 不抛即可 (DB-less 环境下 production 应内部 try/catch 退化)
    const mod = await import('../../src/services/postmortem/ErrorPatternAggregator');
    const ds = (mod as any).createProductionErrorPatternAggregatorDataSource?.();
    if (ds) {
      try {
        const records = await ds.loadAttributionReports({
          user_id: 99999,
          period_start: '2026-04-01',
          period_end: '2026-06-30',
        });
        assert(
          '[11.1] PRODUCTION loadAttributionReports 不抛 (返数组)',
          Array.isArray(records)
        );
      } catch (e) {
        assert('[11.1] PRODUCTION loadAttributionReports 不抛', false, String(e));
      }
      try {
        const r = await ds.upsertErrorPatternReport({
          user_id: 99999,
          period_start: '2026-04-01',
          period_end: '2026-06-30',
          lookback_days: 90,
          patterns: {},
          summary_stats: {},
          summary: '',
          source: 'heuristic',
          status: 'ok',
          reason: null,
          metadata: {},
          generated_at: new Date(),
        });
        assert(
          '[11.2] PRODUCTION upsert 不抛 (返 envelope)',
          typeof r === 'object' && typeof r.ok === 'boolean'
        );
      } catch (e) {
        assert('[11.2] PRODUCTION upsert 不抛', false, String(e));
      }
    } else {
      // factory 未导出也合规 (本 story 标记 [11] 仅当 factory 存在才严验)
      assert('[11.skip] PRODUCTION factory 缺失 → 跳过', true);
    }
  }

  // ---- [12] META-GUARD fs+regex -------------------------------------------
  {
    const modelPath = join(__dirname, '../../src/models/ErrorPatternReport.ts');
    const upPath = join(
      __dirname,
      '../../scripts/migrations/2026-06-20-error-pattern-reports.sql'
    );
    const downPath = join(
      __dirname,
      '../../scripts/migrations/2026-06-20-error-pattern-reports-rollback.sql'
    );
    const modelSrc = readFileSync(modelPath, 'utf8');
    const upSrc = readFileSync(upPath, 'utf8');
    const downSrc = readFileSync(downPath, 'utf8');
    // model
    assert(
      '[12.1] model 含 tableName error_pattern_reports',
      /tableName:\s*'error_pattern_reports'/.test(modelSrc)
    );
    assert(
      '[12.2] model 含 UNIQUE (user_id, period_end)',
      /unique:\s*true/.test(modelSrc) && /period_end/.test(modelSrc)
    );
    assert('[12.3] model 含 patterns JSONB', /declare patterns/.test(modelSrc));
    assert('[12.4] model 含 summary_stats', /declare summary_stats/.test(modelSrc));
    assert('[12.5] model 含 status (ok/skipped/failed) 注释', /skipped/.test(modelSrc) && /failed/.test(modelSrc));
    assert('[12.6] model 含 lookback_days 默认 90', /lookback_days[\s\S]*defaultValue:\s*90/.test(modelSrc));
    // migration up
    assert('[12.7] up 含 CREATE TABLE IF NOT EXISTS', /CREATE TABLE IF NOT EXISTS error_pattern_reports/.test(upSrc));
    assert('[12.8] up 含 UNIQUE INDEX user_period', /UNIQUE INDEX IF NOT EXISTS error_pattern_reports_user_period_uniq/.test(upSrc));
    assert('[12.9] up 含 BEGIN/COMMIT', /BEGIN;[\s\S]*COMMIT;/.test(upSrc));
    assert(
      '[12.10] up 默认值 priority/status 安全态',
      /status\s+VARCHAR\(20\)\s+NOT NULL DEFAULT\s+'ok'/.test(upSrc) &&
        /source\s+VARCHAR\(20\)\s+NOT NULL DEFAULT\s+'heuristic'/.test(upSrc) &&
        /lookback_days\s+INTEGER\s+NOT NULL DEFAULT 90/.test(upSrc)
    );
    // migration down
    assert(
      '[12.11] down 含 DROP TABLE IF EXISTS',
      /DROP TABLE IF EXISTS error_pattern_reports/.test(downSrc)
    );
    assert(
      '[12.12] down 含 DROP INDEX IF EXISTS user_period',
      /DROP INDEX IF EXISTS error_pattern_reports_user_period_uniq/.test(downSrc)
    );
    // config/database.ts 已注册 model
    const dbPath = join(__dirname, '../../src/config/database.ts');
    const dbSrc = readFileSync(dbPath, 'utf8');
    assert(
      '[12.13] database.ts import ErrorPatternReport',
      /import\s*\{\s*ErrorPatternReport\s*\}/.test(dbSrc) && /\bErrorPatternReport\b/.test(dbSrc.split('models:')[1] || '')
    );
    const indexPath = join(__dirname, '../../src/models/index.ts');
    const indexSrc = readFileSync(indexPath, 'utf8');
    assert(
      '[12.14] models/index.ts re-export ErrorPatternReport',
      /export \* from '\.\/ErrorPatternReport'/.test(indexSrc)
    );
  }

  // ---- summary -------------------------------------------------------------
  console.log(`\n[error-pattern-aggregator.test] ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('TEST RUNNER THREW', err);
  process.exit(1);
});
