/**
 * DailyAttributionCronRunner 单元测试 (US-083 [PM-006]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/attribution/daily-attribution-cron.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 sanity
 *   [2] buildPersistRow — happy (status=ok 报告字段映射齐) / skipped 留痕 /
 *       failed 留痕 / generated_at 字段类型
 *   [3] runDailyAttributionGenerate 主入口 AC 主验收:
 *        (a) happy → 多 portfolio 全 ok + persisted_count 等于 total
 *        (b) skipped (snapshot 不足) → 仍 persistReport + per_portfolio.status='skipped'
 *        (c) service throw → 兜底 status='failed' reason='service_threw'
 *        (d) persist 失败 → status='persist_failed' + persisted=false 但 continue
 *        (e) persist throw → 兜底 status='persist_failed' continue 下一个 portfolio
 *        (f) dry_run=true → persistReport 0 次调 + summary.persisted_count=0
 *        (g) explicit portfolio_ids 覆盖 listActivePortfolios
 *        (h) listActivePortfolios throw → 当作空列表 不挂
 *   [4] PRODUCTION DataSource factory 不抛 (lazy require + try/catch)
 *   [5] META-GUARD fs+regex:
 *        (a) cronRegistry 含 DAILY_ATTRIBUTION_GENERATE + analytics + recommendedCron 17:00
 *        (b) SchedulerService 含 else-if DAILY_ATTRIBUTION_GENERATE dispatch
 *            + require DailyAttributionCronRunner + safeUpdateExecutionLog + logger.info 标签
 *        (c) SchedulerService 含 defaultTasks seed 含 DAILY_ATTRIBUTION_GENERATE
 *        (d) cron-registry.test.ts 已知 SchedulerService 含本 type
 *            (本 test 自带 sanity 检查 dispatch 与 registry 同步)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DAILY_ATTRIBUTION_CRON_SOURCE,
  DEFAULT_DAILY_ATTRIBUTION_CRON_DRY_RUN,
  buildPersistRow,
  createProductionDailyAttributionCronDataSource,
  runDailyAttributionGenerate,
  DailyAttributionCronDataSource,
} from '../../src/services/attribution/DailyAttributionCronRunner';
import {
  DAILY_ATTRIBUTION_STATUS,
  DailyAttributionRunResult,
  DailyAttributionReport as DAReport,
  DailyAttributionDataSource,
  DailyAttributionTradeRow,
  DailyAttributionSnapshotRow,
  DailyAttributionPositionRow,
} from '../../src/services/attribution/DailyAttributionService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

// 静音 logger.warn / info 让测试输出整洁
/* eslint-disable @typescript-eslint/no-var-requires */
const loggerModule = require('../../src/utils/logger');
loggerModule.logger.warn = () => undefined;
loggerModule.logger.info = () => undefined;
loggerModule.logger.error = () => undefined;
/* eslint-enable @typescript-eslint/no-var-requires */

// ----------------------------------------------------------------------------
// 通用 fake service-side DataSource — 构造可控的 trades / snapshots
// ----------------------------------------------------------------------------

function makeServiceDataSource(opts: {
  trades?: DailyAttributionTradeRow[];
  snapshots?: DailyAttributionSnapshotRow[];
  positions?: DailyAttributionPositionRow[];
  industry?: Record<string, string>;
  throwOn?: 'trades' | 'snapshots' | 'positions' | 'industry';
}): DailyAttributionDataSource {
  return {
    async loadTrades() {
      if (opts.throwOn === 'trades') throw new Error('fake trades fail');
      return opts.trades || [];
    },
    async loadSnapshots() {
      if (opts.throwOn === 'snapshots') throw new Error('fake snapshots fail');
      return opts.snapshots || [];
    },
    async loadPositions() {
      if (opts.throwOn === 'positions') throw new Error('fake positions fail');
      return opts.positions || [];
    },
    async loadSymbolIndustryMap() {
      if (opts.throwOn === 'industry') throw new Error('fake industry fail');
      return opts.industry || {};
    },
  };
}

function happySnapshots(date: string): DailyAttributionSnapshotRow[] {
  return [
    { date: prevDayString(date), total_value: 100000, current_cash: 50000, position_value: 50000 },
    { date, total_value: 101500, current_cash: 50500, position_value: 51000 },
  ];
}

