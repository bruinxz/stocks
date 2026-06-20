/**
 * ErrorPatternCronRunner 单元测试 (US-093 [PM-022]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/postmortem/error-pattern-cron.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 sanity
 *   [2] normalizeErrorPatternCronDate / buildDefaultCronRunId / normalizeLookbackDays
 *   [3] runWeeklyErrorPattern 主入口 AC 主验收:
 *        (a) happy 多 user 全 ok + persisted_count 等于 total
 *        (b) skipped (records 不足 MIN_DATA_DAYS) → status='skipped' + 留痕
 *        (c) load throw → status='failed' + reason='load_threw' + 留痕
 *        (d) explicit user_ids 覆盖 listActiveUsers
 *        (e) listActiveUsers throw → 当空跑
 *        (f) dry_run=true → summary.dry_run=true + 仍跑全 user
 *        (g) period_end + lookback_days 透传
 *        (h) cron_run_id explicit override
 *        (i) upsert 返 ok=false → status='ok' persisted=false (failed 计数)
 *        (j) explicit user_ids=[] → 跳过 listActiveUsers (preview)
 *        (k) explicit user_ids 过滤 NaN/0/负数
 *   [4] PRODUCTION DataSource factory 不抛 (lazy require + try/catch)
 *   [5] META-GUARD fs+regex:
 *        (a) cronRegistry 含 WEEKLY_ERROR_PATTERN_AGGREGATE + analytics + 周日 10:00
 *        (b) SchedulerService 含 else-if WEEKLY_ERROR_PATTERN_AGGREGATE dispatch
 *            + require ErrorPatternCronRunner + safeUpdateExecutionLog + logger.info 标签
 *        (c) SchedulerService defaultTasks 含 WEEKLY_ERROR_PATTERN_AGGREGATE seed
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ERROR_PATTERN_CRON_RUN_ID_PREFIX,
  DEFAULT_ERROR_PATTERN_CRON_DRY_RUN,
  DEFAULT_ERROR_PATTERN_CRON_LOOKBACK_DAYS,
  ErrorPatternCronDataSource,
  buildDefaultCronRunId,
  createProductionErrorPatternCronDataSource,
  normalizeErrorPatternCronDate,
  normalizeLookbackDays,
  runWeeklyErrorPattern,
} from '../../src/services/postmortem/ErrorPatternCronRunner';
import {
  AttributionDailyRecord,
  ErrorPatternAggregatorDataSource,
  ErrorPatternUpsertRow,
  MIN_DATA_DAYS,
} from '../../src/services/postmortem/ErrorPatternAggregator';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

// 静音 logger.warn / info / error 让测试输出整洁
/* eslint-disable @typescript-eslint/no-var-requires */
const loggerModule = require('../../src/utils/logger');
loggerModule.logger.warn = () => undefined;
loggerModule.logger.info = () => undefined;
loggerModule.logger.error = () => undefined;
/* eslint-enable @typescript-eslint/no-var-requires */

// ----------------------------------------------------------------------------
// 通用 fake service-side ErrorPatternAggregatorDataSource
// ----------------------------------------------------------------------------

function makeRec(date: string): AttributionDailyRecord {
  return {
    date,
    total_pnl: 200,
    total_pnl_pct: 0.5,
    trade_count: 3,
    bias_findings: [
      {
        bias_type: 'overtrade',
        severity: 'medium',
        message: 'too many trades',
        evidence: { trade_count: 8 },
      },
    ],
    breakdown: { industry: 100, factor: 50, timing: 25, selection: 25, sizing: 0 },
    best_trades: [],
    worst_trades: [],
  };
}

function makeRecsForUser(count: number, baseDay: number): AttributionDailyRecord[] {
  const out: AttributionDailyRecord[] = [];
  for (let i = 0; i < count; i++) {
    const day = baseDay + i;
    const date = `2026-06-${String(day).padStart(2, '0')}`;
    out.push(makeRec(date));
  }
  return out;
}

interface FakeServiceDataSourceOpts {
  recsByUser?: Record<number, AttributionDailyRecord[]>;
  loadThrow?: boolean;
  upsertOk?: boolean | ((row: ErrorPatternUpsertRow) => boolean);
  upsertThrow?: boolean;
  upsertCalls?: Array<{
    user_id: number;
    period_end: string;
    status: string;
    reason: string | null;
    lookback_days: number;
    cron_run_id?: unknown;
  }>;
}

