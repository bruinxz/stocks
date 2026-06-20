/**
 * ImprovementSuggestionService 单元测试 (US-094 [PM-023]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/postmortem/improvement-suggestion-service.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 / 枚举 sanity (TITLE/BODY MAX + 4 类 category + 4 态 status + 4 类 action.type)
 *   [2] 文本约束 (enforceTitleConstraints / enforceBodyConstraints / describeTrending / computePriority)
 *   [3] builders — bias / outcome / attribution / top 各自 happy + 缺数据降级 + cap
 *   [4] buildSuggestionsFromPatterns — 四类合并 + 负贡献过滤 + 空 patterns 返 [] + 排序保留
 *   [5] generateForUser — 主验收 AC:
 *        (a) happy → ok + persisted_count=N + rows 含四类
 *        (b) no error_pattern → skipped reason=no_error_pattern
 *        (c) patterns 全空 → skipped reason=patterns_empty
 *        (d) load throw → failed reason=load_threw + persisted_count=0
 *        (e) bulkUpsert 返 false → failed reason 透传 + persisted_count=0
 *        (f) bulkUpsert throw → failed reason=bulk_upsert_threw
 *        (g) cron_run_id 流入 metadata + period_end override 流入查询
 *   [6] PRODUCTION DataSource factory — 不抛 (lazy require)
 *   [7] META-GUARD fs+regex (model + migration up + migration down + database.ts + index.ts)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type {
  AttributionPattern,
  BiasPattern,
  ErrorPatterns,
  OutcomePattern,
  TopFinding,
} from '../../src/services/postmortem/ErrorPatternAggregator';
import {
  IMPROVEMENT_TITLE_MAX_CHARS,
  IMPROVEMENT_BODY_MAX_CHARS,
  IMPROVEMENT_CATEGORY,
  IMPROVEMENT_STATUS,
  IMPROVEMENT_SOURCE,
  IMPROVEMENT_ACTION_TYPE,
  IMPROVEMENT_GENERATE_STATUS,
  IMPROVEMENT_PRIORITY_TOP,
  SAMPLE_ITEMS_MAX,
  enforceTitleConstraints,
  enforceBodyConstraints,
  describeTrending,
  computePriority,
  buildBiasSuggestion,
  buildOutcomeSuggestion,
  buildAttributionSuggestion,
  buildTopSuggestion,
  buildSuggestionsFromPatterns,
  generateForUser,
  createProductionImprovementSuggestionDataSource,
  ErrorPatternSnapshot,
  ImprovementSuggestionDataSource,
  ImprovementSuggestionUpsertRow,
} from '../../src/services/postmortem/ImprovementSuggestionService';

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

function makeBias(overrides: Partial<BiasPattern> = {}): BiasPattern {
  return {
    bias_type: 'chase_high',
    total_count: 12,
    avg_severity: 0.7,
    weeks_active: 6,
    trending: 'up',
    sample_trades: ['600519', '000725', '000333'],
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<OutcomePattern> = {}): OutcomePattern {
  return {
    outcome_type: 'loss_trade',
    total_count: 18,
    avg_loss_pct: -3.5,
    total_loss: -8200,
    worst_examples: [
      { symbol: '600519', date: '2026-05-12', loss: -3200 },
      { symbol: '000725', date: '2026-05-20', loss: -2500 },
    ],
    ...overrides,
  };
}

function makeAttr(overrides: Partial<AttributionPattern> = {}): AttributionPattern {
  return {
    dimension: 'execution_cost',
    total_contrib: -1800,
    avg_per_day: -20,
    worst_day: '2026-05-15',
    worst_day_contrib: -350,
    sign_consistency: 0.6,
    ...overrides,
  };
}

function makeTop(overrides: Partial<TopFinding> = {}): TopFinding {
  return {
    category: 'bias',
    key: 'chase_high',
    score: 8.4,
    detail: 'chase_high 90 天命中 12 次, 平均严重度 0.70, 趋势 up',
    ...overrides,
  };
}

function makeSnapshot(patternsOverride: Partial<ErrorPatterns> = {}): ErrorPatternSnapshot {
  const patterns: ErrorPatterns = {
    bias_patterns: [makeBias(), makeBias({ bias_type: 'fomo', total_count: 5 })],
    outcome_patterns: [makeOutcome()],
    attribution_patterns: [
      makeAttr(),
      makeAttr({ dimension: 'industry', total_contrib: 500 }), // 正贡献 — 应过滤
      makeAttr({ dimension: 'timing', total_contrib: -900 }),
    ],
    top_findings: [makeTop()],
    ...patternsOverride,
  };
  return {
    id: 4242,
    user_id: 7,
    period_start: '2026-03-22',
    period_end: '2026-06-19',
    lookback_days: 90,
    patterns,
    summary: 'heuristic summary text',
    status: 'ok',
    generated_at: new Date('2026-06-20T02:00:00Z'),
  };
}

(async () => {
  // ---- [1] 常量 sanity ------------------------------------------------------
  {
    assert('[1.1] TITLE_MAX > 0', IMPROVEMENT_TITLE_MAX_CHARS > 0);
    assert('[1.2] BODY_MAX > TITLE_MAX', IMPROVEMENT_BODY_MAX_CHARS > IMPROVEMENT_TITLE_MAX_CHARS);
    assert('[1.3] BODY_MAX = 500', IMPROVEMENT_BODY_MAX_CHARS === 500);
    assert(
      '[1.4] CATEGORY 四类',
      IMPROVEMENT_CATEGORY.BIAS === 'bias' &&
        IMPROVEMENT_CATEGORY.OUTCOME === 'outcome' &&
        IMPROVEMENT_CATEGORY.ATTRIBUTION === 'attribution' &&
        IMPROVEMENT_CATEGORY.TOP === 'top'
    );
    assert(
      '[1.5] STATUS 四态',
      IMPROVEMENT_STATUS.OPEN === 'open' &&
        IMPROVEMENT_STATUS.APPLIED === 'applied' &&
        IMPROVEMENT_STATUS.DISMISSED === 'dismissed' &&
        IMPROVEMENT_STATUS.EXPIRED === 'expired'
    );
    assert(
      '[1.6] SOURCE 三态',
      IMPROVEMENT_SOURCE.HEURISTIC === 'heuristic' &&
        IMPROVEMENT_SOURCE.LLM === 'llm' &&
        IMPROVEMENT_SOURCE.MANUAL === 'manual'
    );
    assert(
      '[1.7] ACTION_TYPE 四类',
      IMPROVEMENT_ACTION_TYPE.NOOP === 'noop' &&
        IMPROVEMENT_ACTION_TYPE.TUNE_RISK_PARAM === 'tune_risk_param' &&
        IMPROVEMENT_ACTION_TYPE.ENABLE_KILL_SWITCH === 'enable_kill_switch' &&
        IMPROVEMENT_ACTION_TYPE.OPEN_WORKSPACE_TAB === 'open_workspace_tab'
    );
    assert(
      '[1.8] GENERATE_STATUS 三态',
      IMPROVEMENT_GENERATE_STATUS.OK === 'ok' &&
        IMPROVEMENT_GENERATE_STATUS.SKIPPED === 'skipped' &&
        IMPROVEMENT_GENERATE_STATUS.FAILED === 'failed'
    );
    assert('[1.9] PRIORITY_TOP = 100', IMPROVEMENT_PRIORITY_TOP === 100);
    assert('[1.10] SAMPLE_ITEMS_MAX > 0', SAMPLE_ITEMS_MAX > 0);
    // frozen 守护
    let frozen = true;
    try {
      // @ts-expect-error mutate frozen for test
      IMPROVEMENT_CATEGORY.BIAS = 'mutated';
      if ((IMPROVEMENT_CATEGORY as Record<string, string>).BIAS !== 'bias') frozen = false;
    } catch {
      /* frozen 严格模式 throw 也算 ok */
    }
    assert('[1.11] CATEGORY Object.freeze', frozen);
  }

  // ---- [2] 文本约束 + describeTrending + computePriority ---------------------
  {
    assert('[2.1] enforceTitle 短 string 原样', enforceTitleConstraints('短标题') === '短标题');
    const long = 'A'.repeat(IMPROVEMENT_TITLE_MAX_CHARS + 30);
    const cut = enforceTitleConstraints(long);
    assert(
      '[2.2] enforceTitle 长 string 截断到 MAX 且 … 结尾',
      Array.from(cut).length === IMPROVEMENT_TITLE_MAX_CHARS && cut.endsWith('…')
    );
    assert(
      '[2.3] enforceTitle 合并多空白',
      enforceTitleConstraints('A\n\n  B\t  C') === 'A B C'
    );
    assert('[2.4] enforceBody 短 string', enforceBodyConstraints('hello') === 'hello');
    const longBody = '中'.repeat(IMPROVEMENT_BODY_MAX_CHARS + 50);
    const cutBody = enforceBodyConstraints(longBody);
    assert(
      '[2.5] enforceBody 长字符串截断到 BODY_MAX',
      Array.from(cutBody).length === IMPROVEMENT_BODY_MAX_CHARS && cutBody.endsWith('…')
    );
    assert(
      '[2.6] describeTrending',
      describeTrending('up') === '上升' &&
        describeTrending('down') === '下降' &&
        describeTrending('flat') === '稳定'
    );
    // computePriority
    assert('[2.7] computePriority total=0 → 0', computePriority(0, 0, 90) === 0);
    assert('[2.8] computePriority rank=0 → anchor', computePriority(0, 5, 90) === 90);
    assert(
      '[2.9] computePriority rank=last → 1',
      computePriority(4, 5, 90) === 1
    );
    assert(
      '[2.10] computePriority single → anchor',
      computePriority(0, 1, 80) === 80
    );
    assert('[2.11] computePriority 不超 cap', computePriority(0, 1, 200) === IMPROVEMENT_PRIORITY_TOP);
    assert('[2.12] computePriority 不为负 (rank > total 边界)', computePriority(200, 100, 50) === 0);
  }

  // ---- [3] builders ---------------------------------------------------------
  {
    const ctx = {
      user_id: 7,
      period_start: '2026-03-22',
      period_end: '2026-06-19',
      error_pattern_report_id: 4242,
      generated_at: new Date('2026-06-20T02:00:00Z'),
      metadata: { cron_run_id: 'run-1' },
    };
    // bias
    const biasRow = buildBiasSuggestion(makeBias(), 0, 1, ctx);
    assert('[3.1] bias category', biasRow.category === IMPROVEMENT_CATEGORY.BIAS);
    assert('[3.2] bias key = bias_type', biasRow.key === 'chase_high');
    assert(
      '[3.3] bias title 含 bias_type + 命中次数 + 趋势',
      biasRow.title.includes('chase_high') &&
        biasRow.title.includes('12') &&
        biasRow.title.includes('上升')
    );
    assert(
      '[3.4] bias body 含 sample trades',
      biasRow.body.includes('600519') && biasRow.body.includes('000725')
    );
    assert(
      '[3.5] bias title ≤ TITLE_MAX',
      Array.from(biasRow.title).length <= IMPROVEMENT_TITLE_MAX_CHARS
    );
    assert(
      '[3.6] bias body ≤ BODY_MAX',
      Array.from(biasRow.body).length <= IMPROVEMENT_BODY_MAX_CHARS
    );
    assert(
      '[3.7] bias evidence 含 error_pattern_report_id + sample_items',
      biasRow.evidence.error_pattern_report_id === 4242 &&
        Array.isArray(biasRow.evidence.sample_items) &&
        (biasRow.evidence.sample_items as unknown[]).length === 3
    );
    assert(
      '[3.8] bias action OPEN_WORKSPACE_TAB',
      (biasRow.action as { type?: string }).type === IMPROVEMENT_ACTION_TYPE.OPEN_WORKSPACE_TAB
    );
    assert(
      '[3.9] bias status open + source heuristic',
      biasRow.status === IMPROVEMENT_STATUS.OPEN && biasRow.source === IMPROVEMENT_SOURCE.HEURISTIC
    );
    assert('[3.10] bias metadata 透传 cron_run_id + 加 builder', biasRow.metadata.cron_run_id === 'run-1' && biasRow.metadata.builder === 'bias');

    // bias 缺 sample → body 不抛 + 仍有建议句
    const biasNoSample = buildBiasSuggestion(makeBias({ sample_trades: [] }), 0, 1, ctx);
    assert(
      '[3.11] bias 无 sample 不抛 + body 仍有内容',
      biasNoSample.body.length > 20 && !biasNoSample.body.includes('涉及标的:')
    );

    // outcome
    const outRow = buildOutcomeSuggestion(makeOutcome(), 0, 1, ctx);
    assert('[3.12] outcome category', outRow.category === IMPROVEMENT_CATEGORY.OUTCOME);
    assert('[3.13] outcome key', outRow.key === 'loss_trade');
    assert(
      '[3.14] outcome title 含 outcome_type + 累计亏损',
      outRow.title.includes('loss_trade') && outRow.title.includes('-8200')
    );
    assert(
      '[3.15] outcome body 含 worst case symbol',
      outRow.body.includes('600519') && outRow.body.includes('000725')
    );
    assert('[3.16] outcome action OPEN_WORKSPACE_TAB', (outRow.action as { type?: string }).type === IMPROVEMENT_ACTION_TYPE.OPEN_WORKSPACE_TAB);
    assert(
      '[3.17] outcome evidence sample_items = worst_examples',
      Array.isArray(outRow.evidence.sample_items) &&
        (outRow.evidence.sample_items as unknown[]).length === 2
    );

    // outcome 空 worst → 不抛
    const outNoWorst = buildOutcomeSuggestion(
      makeOutcome({ worst_examples: [] }),
      0,
      1,
      ctx
    );
    assert(
      '[3.18] outcome 空 worst 不抛 + body 有内容',
      outNoWorst.body.length > 20 && !outNoWorst.body.includes('最严重 case:')
    );

    // attribution
    const attrRow = buildAttributionSuggestion(makeAttr(), 0, 1, ctx);
    assert('[3.19] attribution category', attrRow.category === IMPROVEMENT_CATEGORY.ATTRIBUTION);
    assert('[3.20] attribution key = dimension', attrRow.key === 'execution_cost');
    assert(
      '[3.21] attribution action TUNE_RISK_PARAM + payload.dimension',
      (attrRow.action as { type?: string; payload?: Record<string, unknown> }).type ===
        IMPROVEMENT_ACTION_TYPE.TUNE_RISK_PARAM &&
        ((attrRow.action as { payload?: Record<string, unknown> }).payload as Record<string, unknown>)
          ?.dimension === 'execution_cost'
    );
    assert(
      '[3.22] attribution evidence 含 worst_day',
      Array.isArray(attrRow.evidence.sample_items) &&
        (attrRow.evidence.sample_items as Array<{ date: string }>)[0]?.date === '2026-05-15'
    );

    // attribution 无 worst_day
    const attrNoWorst = buildAttributionSuggestion(
      makeAttr({ worst_day: '', worst_day_contrib: 0 }),
      0,
      1,
      ctx
    );
    assert(
      '[3.23] attribution 无 worst_day → sample_items=[]',
      Array.isArray(attrNoWorst.evidence.sample_items) &&
        (attrNoWorst.evidence.sample_items as unknown[]).length === 0
    );

    // top
    const topRow = buildTopSuggestion(makeTop(), 0, 1, ctx);
    assert('[3.24] top category', topRow.category === IMPROVEMENT_CATEGORY.TOP);
    assert(
      '[3.25] top key 形式 cat:key 防与原始建议冲突',
      topRow.key === 'bias:chase_high'
    );
    assert('[3.26] top action default NOOP', (topRow.action as { type?: string }).type === IMPROVEMENT_ACTION_TYPE.NOOP);
    assert(
      '[3.27] top priority rank=0 → anchor = PRIORITY_TOP',
      topRow.priority === IMPROVEMENT_PRIORITY_TOP
    );
    assert(
      '[3.28] top evidence 含 source_category + source_key',
      (topRow.evidence.metric as Record<string, unknown>).source_category === 'bias' &&
        (topRow.evidence.metric as Record<string, unknown>).source_key === 'chase_high'
    );

    // priority — bias rank=0 单条 = anchor=95; outcome 同 rank=0 单条 = 90
    assert(
      '[3.29] bias single priority = PRIORITY_TOP - 5',
      biasRow.priority === IMPROVEMENT_PRIORITY_TOP - 5
    );
    assert(
      '[3.30] outcome single priority = PRIORITY_TOP - 10',
      outRow.priority === IMPROVEMENT_PRIORITY_TOP - 10
    );
    assert(
      '[3.31] attribution single priority = PRIORITY_TOP - 15',
      attrRow.priority === IMPROVEMENT_PRIORITY_TOP - 15
    );
  }

  // ---- [4] buildSuggestionsFromPatterns ------------------------------------
  {
    const snap = makeSnapshot();
    const rows = buildSuggestionsFromPatterns(snap, new Date(), { cron_run_id: 'r1' });
    const cats = rows.map(r => r.category);
    assert('[4.1] 含 bias × 2', cats.filter(c => c === 'bias').length === 2);
    assert('[4.2] 含 outcome × 1', cats.filter(c => c === 'outcome').length === 1);
    // attribution 3 个其中 1 个正 contrib 应过滤 → 2
    assert(
      '[4.3] 含 attribution × 2 (正贡献过滤)',
      cats.filter(c => c === 'attribution').length === 2
    );
    assert('[4.4] 含 top × 1', cats.filter(c => c === 'top').length === 1);
    assert('[4.5] 总行数 = 6', rows.length === 6);
    // 每行 user_id / period_end 一致
    assert(
      '[4.6] 每行 user_id 一致',
      rows.every(r => r.user_id === 7)
    );
    assert(
      '[4.7] 每行 period_end 一致',
      rows.every(r => r.period_end === '2026-06-19')
    );
    // 全空 patterns → 空数组
    const empty = buildSuggestionsFromPatterns(
      {
        ...snap,
        patterns: {
          bias_patterns: [],
          outcome_patterns: [],
          attribution_patterns: [],
          top_findings: [],
        },
      },
      new Date(),
      {}
    );
    assert('[4.8] 全空 patterns → []', empty.length === 0);
    // 顺序: 第一条是 bias (按 patterns 数组顺序)
    assert('[4.9] 首行是 bias (按 patterns 数组顺序)', rows[0].category === 'bias');
  }

  // ---- [5] generateForUser AC -----------------------------------------------
  {
    // 用 fake DataSource 自由控制 load + upsert 行为
    const makeFakeDS = (
      opts: {
        snapshot?: ErrorPatternSnapshot | null;
        loadThrow?: boolean;
        upsertResult?: {
          ok: boolean;
          persisted_count: number;
          reason?: string;
          error?: string;
        };
        upsertThrow?: boolean;
      } = {}
    ): {
      ds: ImprovementSuggestionDataSource;
      loadCalls: Array<{ user_id: number; period_end?: string | null }>;
      upsertCalls: ImprovementSuggestionUpsertRow[][];
    } => {
      const loadCalls: Array<{ user_id: number; period_end?: string | null }> = [];
      const upsertCalls: ImprovementSuggestionUpsertRow[][] = [];
      return {
        loadCalls,
        upsertCalls,
        ds: {
          async loadLatestErrorPatternReport(input) {
            loadCalls.push(input);
            if (opts.loadThrow) throw new Error('boom_load');
            return opts.snapshot === undefined ? null : opts.snapshot;
          },
          async bulkUpsertSuggestions(rows) {
            upsertCalls.push(rows);
            if (opts.upsertThrow) throw new Error('boom_upsert');
            return (
              opts.upsertResult || { ok: true, persisted_count: rows.length }
            );
          },
        },
      };
    };

    // (a) happy
    {
      const snap = makeSnapshot();
      const fake = makeFakeDS({ snapshot: snap });
      const r = await generateForUser(7, { data_source: fake.ds, cron_run_id: 'run-A' });
      assert('[5a.1] status=ok', r.status === IMPROVEMENT_GENERATE_STATUS.OK);
      assert('[5a.2] rows.length = 6', r.rows.length === 6);
      assert(
        '[5a.3] persisted_count = rows.length',
        r.persisted_count === 6
      );
      assert(
        '[5a.4] error_pattern_report_id 透传',
        r.error_pattern_report_id === 4242
      );
      assert('[5a.5] reason=null on ok', r.reason === null);
      // metadata 透传 cron_run_id + error_pattern_report_id + heuristic_engine
      const firstRow = fake.upsertCalls[0][0];
      assert(
        '[5a.6] metadata 透传 cron_run_id',
        firstRow.metadata.cron_run_id === 'run-A'
      );
      assert(
        '[5a.7] metadata 透传 error_pattern_report_id',
        firstRow.metadata.error_pattern_report_id === 4242
      );
      assert(
        '[5a.8] metadata heuristic_engine = v1',
        firstRow.metadata.heuristic_engine === 'v1'
      );
    }

    // (b) no error_pattern
    {
      const fake = makeFakeDS({ snapshot: null });
      const r = await generateForUser(7, { data_source: fake.ds });
      assert('[5b.1] status=skipped', r.status === IMPROVEMENT_GENERATE_STATUS.SKIPPED);
      assert('[5b.2] reason=no_error_pattern', r.reason === 'no_error_pattern');
      assert('[5b.3] persisted_count=0', r.persisted_count === 0);
      assert('[5b.4] rows=[]', r.rows.length === 0);
      assert('[5b.5] error_pattern_report_id=null', r.error_pattern_report_id === null);
      assert('[5b.6] 未调 bulkUpsert', fake.upsertCalls.length === 0);
    }

    // (c) patterns 全空
    {
      const snap = makeSnapshot({
        bias_patterns: [],
        outcome_patterns: [],
        attribution_patterns: [],
        top_findings: [],
      });
      const fake = makeFakeDS({ snapshot: snap });
      const r = await generateForUser(7, { data_source: fake.ds });
      assert('[5c.1] status=skipped', r.status === IMPROVEMENT_GENERATE_STATUS.SKIPPED);
      assert('[5c.2] reason=patterns_empty', r.reason === 'patterns_empty');
      assert(
        '[5c.3] error_pattern_report_id 仍透传',
        r.error_pattern_report_id === 4242
      );
      assert('[5c.4] 未调 bulkUpsert', fake.upsertCalls.length === 0);
    }

    // (c2) attribution 全正贡献也算 patterns_empty (与原始数组非空对照)
    {
      const snap = makeSnapshot({
        bias_patterns: [],
        outcome_patterns: [],
        attribution_patterns: [makeAttr({ total_contrib: 100 })], // 正
        top_findings: [],
      });
      const fake = makeFakeDS({ snapshot: snap });
      const r = await generateForUser(7, { data_source: fake.ds });
      assert(
        '[5c2.1] attribution 全正 → skipped patterns_empty',
        r.status === IMPROVEMENT_GENERATE_STATUS.SKIPPED && r.reason === 'patterns_empty'
      );
    }

    // (d) load throw
    {
      const fake = makeFakeDS({ loadThrow: true });
      const r = await generateForUser(7, { data_source: fake.ds });
      assert('[5d.1] status=failed', r.status === IMPROVEMENT_GENERATE_STATUS.FAILED);
      assert('[5d.2] reason=load_threw', r.reason === 'load_threw');
      assert('[5d.3] persisted_count=0', r.persisted_count === 0);
      assert('[5d.4] error_pattern_report_id=null', r.error_pattern_report_id === null);
    }

    // (e) bulkUpsert 返 false
    {
      const snap = makeSnapshot();
      const fake = makeFakeDS({
        snapshot: snap,
        upsertResult: { ok: false, persisted_count: 0, reason: 'duplicate_key' },
      });
      const r = await generateForUser(7, { data_source: fake.ds });
      assert('[5e.1] status=failed', r.status === IMPROVEMENT_GENERATE_STATUS.FAILED);
      assert('[5e.2] reason 透传 duplicate_key', r.reason === 'duplicate_key');
      assert('[5e.3] persisted_count=0', r.persisted_count === 0);
      assert(
        '[5e.4] error_pattern_report_id 仍透传',
        r.error_pattern_report_id === 4242
      );
      assert('[5e.5] rows 仍返回供 debug', r.rows.length === 6);
    }

    // (f) bulkUpsert throw — 顶层 catch 兜底
    {
      const snap = makeSnapshot();
      const fake = makeFakeDS({ snapshot: snap, upsertThrow: true });
      const r = await generateForUser(7, { data_source: fake.ds });
      assert(
        '[5f.1] bulkUpsert throw → failed + reason=bulk_upsert_threw',
        r.status === IMPROVEMENT_GENERATE_STATUS.FAILED && r.reason === 'bulk_upsert_threw'
      );
      assert('[5f.2] persisted_count=0', r.persisted_count === 0);
    }

    // (g) cron_run_id 流入 metadata + period_end override
    {
      const snap = makeSnapshot();
      const fake = makeFakeDS({ snapshot: snap });
      const r = await generateForUser(7, {
        data_source: fake.ds,
        period_end: '2026-06-19',
        cron_run_id: 'run-G',
      });
      assert(
        '[5g.1] period_end override 流入 load',
        fake.loadCalls[0].period_end === '2026-06-19'
      );
      assert(
        '[5g.2] cron_run_id 流入每行 metadata',
        fake.upsertCalls[0].every(row => row.metadata.cron_run_id === 'run-G')
      );
      assert('[5g.3] status=ok', r.status === IMPROVEMENT_GENERATE_STATUS.OK);
    }

    // (h) partial persisted_count — bulkUpsert 返 ok=true persisted_count<N
    {
      const snap = makeSnapshot();
      const fake = makeFakeDS({
        snapshot: snap,
        upsertResult: { ok: true, persisted_count: 3 },
      });
      const r = await generateForUser(7, { data_source: fake.ds });
      assert('[5h.1] partial 仍 status=ok', r.status === IMPROVEMENT_GENERATE_STATUS.OK);
      assert('[5h.2] persisted_count=3 透传', r.persisted_count === 3);
    }
  }

  // ---- [6] PRODUCTION DataSource — DB-less 不抛 ----------------------------
  {
    const ds = createProductionImprovementSuggestionDataSource();
    try {
      const r = await ds.loadLatestErrorPatternReport({ user_id: 99999 });
      assert('[6.1] PRODUCTION load 不抛 (返 null / snapshot)', r === null || typeof r === 'object');
    } catch (e) {
      assert('[6.1] PRODUCTION load 不抛', false, String(e));
    }
    try {
      const r = await ds.bulkUpsertSuggestions([]);
      assert(
        '[6.2] PRODUCTION bulkUpsert empty → ok+0',
        r.ok === true && r.persisted_count === 0
      );
    } catch (e) {
      assert('[6.2] PRODUCTION bulkUpsert empty 不抛', false, String(e));
    }
    try {
      const r = await ds.bulkUpsertSuggestions([
        {
          user_id: 99999,
          period_start: '2026-03-22',
          period_end: '2026-06-19',
          category: 'bias',
          key: 'chase_high',
          title: 't',
          body: 'b',
          priority: 95,
          evidence: {},
          action: { type: 'noop' },
          source: 'heuristic',
          status: 'open',
          metadata: {},
          generated_at: new Date(),
        },
      ]);
      assert(
        '[6.3] PRODUCTION bulkUpsert 不抛 (返 envelope)',
        typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.persisted_count === 'number'
      );
    } catch (e) {
      assert('[6.3] PRODUCTION bulkUpsert 不抛', false, String(e));
    }
  }

  // ---- [7] META-GUARD fs+regex ----------------------------------------------
  {
    const modelPath = join(__dirname, '../../src/models/ImprovementSuggestion.ts');
    const upPath = join(
      __dirname,
      '../../scripts/migrations/2026-06-20-improvement-suggestions.sql'
    );
    const downPath = join(
      __dirname,
      '../../scripts/migrations/2026-06-20-improvement-suggestions-rollback.sql'
    );
    const modelSrc = readFileSync(modelPath, 'utf8');
    const upSrc = readFileSync(upPath, 'utf8');
    const downSrc = readFileSync(downPath, 'utf8');
    // model
    assert(
      '[7.1] model 含 tableName improvement_suggestions',
      /tableName:\s*'improvement_suggestions'/.test(modelSrc)
    );
    assert(
      '[7.2] model 含 UNIQUE (user_id, period_end, category, key)',
      /unique:\s*true/.test(modelSrc) &&
        /period_end/.test(modelSrc) &&
        /category/.test(modelSrc) &&
        /'key'/.test(modelSrc)
    );
    assert('[7.3] model 含 priority INTEGER', /declare priority:\s*number/.test(modelSrc));
    assert('[7.4] model 含 evidence JSONB', /declare evidence/.test(modelSrc));
    assert('[7.5] model 含 action JSONB', /declare action/.test(modelSrc));
    assert(
      '[7.6] model 含 status 四态注释 (open/applied/dismissed/expired)',
      /open/.test(modelSrc) &&
        /applied/.test(modelSrc) &&
        /dismissed/.test(modelSrc) &&
        /expired/.test(modelSrc)
    );
    assert(
      '[7.7] model 含 applied_at / dismissed_at nullable',
      /declare applied_at:\s*Date \| null/.test(modelSrc) &&
        /declare dismissed_at:\s*Date \| null/.test(modelSrc)
    );
    // migration up
    assert(
      '[7.8] up 含 CREATE TABLE IF NOT EXISTS',
      /CREATE TABLE IF NOT EXISTS improvement_suggestions/.test(upSrc)
    );
    assert(
      '[7.9] up 含 UNIQUE INDEX user_period_cat_key',
      /UNIQUE INDEX IF NOT EXISTS improvement_suggestions_user_period_cat_key_uniq/.test(upSrc)
    );
    assert('[7.10] up 含 BEGIN/COMMIT', /BEGIN;[\s\S]*COMMIT;/.test(upSrc));
    assert(
      '[7.11] up 默认值安全态',
      /status\s+VARCHAR\(20\)\s+NOT NULL DEFAULT\s+'open'/.test(upSrc) &&
        /source\s+VARCHAR\(20\)\s+NOT NULL DEFAULT\s+'heuristic'/.test(upSrc) &&
        /priority\s+INTEGER\s+NOT NULL DEFAULT 0/.test(upSrc) &&
        /action[\s\S]*DEFAULT\s+'{"type":"noop"}'::jsonb/.test(upSrc)
    );
    // migration down
    assert(
      '[7.12] down 含 DROP TABLE IF EXISTS',
      /DROP TABLE IF EXISTS improvement_suggestions/.test(downSrc)
    );
    assert(
      '[7.13] down 含 DROP INDEX IF EXISTS user_period_cat_key',
      /DROP INDEX IF EXISTS improvement_suggestions_user_period_cat_key_uniq/.test(downSrc)
    );
    // database.ts 已注册 model
    const dbPath = join(__dirname, '../../src/config/database.ts');
    const dbSrc = readFileSync(dbPath, 'utf8');
    assert(
      '[7.14] database.ts import ImprovementSuggestion',
      /import\s*\{\s*ImprovementSuggestion\s*\}/.test(dbSrc) &&
        /\bImprovementSuggestion\b/.test(dbSrc.split('models:')[1] || '')
    );
    // models/index.ts re-export
    const indexPath = join(__dirname, '../../src/models/index.ts');
    const indexSrc = readFileSync(indexPath, 'utf8');
    assert(
      '[7.15] models/index.ts re-export ImprovementSuggestion',
      /export \* from '\.\/ImprovementSuggestion'/.test(indexSrc)
    );
  }

  // ---- summary -------------------------------------------------------------
  console.log(`\n[improvement-suggestion-service.test] ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('TEST RUNNER THREW', err);
  process.exit(1);
});