function prevDayString(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// 主测试 IIFE
// ----------------------------------------------------------------------------

(async () => {
  // ---- [1] 常量 sanity -----------------------------------------------------
  assert('[1.1] DAILY_ATTRIBUTION_CRON_SOURCE === cron', DAILY_ATTRIBUTION_CRON_SOURCE === 'cron');
  assert(
    '[1.2] DEFAULT_DAILY_ATTRIBUTION_CRON_DRY_RUN === false',
    DEFAULT_DAILY_ATTRIBUTION_CRON_DRY_RUN === false
  );

  // ---- [2] buildPersistRow -------------------------------------------------
  const sampleReport: DAReport = {
    portfolio_id: 1,
    date: '2026-06-20',
    total_pnl: 1500,
    total_pnl_pct: 1.5,
    realized_pnl: 800,
    unrealized_delta: 700,
    trade_count: 3,
    buy_count: 1,
    sell_count: 2,
    breakdown: {
      factor_contrib_total: 0,
      factor_contrib: [],
      industry_contrib: [{ industry: '酒水饮料', pnl: 500, pct: 0.5 }],
      selection_contrib: 200,
      timing_contrib: 100,
      sizing_contrib: 50,
      execution_cost: -30,
      residual: 0,
    } as any,
    best_trades: [{ id: 1, symbol: '600519', realized_pnl: 800 } as any],
    worst_trades: [],
    ai_summary: '今日盈利 1500 元',
    generated_at: '2026-06-20T09:00:00Z',
  } as DAReport;

  const happyResult: DailyAttributionRunResult = {
    status: DAILY_ATTRIBUTION_STATUS.OK,
    report: sampleReport,
  };
  const row = buildPersistRow({
    portfolio_id: 1,
    date: '2026-06-20',
    source: 'cron',
    result: happyResult,
  }) as any;
  assert('[2.1] happy row portfolio_id', row.portfolio_id === 1);
  assert('[2.2] happy row date', row.date === '2026-06-20');
  assert('[2.3] happy row total_pnl', row.total_pnl === 1500);
  assert('[2.4] happy row status', row.status === 'ok');
  assert('[2.5] happy row breakdown 含 industry_contrib', Array.isArray(row.breakdown.industry_contrib));
  assert('[2.6] happy row best_trades 数组', Array.isArray(row.best_trades) && row.best_trades.length === 1);
  assert('[2.7] happy row ai_summary 透传', row.ai_summary === '今日盈利 1500 元');
  assert('[2.8] happy row source', row.source === 'cron');
  assert(
    '[2.9] happy row generated_at Date 类型',
    row.generated_at instanceof Date
  );
  assert('[2.10] happy row metadata.source', row.metadata.source === 'cron');

  const skippedResult: DailyAttributionRunResult = {
    status: DAILY_ATTRIBUTION_STATUS.SKIPPED,
    report: null,
    reason: 'no_prev_snapshot',
  };
  const skippedRow = buildPersistRow({
    portfolio_id: 2,
    date: '2026-06-20',
    source: 'cron',
    result: skippedResult,
  }) as any;
  assert('[2.11] skipped row status', skippedRow.status === 'skipped');
  assert('[2.12] skipped row reason', skippedRow.reason === 'no_prev_snapshot');
  assert('[2.13] skipped row total_pnl=0 留痕', skippedRow.total_pnl === 0);
  assert('[2.14] skipped row breakdown={}', JSON.stringify(skippedRow.breakdown) === '{}');
  assert('[2.15] skipped row best_trades=[]', Array.isArray(skippedRow.best_trades) && skippedRow.best_trades.length === 0);

  const failedResult: DailyAttributionRunResult = {
    status: DAILY_ATTRIBUTION_STATUS.FAILED,
    report: null,
    reason: 'db_error',
    error: 'connection lost',
  };
  const failedRow = buildPersistRow({
    portfolio_id: 3,
    date: '2026-06-20',
    source: 'cron',
    result: failedResult,
  }) as any;
  assert('[2.16] failed row status', failedRow.status === 'failed');
  assert('[2.17] failed row metadata.error', failedRow.metadata.error === 'connection lost');

  // ---- [3] runDailyAttributionGenerate -------------------------------------

  // (a) happy — 2 portfolio 全 ok
  {
    const date = '2026-06-20';
    const persistCalls: Array<{ portfolio_id: number; status: string }> = [];
    const cronSource: DailyAttributionCronDataSource = {
      async listActivePortfolios() {
        return [
          { id: 11, user_id: 100 },
          { id: 12, user_id: 101 },
        ];
      },
      async persistReport(input) {
        persistCalls.push({ portfolio_id: input.portfolio_id, status: input.result.status });
        return { ok: true };
      },
    };
    const trades: DailyAttributionTradeRow[] = [
      {
        id: 1,
        portfolio_id: 11,
        symbol: '600519',
        name: '茅台',
        direction: 'SELL',
        execute_price: 1700,
        quantity: 100,
        amount: 170000,
        commission: 50,
        realized_pnl: 1200,
        created_at: `${date}T05:00:00Z`,
      },
    ];
    const summary = await runDailyAttributionGenerate({
      date,
      cron_data_source: cronSource,
      service_data_source: makeServiceDataSource({
        trades,
        snapshots: happySnapshots(date),
        positions: [],
        industry: { '600519': '酒水饮料' },
      }),
    });
    assert('[3.a.1] happy total_portfolios=2', summary.total_portfolios === 2);
    assert('[3.a.2] happy ok_count=2', summary.ok_count === 2);
    assert('[3.a.3] happy persisted_count=2', summary.persisted_count === 2);
    assert('[3.a.4] happy persistCalls 2 次', persistCalls.length === 2);
    assert('[3.a.5] happy per_portfolio 全 persisted', summary.per_portfolio.every(p => p.persisted));
    assert('[3.a.6] happy date 透传', summary.date === date);
    assert('[3.a.7] happy dry_run=false', summary.dry_run === false);
  }

  // (b) skipped — snapshot 不足
  {
    const date = '2026-06-20';
    const persistCalls: any[] = [];
    const cronSource: DailyAttributionCronDataSource = {
      async listActivePortfolios() {
        return [{ id: 20, user_id: 200 }];
      },
      async persistReport(input) {
        persistCalls.push(input);
        return { ok: true };
      },
    };
    const summary = await runDailyAttributionGenerate({
      date,
      cron_data_source: cronSource,
      service_data_source: makeServiceDataSource({ snapshots: [] }),
    });
    assert('[3.b.1] skipped skipped_count=1', summary.skipped_count === 1);
    assert('[3.b.2] skipped ok_count=0', summary.ok_count === 0);
    assert('[3.b.3] skipped persistReport 仍 1 次 (留痕)', persistCalls.length === 1);
    assert('[3.b.4] skipped persisted_count=1', summary.persisted_count === 1);
    assert(
      '[3.b.5] skipped per_portfolio status=skipped',
      summary.per_portfolio[0].status === 'skipped'
    );
    assert(
      '[3.b.6] skipped reason=no_prev_snapshot',
      summary.per_portfolio[0].reason === 'no_prev_snapshot'
    );
  }

  // (c) service throw — DataSource loadTrades 抛
  {
    const date = '2026-06-20';
    const persistCalls: any[] = [];
    const cronSource: DailyAttributionCronDataSource = {
      async listActivePortfolios() {
        return [{ id: 30, user_id: 300 }];
      },
      async persistReport(input) {
        persistCalls.push(input);
        return { ok: true };
      },
    };
    const summary = await runDailyAttributionGenerate({
      date,
      cron_data_source: cronSource,
      service_data_source: makeServiceDataSource({ throwOn: 'trades' }),
    });
    // service 内部 fail-OPEN 不抛 — loadTrades throw 在 service Promise.all 中被
    // 顶层 catch 捕到, 返 status='failed' reason='db_error'
    assert('[3.c.1] service throw failed_count=1', summary.failed_count === 1);
    assert(
      '[3.c.2] service throw per_portfolio status=failed',
      summary.per_portfolio[0].status === 'failed'
    );
    assert(
      '[3.c.3] service throw reason=db_error',
      summary.per_portfolio[0].reason === 'db_error'
    );
    assert('[3.c.4] service throw 仍 persistReport 1 次', persistCalls.length === 1);
  }

  // (d) persist 返 {ok:false} — status 应改 persist_failed + persisted=false 但 continue
  {
    const date = '2026-06-20';
    let firstCall = true;
    const cronSource: DailyAttributionCronDataSource = {
      async listActivePortfolios() {
        return [
          { id: 41, user_id: 401 },
          { id: 42, user_id: 402 },
        ];
      },
      async persistReport() {
        if (firstCall) {
          firstCall = false;
          return { ok: false, reason: 'persist_failed', error: 'unique violation' };
        }
        return { ok: true };
      },
    };
    const summary = await runDailyAttributionGenerate({
      date,
      cron_data_source: cronSource,
      service_data_source: makeServiceDataSource({ snapshots: happySnapshots(date) }),
    });
    assert('[3.d.1] persist fail total=2', summary.total_portfolios === 2);
    assert('[3.d.2] persist fail ok_count=1', summary.ok_count === 1);
    assert('[3.d.3] persist fail failed_count=1', summary.failed_count === 1);
    assert('[3.d.4] persist fail persisted_count=1', summary.persisted_count === 1);
    assert(
      '[3.d.5] persist fail per_portfolio[0].status=persist_failed',
      summary.per_portfolio[0].status === 'persist_failed'
    );
    assert(
      '[3.d.6] persist fail per_portfolio[0].error 透传',
      summary.per_portfolio[0].error === 'unique violation'
    );
    assert(
      '[3.d.7] persist fail per_portfolio[1] 仍 ok 持久化',
      summary.per_portfolio[1].status === 'ok' && summary.per_portfolio[1].persisted === true
    );
  }

  // (e) persistReport throw (programmer error 兜底)
  {
    const date = '2026-06-20';
    let firstCall = true;
    const cronSource: DailyAttributionCronDataSource = {
      async listActivePortfolios() {
        return [
          { id: 51, user_id: 501 },
          { id: 52, user_id: 502 },
        ];
      },
      async persistReport() {
        if (firstCall) {
          firstCall = false;
          throw new Error('boom');
        }
        return { ok: true };
      },
    };
    const summary = await runDailyAttributionGenerate({
      date,
      cron_data_source: cronSource,
      service_data_source: makeServiceDataSource({ snapshots: happySnapshots(date) }),
    });
    assert('[3.e.1] persist throw failed_count=1', summary.failed_count === 1);
    assert(
      '[3.e.2] persist throw per_portfolio[0].status=persist_failed',
      summary.per_portfolio[0].status === 'persist_failed'
    );
    assert(
      '[3.e.3] persist throw per_portfolio[0].reason=persist_threw',
      summary.per_portfolio[0].reason === 'persist_threw'
    );
    assert(
      '[3.e.4] persist throw per_portfolio[1] 仍 ok',
      summary.per_portfolio[1].status === 'ok'
    );
  }

  // (f) dry_run=true — 不调 persistReport
  {
    const date = '2026-06-20';
    const persistCalls: any[] = [];
    const cronSource: DailyAttributionCronDataSource = {
      async listActivePortfolios() {
        return [{ id: 60, user_id: 600 }];
      },
      async persistReport(input) {
        persistCalls.push(input);
        return { ok: true };
      },
    };
    const summary = await runDailyAttributionGenerate({
      date,
      dry_run: true,
      cron_data_source: cronSource,
      service_data_source: makeServiceDataSource({ snapshots: happySnapshots(date) }),
    });
    assert('[3.f.1] dry_run persistCalls=0', persistCalls.length === 0);
    assert('[3.f.2] dry_run persisted_count=0', summary.persisted_count === 0);
    assert('[3.f.3] dry_run ok_count=1 (service 仍跑)', summary.ok_count === 1);
    assert('[3.f.4] dry_run summary.dry_run=true', summary.dry_run === true);
    assert(
      '[3.f.5] dry_run per_portfolio.persisted=false',
      summary.per_portfolio[0].persisted === false
    );
  }

  // (g) explicit portfolio_ids 覆盖 list — list 应不被调
  {
    const date = '2026-06-20';
    let listCalled = false;
    const cronSource: DailyAttributionCronDataSource = {
      async listActivePortfolios() {
        listCalled = true;
        return [{ id: 999, user_id: 0 }];
      },
      async persistReport() {
        return { ok: true };
      },
    };
    const summary = await runDailyAttributionGenerate({
      date,
      portfolio_ids: [71, 72, 73],
      cron_data_source: cronSource,
      service_data_source: makeServiceDataSource({ snapshots: happySnapshots(date) }),
    });
    assert('[3.g.1] explicit ids 不调 listActivePortfolios', listCalled === false);
    assert('[3.g.2] explicit ids total=3', summary.total_portfolios === 3);
    assert('[3.g.3] explicit ids 全部 ok', summary.ok_count === 3);
  }

  // (h) listActivePortfolios throw → 当空跑
  {
    const cronSource: DailyAttributionCronDataSource = {
      async listActivePortfolios() {
        throw new Error('db down');
      },
      async persistReport() {
        return { ok: true };
      },
    };
    const summary = await runDailyAttributionGenerate({
      date: '2026-06-20',
      cron_data_source: cronSource,
    });
    assert('[3.h.1] list throw total=0', summary.total_portfolios === 0);
    assert('[3.h.2] list throw per_portfolio=[]', summary.per_portfolio.length === 0);
  }

  // ---- [4] PRODUCTION DataSource factory ----------------------------------
  {
    const prod = createProductionDailyAttributionCronDataSource();
    assert('[4.1] factory listActivePortfolios fn', typeof prod.listActivePortfolios === 'function');
    assert('[4.2] factory persistReport fn', typeof prod.persistReport === 'function');
    // 调一下不抛 (DB 不通时返 []  / {ok:false})
    let listResult: any;
    let persistResult: any;
    try {
      listResult = await prod.listActivePortfolios();
    } catch (e: any) {
      listResult = `THROW: ${e?.message}`;
    }
    try {
      persistResult = await prod.persistReport({
        portfolio_id: 1,
        date: '2026-06-20',
        source: 'cron',
        result: { status: DAILY_ATTRIBUTION_STATUS.OK, report: sampleReport },
      });
    } catch (e: any) {
      persistResult = `THROW: ${e?.message}`;
    }
    assert(
      '[4.3] PRODUCTION listActivePortfolios 不抛 (返数组)',
      Array.isArray(listResult)
    );
    assert(
      '[4.4] PRODUCTION persistReport 不抛 (返 {ok})',
      persistResult && typeof persistResult.ok === 'boolean'
    );
  }

  // ---- [5] META-GUARD fs+regex --------------------------------------------
  {
    const cronRegistrySrc = readFileSync(
      join(__dirname, '../../src/constants/cronRegistry.ts'),
      'utf-8'
    );
    assert(
      '[5.a.1] cronRegistry 含 DAILY_ATTRIBUTION_GENERATE',
      /type:\s*'DAILY_ATTRIBUTION_GENERATE'/.test(cronRegistrySrc)
    );
    assert(
      '[5.a.2] cronRegistry DAILY_ATTRIBUTION 段 analytics + owner analytics',
      /DAILY_ATTRIBUTION_GENERATE[\s\S]*?category:\s*'analytics'[\s\S]*?owner:\s*'analytics'/m.test(
        cronRegistrySrc
      )
    );
    assert(
      '[5.a.3] cronRegistry DAILY_ATTRIBUTION 推荐 cron=17:00 工作日',
      /DAILY_ATTRIBUTION_GENERATE[\s\S]*?recommendedCron:\s*'0\s+17\s+\*\s+\*\s+1-5'/m.test(
        cronRegistrySrc
      )
    );

    const schedulerSrc = readFileSync(
      join(__dirname, '../../src/services/SchedulerService.ts'),
      'utf-8'
    );
    assert(
      '[5.b.1] SchedulerService 含 else-if DAILY_ATTRIBUTION_GENERATE',
      /task\.type\s*===\s*'DAILY_ATTRIBUTION_GENERATE'/.test(schedulerSrc)
    );
    assert(
      '[5.b.2] SchedulerService 含 require DailyAttributionCronRunner',
      /require\(['"][.\\/]+attribution\/DailyAttributionCronRunner['"]\)/.test(schedulerSrc)
    );
    assert(
      '[5.b.3] SchedulerService DAILY_ATTRIBUTION 段含 runDailyAttributionGenerate',
      /runDailyAttributionGenerate\s*\(/.test(schedulerSrc)
    );
    assert(
      '[5.b.4] SchedulerService DAILY_ATTRIBUTION 段含 safeUpdateExecutionLog 写 result_summary',
      /DAILY_ATTRIBUTION_GENERATE[\s\S]*?safeUpdateExecutionLog/m.test(schedulerSrc)
    );
    assert(
      '[5.b.5] SchedulerService DAILY_ATTRIBUTION 日志标签',
      /\[DAILY_ATTRIBUTION_GENERATE\]/.test(schedulerSrc)
    );
    assert(
      '[5.c.1] SchedulerService defaultTasks 含 DAILY_ATTRIBUTION_GENERATE seed',
      /name:\s*['"]每日归因报告生成['"][\s\S]*?type:\s*'DAILY_ATTRIBUTION_GENERATE'/m.test(
        schedulerSrc
      )
    );
    assert(
      '[5.c.2] seed cron_expression=0 17 * * 1-5',
      /type:\s*'DAILY_ATTRIBUTION_GENERATE'[\s\S]*?cron_expression:\s*['"]0\s+17\s+\*\s+\*\s+1-5['"]/m.test(
        schedulerSrc
      )
    );

    // (d) 确保 cron-registry test 仍能 pass — 我们的 dispatch type 必须等于 registry 的 type
    // 简单 sanity: registry 里有 DAILY_ATTRIBUTION_GENERATE 且 scheduler 里也有同名 dispatch
    assert(
      '[5.d.1] registry + scheduler 双源都含 DAILY_ATTRIBUTION_GENERATE',
      /DAILY_ATTRIBUTION_GENERATE/.test(cronRegistrySrc) &&
        /DAILY_ATTRIBUTION_GENERATE/.test(schedulerSrc)
    );
  }

  // ---- summary -------------------------------------------------------------
  console.log(`\ndaily-attribution-cron: ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