function makeServiceDataSource(
  opts: FakeServiceDataSourceOpts
): ErrorPatternAggregatorDataSource {
  const upsertCalls = opts.upsertCalls || [];
  return {
    async loadAttributionReports({ user_id }) {
      if (opts.loadThrow) throw new Error('fake load fail');
      const recs = opts.recsByUser?.[user_id];
      if (recs === undefined) return makeRecsForUser(10, 1); // 默认 10 天 happy
      return recs;
    },
    async upsertErrorPatternReport(row) {
      if (opts.upsertThrow) throw new Error('upsert boom');
      upsertCalls.push({
        user_id: row.user_id,
        period_end: row.period_end,
        status: row.status,
        reason: row.reason,
        lookback_days: row.lookback_days,
        cron_run_id: (row.metadata as Record<string, unknown>).cron_run_id,
      });
      const ok =
        typeof opts.upsertOk === 'function'
          ? opts.upsertOk(row)
          : opts.upsertOk === undefined
          ? true
          : opts.upsertOk;
      return ok ? { ok: true } : { ok: false, reason: 'persist_failed' };
    },
  };
}

(async () => {
  // ---- [1] 常量 sanity -----------------------------------------------------
  assert(
    '[1.1] ERROR_PATTERN_CRON_RUN_ID_PREFIX = error_pattern_cron_',
    ERROR_PATTERN_CRON_RUN_ID_PREFIX === 'error_pattern_cron_'
  );
  assert(
    '[1.2] DEFAULT_ERROR_PATTERN_CRON_DRY_RUN = false',
    DEFAULT_ERROR_PATTERN_CRON_DRY_RUN === false
  );
  assert(
    '[1.3] DEFAULT_ERROR_PATTERN_CRON_LOOKBACK_DAYS = 90',
    DEFAULT_ERROR_PATTERN_CRON_LOOKBACK_DAYS === 90
  );

  // ---- [2] pure helpers ----------------------------------------------------
  assert(
    '[2.1] normalize valid date',
    normalizeErrorPatternCronDate('2026-06-21') === '2026-06-21'
  );
  assert(
    '[2.2] normalize ISO datetime → 截 10 字符',
    normalizeErrorPatternCronDate('2026-06-21T09:00:00Z') === '2026-06-21'
  );
  assert(
    '[2.3] normalize 非法返今日 (YYYY-MM-DD 格式)',
    /^\d{4}-\d{2}-\d{2}$/.test(normalizeErrorPatternCronDate('garbage'))
  );
  assert(
    '[2.4] buildDefaultCronRunId 含 prefix + period_end',
    buildDefaultCronRunId('2026-06-21').startsWith('error_pattern_cron_2026-06-21_')
  );
  assert('[2.5] normalizeLookbackDays valid', normalizeLookbackDays(30) === 30);
  assert('[2.6] normalizeLookbackDays NaN → 90', normalizeLookbackDays(NaN) === 90);
  assert('[2.7] normalizeLookbackDays 0 → 90', normalizeLookbackDays(0) === 90);
  assert('[2.8] normalizeLookbackDays 负数 → 90', normalizeLookbackDays(-5) === 90);
  assert(
    '[2.9] normalizeLookbackDays undefined → 90',
    normalizeLookbackDays(undefined) === 90
  );
  assert('[2.10] normalizeLookbackDays string 数字', normalizeLookbackDays('60') === 60);
  assert(
    '[2.11] normalizeLookbackDays 小数 → floor',
    normalizeLookbackDays(45.7) === 45
  );

  // ---- [3] runWeeklyErrorPattern 主入口 ------------------------------------

  // (a) happy — 3 user 全 ok
  {
    const period_end = '2026-06-21';
    const upsertCalls: Array<any> = [];
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        return [{ id: 11 }, { id: 12 }, { id: 13 }];
      },
    };
    const serviceSource = makeServiceDataSource({ upsertCalls });
    const summary = await runWeeklyErrorPattern({
      period_end,
      cron_data_source: cronSource,
      service_data_source: serviceSource,
    });
    assert('[3.a.1] happy total_users=3', summary.total_users === 3);
    assert('[3.a.2] happy ok_count=3', summary.ok_count === 3);
    assert('[3.a.3] happy persisted_count=3', summary.persisted_count === 3);
    assert('[3.a.4] happy upsertCalls 3 次', upsertCalls.length === 3);
    assert(
      '[3.a.5] happy per_user 全 persisted',
      summary.per_user.every(p => p.persisted)
    );
    assert('[3.a.6] happy period_end 透传', summary.period_end === period_end);
    assert('[3.a.7] happy dry_run=false', summary.dry_run === false);
    assert(
      '[3.a.8] happy lookback_days 默认 90',
      summary.lookback_days === 90
    );
    assert(
      '[3.a.9] happy cron_run_id 默认含 prefix',
      summary.cron_run_id.startsWith('error_pattern_cron_2026-06-21_')
    );
    assert(
      '[3.a.10] happy upsert status=ok',
      upsertCalls.every(c => c.status === 'ok')
    );
    assert(
      '[3.a.11] happy upsert lookback_days=90 流入 row',
      upsertCalls.every(c => c.lookback_days === 90)
    );
    assert(
      '[3.a.12] happy cron_run_id 流入 metadata',
      upsertCalls.every(c => typeof c.cron_run_id === 'string' && (c.cron_run_id as string).startsWith('error_pattern_cron_'))
    );
  }

  // (b) skipped — records 不足 MIN_DATA_DAYS → service 走 skipped 路径
  {
    const period_end = '2026-06-21';
    const upsertCalls: Array<any> = [];
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        return [{ id: 20 }];
      },
    };
    const serviceSource = makeServiceDataSource({
      recsByUser: { 20: makeRecsForUser(MIN_DATA_DAYS - 1, 1) },
      upsertCalls,
    });
    const summary = await runWeeklyErrorPattern({
      period_end,
      cron_data_source: cronSource,
      service_data_source: serviceSource,
    });
    assert('[3.b.1] skipped skipped_count=1', summary.skipped_count === 1);
    assert('[3.b.2] skipped ok_count=0', summary.ok_count === 0);
    assert('[3.b.3] skipped upsertCalls 1 次 (留痕)', upsertCalls.length === 1);
    assert(
      '[3.b.4] skipped persisted_count=1',
      summary.persisted_count === 1
    );
    assert(
      '[3.b.5] skipped per_user status=skipped',
      summary.per_user[0].status === 'skipped'
    );
    assert(
      '[3.b.6] skipped reason=data_too_sparse',
      summary.per_user[0].reason === 'data_too_sparse'
    );
    assert(
      '[3.b.7] skipped row 含 status=skipped',
      upsertCalls[0].status === 'skipped'
    );
  }

  // (c) load throw — loadAttributionReports throw → service 返 failed + 留痕
  {
    const period_end = '2026-06-21';
    const upsertCalls: Array<any> = [];
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        return [{ id: 30 }];
      },
    };
    const serviceSource = makeServiceDataSource({
      loadThrow: true,
      upsertCalls,
    });
    const summary = await runWeeklyErrorPattern({
      period_end,
      cron_data_source: cronSource,
      service_data_source: serviceSource,
    });
    assert('[3.c.1] load throw failed_count=1', summary.failed_count === 1);
    assert(
      '[3.c.2] load throw per_user status=failed',
      summary.per_user[0].status === 'failed'
    );
    assert(
      '[3.c.3] load throw reason=load_threw',
      summary.per_user[0].reason === 'load_threw'
    );
    assert(
      '[3.c.4] load throw 仍留痕 upsertCalls=1',
      upsertCalls.length === 1
    );
    assert(
      '[3.c.5] load throw row 含 status=failed',
      upsertCalls[0].status === 'failed'
    );
  }

  // (d) explicit user_ids 覆盖 list — listActiveUsers 不被调
  {
    const period_end = '2026-06-21';
    let listCalled = false;
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        listCalled = true;
        return [{ id: 999 }];
      },
    };
    const serviceSource = makeServiceDataSource({});
    const summary = await runWeeklyErrorPattern({
      period_end,
      user_ids: [41, 42, 43],
      cron_data_source: cronSource,
      service_data_source: serviceSource,
    });
    assert('[3.d.1] explicit ids 不调 listActiveUsers', listCalled === false);
    assert('[3.d.2] explicit ids total=3', summary.total_users === 3);
    assert('[3.d.3] explicit ids 全部 ok', summary.ok_count === 3);
    assert(
      '[3.d.4] explicit ids user_id 顺序保持',
      summary.per_user.map(p => p.user_id).join(',') === '41,42,43'
    );
  }

  // (e) listActiveUsers throw → 当空跑
  {
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        throw new Error('db down');
      },
    };
    const serviceSource = makeServiceDataSource({});
    const summary = await runWeeklyErrorPattern({
      period_end: '2026-06-21',
      cron_data_source: cronSource,
      service_data_source: serviceSource,
    });
    assert('[3.e.1] list throw total=0', summary.total_users === 0);
    assert('[3.e.2] list throw per_user=[]', summary.per_user.length === 0);
  }

  // (f) dry_run=true → summary.dry_run=true (cron-side 仍跑全 user)
  {
    const period_end = '2026-06-21';
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        return [{ id: 60 }];
      },
    };
    const serviceSource = makeServiceDataSource({});
    const summary = await runWeeklyErrorPattern({
      period_end,
      dry_run: true,
      cron_data_source: cronSource,
      service_data_source: serviceSource,
    });
    assert('[3.f.1] dry_run summary.dry_run=true', summary.dry_run === true);
    assert('[3.f.2] dry_run total=1', summary.total_users === 1);
    assert('[3.f.3] dry_run ok_count=1 (service-side 仍跑)', summary.ok_count === 1);
  }

  // (g) period_end + lookback_days 透传
  {
    const period_end = '2026-05-31';
    const upsertCalls: Array<any> = [];
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        return [{ id: 70 }];
      },
    };
    const serviceSource = makeServiceDataSource({ upsertCalls });
    const summary = await runWeeklyErrorPattern({
      period_end,
      lookback_days: 30,
      cron_data_source: cronSource,
      service_data_source: serviceSource,
    });
    assert('[3.g.1] period_end 透传 summary', summary.period_end === '2026-05-31');
    assert('[3.g.2] lookback_days 透传 summary', summary.lookback_days === 30);
    assert(
      '[3.g.3] lookback_days 流入 upsert row',
      upsertCalls[0].lookback_days === 30
    );
    assert('[3.g.4] period_end 流入 upsert row', upsertCalls[0].period_end === '2026-05-31');
  }

  // (h) cron_run_id explicit override
  {
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        return [{ id: 80 }];
      },
    };
    const upsertCalls: Array<any> = [];
    const summary = await runWeeklyErrorPattern({
      period_end: '2026-06-21',
      cron_run_id: 'manual_replay_20260621_001',
      cron_data_source: cronSource,
      service_data_source: makeServiceDataSource({ upsertCalls }),
    });
    assert(
      '[3.h.1] cron_run_id explicit override',
      summary.cron_run_id === 'manual_replay_20260621_001'
    );
    assert(
      '[3.h.2] cron_run_id 流入 upsert metadata',
      upsertCalls[0].cron_run_id === 'manual_replay_20260621_001'
    );
  }

  // (i) upsert 返 ok=false → status='failed' persisted=false → counted as failed
  {
    const period_end = '2026-06-21';
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        return [{ id: 90 }, { id: 91 }];
      },
    };
    let first = true;
    const serviceSource = makeServiceDataSource({
      upsertOk: () => {
        if (first) {
          first = false;
          return false;
        }
        return true;
      },
    });
    const summary = await runWeeklyErrorPattern({
      period_end,
      cron_data_source: cronSource,
      service_data_source: serviceSource,
    });
    // service aggregateForUser 在 upsertRes.ok=false 时返 status='failed' + persisted=false
    assert('[3.i.1] upsert fail failed_count=1', summary.failed_count === 1);
    assert('[3.i.2] upsert fail ok_count=1 (第 2 user)', summary.ok_count === 1);
    assert('[3.i.3] upsert fail persisted_count=1', summary.persisted_count === 1);
    assert(
      '[3.i.4] upsert fail per_user[0].status=failed',
      summary.per_user[0].status === 'failed'
    );
    assert(
      '[3.i.5] upsert fail per_user[1].status=ok',
      summary.per_user[1].status === 'ok' && summary.per_user[1].persisted === true
    );
  }

  // (j) explicit user_ids=[] → 跳过 listActiveUsers (preview)
  {
    let listCalled = false;
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        listCalled = true;
        return [{ id: 999 }];
      },
    };
    const summary = await runWeeklyErrorPattern({
      period_end: '2026-06-21',
      user_ids: [],
      cron_data_source: cronSource,
      service_data_source: makeServiceDataSource({}),
    });
    assert('[3.j.1] empty explicit ids 不调 listActiveUsers', listCalled === false);
    assert('[3.j.2] empty explicit ids total=0', summary.total_users === 0);
    assert('[3.j.3] empty explicit ids per_user=[]', summary.per_user.length === 0);
  }

  // (k) explicit user_ids 过滤 NaN/0/负数
  {
    const cronSource: ErrorPatternCronDataSource = {
      async listActiveUsers() {
        return [];
      },
    };
    const summary = await runWeeklyErrorPattern({
      period_end: '2026-06-21',
      user_ids: [50, 0, -1, NaN as any, 51],
      cron_data_source: cronSource,
      service_data_source: makeServiceDataSource({}),
    });
    assert('[3.k.1] 过滤后 total=2', summary.total_users === 2);
    assert(
      '[3.k.2] 过滤后 user_ids 正确',
      summary.per_user.map(p => p.user_id).join(',') === '50,51'
    );
  }

  // ---- [4] PRODUCTION DataSource factory ----------------------------------
  {
    const prod = createProductionErrorPatternCronDataSource();
    assert('[4.1] factory listActiveUsers fn', typeof prod.listActiveUsers === 'function');
    // 调一下不抛 (DB 不通时返 [])
    let listResult: any;
    try {
      listResult = await prod.listActiveUsers();
    } catch (e: any) {
      listResult = `THROW: ${e?.message}`;
    }
    assert(
      '[4.2] PRODUCTION listActiveUsers 不抛 (返数组)',
      Array.isArray(listResult)
    );
  }

  // ---- [5] META-GUARD fs+regex --------------------------------------------
  {
    const cronRegistrySrc = readFileSync(
      join(__dirname, '../../src/constants/cronRegistry.ts'),
      'utf-8'
    );
    assert(
      '[5.a.1] cronRegistry 含 WEEKLY_ERROR_PATTERN_AGGREGATE',
      /type:\s*'WEEKLY_ERROR_PATTERN_AGGREGATE'/.test(cronRegistrySrc)
    );
    assert(
      '[5.a.2] cronRegistry WEEKLY_ERROR_PATTERN 段 analytics + owner analytics',
      /WEEKLY_ERROR_PATTERN_AGGREGATE[\s\S]*?category:\s*'analytics'[\s\S]*?owner:\s*'analytics'/m.test(
        cronRegistrySrc
      )
    );
    assert(
      '[5.a.3] cronRegistry WEEKLY_ERROR_PATTERN 推荐 cron=周日 10:00',
      /WEEKLY_ERROR_PATTERN_AGGREGATE[\s\S]*?recommendedCron:\s*'0\s+10\s+\*\s+\*\s+0'/m.test(
        cronRegistrySrc
      )
    );

    const schedulerSrc = readFileSync(
      join(__dirname, '../../src/services/SchedulerService.ts'),
      'utf-8'
    );
    assert(
      '[5.b.1] SchedulerService 含 else-if WEEKLY_ERROR_PATTERN_AGGREGATE',
      /task\.type\s*===\s*'WEEKLY_ERROR_PATTERN_AGGREGATE'/.test(schedulerSrc)
    );
    assert(
      '[5.b.2] SchedulerService 含 require ErrorPatternCronRunner',
      /require\(['"][.\\/]+postmortem\/ErrorPatternCronRunner['"]\)/.test(schedulerSrc)
    );
    assert(
      '[5.b.3] SchedulerService WEEKLY_ERROR_PATTERN 段含 runWeeklyErrorPattern',
      /runWeeklyErrorPattern\s*\(/.test(schedulerSrc)
    );
    assert(
      '[5.b.4] SchedulerService WEEKLY_ERROR_PATTERN 段含 safeUpdateExecutionLog 写 result_summary',
      /WEEKLY_ERROR_PATTERN_AGGREGATE[\s\S]*?safeUpdateExecutionLog/m.test(schedulerSrc)
    );
    assert(
      '[5.b.5] SchedulerService WEEKLY_ERROR_PATTERN 日志标签',
      /\[WEEKLY_ERROR_PATTERN_AGGREGATE\]/.test(schedulerSrc)
    );
    assert(
      '[5.c.1] SchedulerService defaultTasks 含 WEEKLY_ERROR_PATTERN seed',
      /name:\s*['"]周度错误模式聚合['"][\s\S]*?type:\s*'WEEKLY_ERROR_PATTERN_AGGREGATE'/m.test(
        schedulerSrc
      )
    );
    assert(
      '[5.c.2] seed cron_expression=0 10 * * 0',
      /type:\s*'WEEKLY_ERROR_PATTERN_AGGREGATE'[\s\S]*?cron_expression:\s*['"]0\s+10\s+\*\s+\*\s+0['"]/m.test(
        schedulerSrc
      )
    );
    assert(
      '[5.c.3] seed parameters 含 lookback_days: 90',
      /type:\s*'WEEKLY_ERROR_PATTERN_AGGREGATE'[\s\S]*?lookback_days:\s*90/m.test(schedulerSrc)
    );
  }

  // ---- summary -------------------------------------------------------------
  console.log(`\nerror-pattern-cron: ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('TEST CRASHED:', err);
  process.exit(1);
});
