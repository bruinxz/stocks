/**
 * ImprovementEffectTracker 单元测试 (US-146 [PM-027]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/postmortem/improvement-effect-tracker.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 sanity (DEFAULT_EFFECT_WINDOW_DAYS / MIN_SHARPE_SAMPLE_DAYS /
 *       EFFECT_METRICS_SOURCE / TRACK_STATUS frozen)
 *   [2] pure helpers: normalizeDate / computeWindowEndDate / computeSharpeRatio / buildEffectMetrics
 *   [3] trackForSuggestion 单条 12 路径:
 *       happy / dry_run / already_tracked + force / no_portfolios / no_attribution_data /
 *       invalid_applied_at (null + NaN) / listUserPortfolios throw / loadAttributionReports throw /
 *       writeBackMetrics returns false (row_not_found) / writeBackMetrics throws
 *   [4] trackPendingSuggestions 主验收 AC:
 *       (a) 多 candidate 聚合 ok/skipped/failed/persisted_count 正确
 *       (b) listPendingApplied throw → reason='list_threw' + 空 summary
 *       (c) dry_run 全 candidate 不写回但 metrics 完整 + persisted_count=0
 *       (d) cutoff 计算正确 (applied_at <= now - window_days)
 *       (e) force=true 透传到 ds.listPendingApplied
 *       (f) limit/user_id 透传
 *   [5] PRODUCTION DataSource 工厂 — 不抛 (lazy require + 4 method 都 fail-OPEN)
 *   [6] META-GUARD fs+regex: model 含 effect_metrics + effect_tracked_at + 新 index;
 *       migration up/down 含 add/drop column + index; service ↔ model 字段同步
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  DEFAULT_EFFECT_WINDOW_DAYS,
  MIN_SHARPE_SAMPLE_DAYS,
  EFFECT_METRICS_SOURCE,
  TRACK_STATUS,
  normalizeDate,
  computeWindowEndDate,
  computeSharpeRatio,
  buildEffectMetrics,
  trackForSuggestion,
  trackPendingSuggestions,
  createProductionImprovementEffectTrackerDataSource,
  PRODUCTION_IMPROVEMENT_EFFECT_TRACKER_DATA_SOURCE,
  AppliedSuggestionRow,
  AttributionDailyRow,
  ImprovementEffectMetrics,
  ImprovementEffectTrackerDataSource,
} from '../../src/services/postmortem/ImprovementEffectTracker';

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

// ---------------------------------------------------------------------------
// Fake DataSource
// ---------------------------------------------------------------------------

interface FakeState {
  pendingCalls: Array<Record<string, unknown>>;
  portfolioCalls: Array<{ user_id: number }>;
  attributionCalls: Array<{
    portfolio_ids: number[];
    start_date: string;
    end_date: string;
  }>;
  writebackCalls: Array<{ id: number; metrics: ImprovementEffectMetrics; tracked_at: Date }>;
  pending: AppliedSuggestionRow[];
  portfoliosByUser: Map<number, number[]>;
  attributionRows: AttributionDailyRow[];
  // failure flags
  listThrows: boolean;
  portfoliosThrows: boolean;
  attributionThrows: boolean;
  writebackResult: 'ok' | 'row_not_found' | 'throw';
}

function makeFakeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    pendingCalls: [],
    portfolioCalls: [],
    attributionCalls: [],
    writebackCalls: [],
    pending: [],
    portfoliosByUser: new Map(),
    attributionRows: [],
    listThrows: false,
    portfoliosThrows: false,
    attributionThrows: false,
    writebackResult: 'ok',
    ...overrides,
  };
}

function makeFakeDataSource(state: FakeState): ImprovementEffectTrackerDataSource {
  return {
    async listPendingApplied(input) {
      state.pendingCalls.push(input as unknown as Record<string, unknown>);
      if (state.listThrows) throw new Error('boom-list');
      let rows = state.pending.slice();
      if (input.user_id != null) rows = rows.filter(r => r.user_id === input.user_id);
      if (input.limit && input.limit > 0) rows = rows.slice(0, input.limit);
      return rows;
    },
    async listUserPortfolios({ user_id }) {
      state.portfolioCalls.push({ user_id });
      if (state.portfoliosThrows) throw new Error('boom-portfolios');
      return state.portfoliosByUser.get(user_id) || [];
    },
    async loadAttributionReports(input) {
      state.attributionCalls.push(input);
      if (state.attributionThrows) throw new Error('boom-attr');
      return state.attributionRows.filter(
        r =>
          input.portfolio_ids.includes(r.portfolio_id) &&
          r.date >= input.start_date &&
          r.date <= input.end_date
      );
    },
    async writeBackMetrics(input) {
      state.writebackCalls.push({
        id: input.id,
        metrics: input.effect_metrics,
        tracked_at: input.effect_tracked_at,
      });
      if (state.writebackResult === 'throw') throw new Error('boom-write');
      if (state.writebackResult === 'row_not_found') {
        return { ok: false, reason: 'row_not_found' };
      }
      return { ok: true };
    },
  };
}

function makeSuggestion(overrides: Partial<AppliedSuggestionRow> = {}): AppliedSuggestionRow {
  return {
    id: 101,
    user_id: 7,
    period_end: '2026-05-20',
    category: 'bias',
    key: 'chase_high',
    applied_at: new Date('2026-05-21T10:00:00Z'),
    effect_tracked_at: null,
    ...overrides,
  };
}

function makeAttrRow(overrides: Partial<AttributionDailyRow> = {}): AttributionDailyRow {
  return {
    portfolio_id: 1,
    date: '2026-05-22',
    total_pnl: 100,
    total_pnl_pct: 0.5,
    trade_count: 3,
    ...overrides,
  };
}

(async () => {
  // ---- [1] 常量 sanity ------------------------------------------------------
  {
    assert('[1.1] DEFAULT_EFFECT_WINDOW_DAYS=30', DEFAULT_EFFECT_WINDOW_DAYS === 30);
    assert('[1.2] MIN_SHARPE_SAMPLE_DAYS >= 2', MIN_SHARPE_SAMPLE_DAYS >= 2);
    assert(
      '[1.3] EFFECT_METRICS_SOURCE 双态',
      EFFECT_METRICS_SOURCE.TRACKER_CRON === 'tracker_cron' &&
        EFFECT_METRICS_SOURCE.MANUAL === 'manual'
    );
    assert(
      '[1.4] TRACK_STATUS 三态',
      TRACK_STATUS.OK === 'ok' &&
        TRACK_STATUS.SKIPPED === 'skipped' &&
        TRACK_STATUS.FAILED === 'failed'
    );
    let frozen = true;
    try {
      // @ts-expect-error mutate frozen for test
      EFFECT_METRICS_SOURCE.TRACKER_CRON = 'mutated';
      if (
        (EFFECT_METRICS_SOURCE as Record<string, string>).TRACKER_CRON !== 'tracker_cron'
      )
        frozen = false;
    } catch {
      /* strict mode ok */
    }
    assert('[1.5] EFFECT_METRICS_SOURCE frozen', frozen);
  }

  // ---- [2] pure helpers -----------------------------------------------------
  {
    // normalizeDate
    assert('[2.1] normalizeDate null=空串', normalizeDate(null) === '');
    assert('[2.2] normalizeDate undefined=空串', normalizeDate(undefined) === '');
    assert(
      '[2.3] normalizeDate Date',
      normalizeDate(new Date('2026-05-21T10:00:00Z')) === '2026-05-21'
    );
    assert(
      '[2.4] normalizeDate YYYY-MM-DD pass-through',
      normalizeDate('2026-05-21') === '2026-05-21'
    );
    assert(
      '[2.5] normalizeDate ISO truncate',
      normalizeDate('2026-05-21T10:00:00Z') === '2026-05-21'
    );
    assert('[2.6] normalizeDate invalid Date=空串', normalizeDate(new Date('invalid')) === '');
    assert('[2.7] normalizeDate invalid string=空串', normalizeDate('not-a-date') === '');

    // computeWindowEndDate
    assert(
      '[2.10] window=30 加 30 天',
      computeWindowEndDate(new Date('2026-05-21T00:00:00Z'), 30) === '2026-06-20'
    );
    assert(
      '[2.11] window=7 加 7 天',
      computeWindowEndDate(new Date('2026-05-21T00:00:00Z'), 7) === '2026-05-28'
    );

    // computeSharpeRatio
    assert('[2.20] sharpe 空=0', computeSharpeRatio([]) === 0);
    assert('[2.21] sharpe 1 样本=0', computeSharpeRatio([1.5]) === 0);
    assert(
      '[2.22] sharpe stddev=0 → 0 (all same)',
      computeSharpeRatio([1, 1, 1, 1, 1]) === 0
    );
    {
      // mean=0.5 stddev = sqrt(((-0.5)^2+(0.5)^2)/1)=sqrt(0.5)≈0.7071 → 0.5/0.7071*sqrt(2)≈1
      const s = computeSharpeRatio([0, 1]);
      assert('[2.23] sharpe 简易 case [0,1] ≈ 1', Math.abs(s - 1) < 1e-6, `s=${s}`);
    }
    {
      const s = computeSharpeRatio([1, 2, 3, 4, 5]);
      assert('[2.24] sharpe 5 样本 finite > 0', Number.isFinite(s) && s > 0, `s=${s}`);
    }

    // buildEffectMetrics
    {
      const empty = buildEffectMetrics({
        rows: [],
        start_date: '2026-05-21',
        end_date: '2026-06-20',
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
      });
      assert('[2.30] buildEffectMetrics 空 rows → sample_days=0', empty.sample_days === 0);
      assert('[2.31] buildEffectMetrics 空 rows → total_pnl_sum=0', empty.total_pnl_sum === 0);
      assert('[2.32] buildEffectMetrics 空 rows → sharpe=0', empty.total_pnl_pct_sharpe === 0);
      assert(
        '[2.33] buildEffectMetrics 空 rows → portfolios_covered=0',
        empty.portfolios_covered === 0
      );
      assert('[2.34] buildEffectMetrics 空 rows → window_days=30', empty.window_days === 30);
      assert(
        '[2.35] buildEffectMetrics source 透传',
        empty.source === EFFECT_METRICS_SOURCE.TRACKER_CRON
      );
    }
    {
      const rows = [
        makeAttrRow({ portfolio_id: 1, date: '2026-05-22', total_pnl: 100, total_pnl_pct: 0.5, trade_count: 2 }),
        makeAttrRow({ portfolio_id: 1, date: '2026-05-23', total_pnl: -50, total_pnl_pct: -0.2, trade_count: 1 }),
        makeAttrRow({ portfolio_id: 2, date: '2026-05-22', total_pnl: 75, total_pnl_pct: 1.0, trade_count: 4 }),
        makeAttrRow({ portfolio_id: 2, date: '2026-05-23', total_pnl: 25, total_pnl_pct: null, trade_count: 0 }),
      ];
      const m = buildEffectMetrics({
        rows,
        start_date: '2026-05-21',
        end_date: '2026-06-20',
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.MANUAL,
      });
      assert('[2.40] sample_days=4', m.sample_days === 4);
      assert('[2.41] total_pnl_sum=150', m.total_pnl_sum === 150);
      assert('[2.42] trade_count_sum=7', m.trade_count_sum === 7);
      assert('[2.43] portfolios_covered=2', m.portfolios_covered === 2);
      // pct 平均: (0.5 + -0.2 + 1.0) / 3 = 0.4333... null 跳过
      assert(
        '[2.44] pct_avg 跳过 null',
        Math.abs(m.total_pnl_pct_avg - 0.4333) < 0.001,
        `got ${m.total_pnl_pct_avg}`
      );
      assert(
        '[2.45] sharpe finite',
        Number.isFinite(m.total_pnl_pct_sharpe) && m.total_pnl_pct_sharpe !== 0
      );
      assert('[2.46] source=manual', m.source === EFFECT_METRICS_SOURCE.MANUAL);
      assert('[2.47] start_date 透传', m.start_date === '2026-05-21');
      assert('[2.48] end_date 透传', m.end_date === '2026-06-20');
    }
    // NaN / Infinity 兜底
    {
      const rows = [
        makeAttrRow({ total_pnl: Number.NaN, total_pnl_pct: Number.NaN, trade_count: Number.NaN }),
        makeAttrRow({ total_pnl: 50, total_pnl_pct: 0.3, trade_count: 1 }),
      ];
      const m = buildEffectMetrics({
        rows,
        start_date: '2026-05-21',
        end_date: '2026-06-20',
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
      });
      assert('[2.50] NaN 跳过 — pnl_sum=50', m.total_pnl_sum === 50);
      assert('[2.51] NaN pct 跳过 — pct_avg=0.3', Math.abs(m.total_pnl_pct_avg - 0.3) < 0.001);
      assert('[2.52] NaN trade 跳过 — trade_count_sum=1', m.trade_count_sum === 1);
    }
  }

  // ---- [3] trackForSuggestion 单条 -------------------------------------------
  const NOW = new Date('2026-06-21T12:00:00Z');
  {
    // happy
    {
      const state = makeFakeState({
        portfoliosByUser: new Map([[7, [1, 2]]]),
        attributionRows: [
          makeAttrRow({ portfolio_id: 1, date: '2026-05-22', total_pnl: 100, total_pnl_pct: 0.5 }),
          makeAttrRow({ portfolio_id: 1, date: '2026-05-23', total_pnl: 50, total_pnl_pct: 0.2 }),
          makeAttrRow({ portfolio_id: 2, date: '2026-05-22', total_pnl: 30, total_pnl_pct: 0.1 }),
        ],
      });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion({
          applied_at: new Date('2026-05-21T10:00:00Z'),
        }),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: false,
        now: NOW,
      });
      assert('[3.1a] happy → ok', r.status === TRACK_STATUS.OK);
      assert('[3.1b] happy → persisted', r.persisted === true);
      assert('[3.1c] happy → metrics.sample_days=3', r.metrics?.sample_days === 3);
      assert('[3.1d] writeBack 调到', state.writebackCalls.length === 1);
      assert('[3.1e] writeBack id=101', state.writebackCalls[0].id === 101);
      assert(
        '[3.1f] writeBack tracked_at=NOW',
        state.writebackCalls[0].tracked_at.getTime() === NOW.getTime()
      );
      assert(
        '[3.1g] writeBack metrics source 透传',
        state.writebackCalls[0].metrics.source === EFFECT_METRICS_SOURCE.TRACKER_CRON
      );
      assert(
        '[3.1h] attribution 查 portfolios 全',
        state.attributionCalls[0].portfolio_ids.length === 2
      );
      assert(
        '[3.1i] start_date=applied_at UTC date',
        state.attributionCalls[0].start_date === '2026-05-21'
      );
      assert(
        '[3.1j] end_date=applied_at + 30 天',
        state.attributionCalls[0].end_date === '2026-06-20'
      );
    }
    // dry_run
    {
      const state = makeFakeState({
        portfoliosByUser: new Map([[7, [1]]]),
        attributionRows: [makeAttrRow({ portfolio_id: 1 })],
      });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion(),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: true,
        force: false,
        now: NOW,
      });
      assert('[3.2a] dry_run → ok', r.status === TRACK_STATUS.OK);
      assert('[3.2b] dry_run → reason=dry_run', r.reason === 'dry_run');
      assert('[3.2c] dry_run → persisted=false', r.persisted === false);
      assert('[3.2d] dry_run 不调 writeBack', state.writebackCalls.length === 0);
      assert('[3.2e] dry_run metrics 完整', r.metrics !== null && r.metrics.sample_days === 1);
    }
    // already_tracked
    {
      const state = makeFakeState({ portfoliosByUser: new Map([[7, [1]]]) });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion({ effect_tracked_at: new Date('2026-06-19T00:00:00Z') }),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: false,
        now: NOW,
      });
      assert('[3.3a] already_tracked → skipped', r.status === TRACK_STATUS.SKIPPED);
      assert('[3.3b] reason=already_tracked', r.reason === 'already_tracked');
      assert('[3.3c] 不调 listUserPortfolios', state.portfolioCalls.length === 0);
    }
    // force=true override already_tracked
    {
      const state = makeFakeState({
        portfoliosByUser: new Map([[7, [1]]]),
        attributionRows: [makeAttrRow({ portfolio_id: 1 })],
      });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion({ effect_tracked_at: new Date('2026-06-19T00:00:00Z') }),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: true,
        now: NOW,
      });
      assert('[3.4a] force → ok', r.status === TRACK_STATUS.OK);
      assert('[3.4b] force → persisted', r.persisted === true);
    }
    // no_portfolios
    {
      const state = makeFakeState({ portfoliosByUser: new Map() });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion(),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: false,
        now: NOW,
      });
      assert('[3.5a] no portfolios → skipped', r.status === TRACK_STATUS.SKIPPED);
      assert('[3.5b] reason=no_portfolios', r.reason === 'no_portfolios');
      assert('[3.5c] 不调 attribution', state.attributionCalls.length === 0);
    }
    // no_attribution_data
    {
      const state = makeFakeState({
        portfoliosByUser: new Map([[7, [1]]]),
        attributionRows: [],
      });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion(),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: false,
        now: NOW,
      });
      assert('[3.6a] empty attribution → skipped', r.status === TRACK_STATUS.SKIPPED);
      assert('[3.6b] reason=no_attribution_data', r.reason === 'no_attribution_data');
      assert('[3.6c] metrics 仍返 (sample=0)', r.metrics !== null && r.metrics.sample_days === 0);
      assert('[3.6d] 不调 writeBack', state.writebackCalls.length === 0);
    }
    // invalid_applied_at
    {
      const state = makeFakeState({ portfoliosByUser: new Map([[7, [1]]]) });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion({ applied_at: null as unknown as Date }),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: false,
        now: NOW,
      });
      assert('[3.7a] null applied_at → skipped', r.status === TRACK_STATUS.SKIPPED);
      assert('[3.7b] reason=invalid_applied_at', r.reason === 'invalid_applied_at');
    }
    {
      const state = makeFakeState({ portfoliosByUser: new Map([[7, [1]]]) });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion({ applied_at: new Date('invalid-date') }),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: false,
        now: NOW,
      });
      assert('[3.7c] NaN Date applied_at → skipped', r.status === TRACK_STATUS.SKIPPED);
      assert('[3.7d] reason=invalid_applied_at', r.reason === 'invalid_applied_at');
    }
    // listUserPortfolios throws
    {
      const state = makeFakeState({ portfoliosThrows: true });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion(),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: false,
        now: NOW,
      });
      assert('[3.8a] portfolios throws → failed', r.status === TRACK_STATUS.FAILED);
      assert('[3.8b] reason=list_portfolios_threw', r.reason === 'list_portfolios_threw');
    }
    // loadAttributionReports throws
    {
      const state = makeFakeState({
        portfoliosByUser: new Map([[7, [1]]]),
        attributionThrows: true,
      });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion(),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: false,
        now: NOW,
      });
      assert('[3.9a] attribution throws → failed', r.status === TRACK_STATUS.FAILED);
      assert('[3.9b] reason=load_attribution_threw', r.reason === 'load_attribution_threw');
    }
    // writeBackMetrics returns false
    {
      const state = makeFakeState({
        portfoliosByUser: new Map([[7, [1]]]),
        attributionRows: [makeAttrRow({ portfolio_id: 1 })],
        writebackResult: 'row_not_found',
      });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion(),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: false,
        now: NOW,
      });
      assert('[3.10a] writeBack false → failed', r.status === TRACK_STATUS.FAILED);
      assert('[3.10b] reason=row_not_found', r.reason === 'row_not_found');
      assert('[3.10c] metrics 仍返', r.metrics !== null);
    }
    // writeBackMetrics throws
    {
      const state = makeFakeState({
        portfoliosByUser: new Map([[7, [1]]]),
        attributionRows: [makeAttrRow({ portfolio_id: 1 })],
        writebackResult: 'throw',
      });
      const ds = makeFakeDataSource(state);
      const r = await trackForSuggestion({
        data_source: ds,
        suggestion: makeSuggestion(),
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
        dry_run: false,
        force: false,
        now: NOW,
      });
      assert('[3.11a] writeBack throws → failed', r.status === TRACK_STATUS.FAILED);
      assert('[3.11b] reason=writeback_threw', r.reason === 'writeback_threw');
    }
  }

  // ---- [4] trackPendingSuggestions 主验收 -----------------------------------
  {
    // (a) 多 candidate aggregation
    {
      const state = makeFakeState({
        pending: [
          makeSuggestion({ id: 1, user_id: 10 }),
          makeSuggestion({ id: 2, user_id: 11 }), // no portfolios → skipped
          makeSuggestion({ id: 3, user_id: 12 }), // attribution_throws path -- not here
        ],
        portfoliosByUser: new Map([
          [10, [100]],
          [12, [120]],
        ]),
        attributionRows: [
          makeAttrRow({ portfolio_id: 100, date: '2026-05-22', total_pnl: 200, total_pnl_pct: 1.0 }),
          makeAttrRow({ portfolio_id: 120, date: '2026-05-23', total_pnl: 50, total_pnl_pct: 0.3 }),
        ],
      });
      const ds = makeFakeDataSource(state);
      const summary = await trackPendingSuggestions({
        data_source: ds,
        window_days: 30,
        now: NOW,
      });
      assert('[4.1a] total_candidates=3', summary.total_candidates === 3);
      assert('[4.1b] ok_count=2', summary.ok_count === 2, `got ${summary.ok_count}`);
      assert('[4.1c] skipped_count=1', summary.skipped_count === 1);
      assert('[4.1d] persisted_count=2', summary.persisted_count === 2);
      assert('[4.1e] per_suggestion 3 项', summary.per_suggestion.length === 3);
      assert('[4.1f] window_days=30', summary.window_days === 30);
      assert(
        '[4.1g] source 默认 tracker_cron',
        summary.source === EFFECT_METRICS_SOURCE.TRACKER_CRON
      );
    }
    // (b) listPendingApplied throw → reason=list_threw
    {
      const state = makeFakeState({ listThrows: true });
      const ds = makeFakeDataSource(state);
      const summary = await trackPendingSuggestions({
        data_source: ds,
        window_days: 30,
        now: NOW,
      });
      assert('[4.2a] list throw → total=0', summary.total_candidates === 0);
      assert('[4.2b] list throw → reason=list_threw', summary.reason === 'list_threw');
      assert('[4.2c] list throw → per_suggestion=[]', summary.per_suggestion.length === 0);
    }
    // (c) dry_run 全 candidate 不写回
    {
      const state = makeFakeState({
        pending: [makeSuggestion({ id: 5 })],
        portfoliosByUser: new Map([[7, [1]]]),
        attributionRows: [makeAttrRow({ portfolio_id: 1 })],
      });
      const ds = makeFakeDataSource(state);
      const summary = await trackPendingSuggestions({
        data_source: ds,
        window_days: 30,
        dry_run: true,
        now: NOW,
      });
      assert('[4.3a] dry_run ok_count=1', summary.ok_count === 1);
      assert('[4.3b] dry_run persisted_count=0', summary.persisted_count === 0);
      assert('[4.3c] dry_run writeBack=0', state.writebackCalls.length === 0);
      assert(
        '[4.3d] dry_run per_suggestion[0].metrics 仍齐',
        summary.per_suggestion[0].metrics !== null
      );
    }
    // (d) cutoff 计算
    {
      const state = makeFakeState();
      const ds = makeFakeDataSource(state);
      await trackPendingSuggestions({
        data_source: ds,
        window_days: 30,
        now: NOW,
      });
      assert('[4.4a] listPendingApplied 调 1 次', state.pendingCalls.length === 1);
      const cutoff = state.pendingCalls[0].cutoff as Date;
      const expected = NOW.getTime() - 30 * 24 * 3600 * 1000;
      assert(
        '[4.4b] cutoff = now - 30d',
        cutoff.getTime() === expected,
        `cutoff=${cutoff.toISOString()} expected=${new Date(expected).toISOString()}`
      );
    }
    // (e) force 透传
    {
      const state = makeFakeState();
      const ds = makeFakeDataSource(state);
      await trackPendingSuggestions({
        data_source: ds,
        window_days: 30,
        force: true,
        now: NOW,
      });
      assert('[4.5a] force 透传', state.pendingCalls[0].force === true);
    }
    // (f) limit + user_id 透传
    {
      const state = makeFakeState();
      const ds = makeFakeDataSource(state);
      await trackPendingSuggestions({
        data_source: ds,
        window_days: 30,
        limit: 5,
        user_id: 999,
        now: NOW,
      });
      assert('[4.6a] limit 透传', state.pendingCalls[0].limit === 5);
      assert('[4.6b] user_id 透传', state.pendingCalls[0].user_id === 999);
    }
    // window_days <= 0 兜底 fallback
    {
      const state = makeFakeState();
      const ds = makeFakeDataSource(state);
      const summary = await trackPendingSuggestions({
        data_source: ds,
        window_days: 0,
        now: NOW,
      });
      assert('[4.7a] window=0 fallback 默认 30', summary.window_days === 30);
    }
    // source override
    {
      const state = makeFakeState({
        pending: [makeSuggestion()],
        portfoliosByUser: new Map([[7, [1]]]),
        attributionRows: [makeAttrRow({ portfolio_id: 1 })],
      });
      const ds = makeFakeDataSource(state);
      const summary = await trackPendingSuggestions({
        data_source: ds,
        window_days: 30,
        source: EFFECT_METRICS_SOURCE.MANUAL,
        now: NOW,
      });
      assert('[4.8a] source manual 透传', summary.source === EFFECT_METRICS_SOURCE.MANUAL);
      assert(
        '[4.8b] metrics.source=manual',
        state.writebackCalls[0].metrics.source === EFFECT_METRICS_SOURCE.MANUAL
      );
    }
  }

  // ---- [5] PRODUCTION DataSource 工厂 ---------------------------------------
  {
    const ds = createProductionImprovementEffectTrackerDataSource();
    assert('[5.1] factory 返 4 method', typeof ds.listPendingApplied === 'function');
    assert('[5.2] singleton 默认存在', !!PRODUCTION_IMPROVEMENT_EFFECT_TRACKER_DATA_SOURCE);
    // 真调 — 无 DB 应被 try/catch 兜底返 []
    const r1 = await ds.listPendingApplied({
      cutoff: new Date('2026-01-01T00:00:00Z'),
      force: false,
    });
    assert('[5.3] listPendingApplied 无 DB → []', Array.isArray(r1) && r1.length === 0);
    const r2 = await ds.listUserPortfolios({ user_id: 1 });
    assert('[5.4] listUserPortfolios 无 DB → []', Array.isArray(r2) && r2.length === 0);
    const r3 = await ds.loadAttributionReports({
      portfolio_ids: [],
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    });
    assert('[5.5] loadAttributionReports 空 ids → []', Array.isArray(r3) && r3.length === 0);
    const r4 = await ds.loadAttributionReports({
      portfolio_ids: [1, 2],
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    });
    assert('[5.6] loadAttributionReports 无 DB → []', Array.isArray(r4) && r4.length === 0);
    // writeBackMetrics 无 DB → ok:false (require fail, model 拽不起)
    const r5 = await ds.writeBackMetrics({
      id: 1,
      effect_metrics: {
        window_days: 30,
        sample_days: 0,
        total_pnl_sum: 0,
        total_pnl_pct_avg: 0,
        total_pnl_pct_sharpe: 0,
        trade_count_sum: 0,
        start_date: '2026-01-01',
        end_date: '2026-01-31',
        portfolios_covered: 0,
        source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
      },
      effect_tracked_at: NOW,
    });
    assert('[5.7] writeBackMetrics 无 DB → ok:false', r5.ok === false);
  }

  // ---- [6] META-GUARD fs+regex ---------------------------------------------
  {
    const repoBase = join(__dirname, '..', '..');
    const modelSrc = readFileSync(
      join(repoBase, 'src', 'models', 'ImprovementSuggestion.ts'),
      'utf8'
    );
    assert(
      '[6.1] model 含 effect_metrics column',
      /declare effect_metrics: Record<string, unknown>/.test(modelSrc) &&
        /field: 'effect_metrics'/.test(modelSrc)
    );
    assert(
      '[6.2] model 含 effect_tracked_at column',
      /declare effect_tracked_at: Date \| null/.test(modelSrc) &&
        /field: 'effect_tracked_at'/.test(modelSrc)
    );
    assert(
      '[6.3] model 含新 index name',
      /idx_improvement_suggestions_status_tracked/.test(modelSrc)
    );
    assert(
      '[6.4] model effect_metrics default {} + NOT NULL',
      /effect_metrics[\s\S]*?defaultValue:\s*\{\}/.test(modelSrc) &&
        /effect_metrics[\s\S]*?allowNull:\s*false/.test(modelSrc)
    );

    const migrationUp = readFileSync(
      join(
        repoBase,
        'scripts',
        'migrations',
        '2026-06-21-improvement-suggestions-effect-metrics.sql'
      ),
      'utf8'
    );
    assert(
      '[6.5] migration up 含 ADD COLUMN effect_metrics + IF NOT EXISTS',
      /ADD COLUMN IF NOT EXISTS effect_metrics JSONB/.test(migrationUp)
    );
    assert(
      '[6.6] migration up 含 ADD COLUMN effect_tracked_at',
      /ADD COLUMN IF NOT EXISTS effect_tracked_at TIMESTAMP/.test(migrationUp)
    );
    assert(
      '[6.7] migration up 含 CREATE INDEX status_tracked',
      /CREATE INDEX IF NOT EXISTS idx_improvement_suggestions_status_tracked/.test(migrationUp)
    );
    assert('[6.8] migration up BEGIN/COMMIT 包裹', /BEGIN;[\s\S]*?COMMIT;/.test(migrationUp));

    const migrationDown = readFileSync(
      join(
        repoBase,
        'scripts',
        'migrations',
        '2026-06-21-improvement-suggestions-effect-metrics-rollback.sql'
      ),
      'utf8'
    );
    assert(
      '[6.9] rollback DROP COLUMN effect_metrics',
      /DROP COLUMN IF EXISTS effect_metrics/.test(migrationDown)
    );
    assert(
      '[6.10] rollback DROP COLUMN effect_tracked_at',
      /DROP COLUMN IF EXISTS effect_tracked_at/.test(migrationDown)
    );
    assert(
      '[6.11] rollback DROP INDEX status_tracked',
      /DROP INDEX IF EXISTS idx_improvement_suggestions_status_tracked/.test(migrationDown)
    );

    const serviceSrc = readFileSync(
      join(repoBase, 'src', 'services', 'postmortem', 'ImprovementEffectTracker.ts'),
      'utf8'
    );
    assert(
      '[6.12] service lazy require ImprovementSuggestion',
      /require\('\.\.\/\.\.\/models\/ImprovementSuggestion'\)/.test(serviceSrc)
    );
    assert(
      '[6.13] service lazy require PaperTradingPortfolio',
      /require\('\.\.\/\.\.\/models\/PaperTradingPortfolio'\)/.test(serviceSrc)
    );
    assert(
      '[6.14] service lazy require DailyAttributionReport',
      /require\('\.\.\/\.\.\/models\/DailyAttributionReport'\)/.test(serviceSrc)
    );
    assert(
      '[6.15] service writeBackMetrics 写 effect_metrics + effect_tracked_at',
      /effect_metrics,\s*\n\s*effect_tracked_at,/.test(serviceSrc)
    );
    assert(
      '[6.16] service trackForSuggestion 顶层 export',
      /export async function trackForSuggestion/.test(serviceSrc)
    );
    assert(
      '[6.17] service trackPendingSuggestions 顶层 export',
      /export async function trackPendingSuggestions/.test(serviceSrc)
    );
  }

  // ---- summary --------------------------------------------------------------
  setTimeout(() => {
    console.log(`\nImprovementEffectTracker tests: ${passed} ok / ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  }, 50);
})().catch(err => {
  console.error('test crashed', err);
  process.exit(1);
});
