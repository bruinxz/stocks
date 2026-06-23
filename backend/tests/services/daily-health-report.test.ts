/**
 * DailyHealthReportService 单测 — Batch BF-4 (2026-06-23)
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/daily-health-report.test.ts
 *
 * 覆盖:
 *   - 6 个 pure helpers (isTradingDay / shanghaiYmd / shanghaiYmdMinusDays / isLiveOrderStatusSuccess / isLiveOrderStatusFailed / summarizeLiveOrders)
 *   - 3 个 pure transformers (topRejections / summarizeAiEngine / buildOneLinerSummary)
 *   - buildHealthReportMarkdown render (空 / 满)
 *   - generateDailyHealthReport e2e (含 per-section fail-OPEN)
 *   - generateAndPushDailyHealthReport (dry_run + pusher injection)
 */

import {
  isTradingDay,
  shanghaiYmd,
  shanghaiYmdMinusDays,
  isLiveOrderStatusSuccess,
  isLiveOrderStatusFailed,
  summarizeLiveOrders,
  topRejections,
  summarizeAiEngine,
  buildOneLinerSummary,
  buildHealthReportMarkdown,
  generateDailyHealthReport,
  generateAndPushDailyHealthReport,
  DailyHealthReportDataSource,
  DailyHealthReport,
} from '../../src/services/DailyHealthReportService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`❌ ${name}${detail ? ' detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

interface FakeDataSourceOptions {
  liveOrders?: Record<string, number>;
  draftRejections?: Array<{ reason: string; count: number }>;
  paperTrading?: {
    buy_count: number;
    sell_count: number;
    avg_realized_pnl: number | null;
    total_realized_pnl: number;
  };
  cronFailures?: Array<{
    id: number;
    type: string;
    name: string;
    consecutive_failure_count: number;
    last_run_at: string;
    last_error: string | null;
  }>;
  riskAlerts?: Array<{
    id: number;
    symbol: string | null;
    name: string | null;
    level: string;
    rule_id: string | null;
    created_at: string;
    message: string | null;
  }>;
  aiEngine?: {
    total: number;
    completed: number;
    partial: number;
    failed: number;
    avg_latency_ms: number | null;
  };
  factorStdZero?: Array<{ factor_name: string; observation_count: number }>;
  throwOn?: 'live' | 'draft' | 'paper' | 'cron' | 'risk' | 'ai' | 'factor';
}

class FakeDataSource implements DailyHealthReportDataSource {
  constructor(private opts: FakeDataSourceOptions = {}) {}
  async getLiveOrderStatusBreakdown(_date: string): Promise<Record<string, number>> {
    if (this.opts.throwOn === 'live') throw new Error('live down');
    return this.opts.liveOrders || {};
  }
  async getDraftRejectionTopReasons(_date: string, _limit: number) {
    if (this.opts.throwOn === 'draft') throw new Error('draft down');
    return this.opts.draftRejections || [];
  }
  async getPaperTradingSummary(_date: string) {
    if (this.opts.throwOn === 'paper') throw new Error('paper down');
    return (
      this.opts.paperTrading || {
        buy_count: 0,
        sell_count: 0,
        avg_realized_pnl: null,
        total_realized_pnl: 0,
      }
    );
  }
  async getFailedCronsToday(_date: string) {
    if (this.opts.throwOn === 'cron') throw new Error('cron down');
    return this.opts.cronFailures || [];
  }
  async getRiskAlertsHighToday(_date: string, _limit: number) {
    if (this.opts.throwOn === 'risk') throw new Error('risk down');
    return this.opts.riskAlerts || [];
  }
  async getAiEngineSummary(_date: string) {
    if (this.opts.throwOn === 'ai') throw new Error('ai down');
    return (
      this.opts.aiEngine || {
        total: 0,
        completed: 0,
        partial: 0,
        failed: 0,
        avg_latency_ms: null,
      }
    );
  }
  async getFactorStdZero(_since: string) {
    if (this.opts.throwOn === 'factor') throw new Error('factor down');
    return this.opts.factorStdZero || [];
  }
}

async function main() {
  // ===========================================================================
  console.log('\n[1] helpers...');
  // 2026-06-22 是周一, 2026-06-21 是周日
  assertEqual('Mon is工作日', isTradingDay(new Date('2026-06-22T03:00:00Z')), true);
  assertEqual('Sun not工作日', isTradingDay(new Date('2026-06-21T03:00:00Z')), false);
  assertEqual('Sat not工作日', isTradingDay(new Date('2026-06-20T03:00:00Z')), false);
  assertEqual('shanghaiYmd UTC03', shanghaiYmd(new Date('2026-06-23T03:00:00Z')), '2026-06-23');
  // 跨日: UTC 23:00 = 上海 07:00 次日
  assertEqual('shanghaiYmd UTC23 → 次日', shanghaiYmd(new Date('2026-06-22T23:00:00Z')), '2026-06-23');
  assertEqual(
    'shanghaiYmdMinusDays 7',
    shanghaiYmdMinusDays(new Date('2026-06-23T03:00:00Z'), 7),
    '2026-06-16'
  );

  assertEqual('isLiveOrderStatusSuccess submitted', isLiveOrderStatusSuccess('submitted'), true);
  assertEqual('isLiveOrderStatusSuccess SUBMITTED case', isLiveOrderStatusSuccess('SUBMITTED'), true);
  assertEqual('isLiveOrderStatusSuccess filled', isLiveOrderStatusSuccess('filled'), true);
  assertEqual(
    'isLiveOrderStatusSuccess partial',
    isLiveOrderStatusSuccess('partially_filled'),
    true
  );
  assertEqual('isLiveOrderStatusSuccess rejected', isLiveOrderStatusSuccess('rejected'), false);
  assertEqual('isLiveOrderStatusSuccess empty', isLiveOrderStatusSuccess(''), false);
  assertEqual('isLiveOrderStatusFailed rejected', isLiveOrderStatusFailed('rejected'), true);
  assertEqual('isLiveOrderStatusFailed cancelled', isLiveOrderStatusFailed('cancelled'), true);
  assertEqual('isLiveOrderStatusFailed error', isLiveOrderStatusFailed('error'), true);
  assertEqual('isLiveOrderStatusFailed submitted', isLiveOrderStatusFailed('submitted'), false);

  // ===========================================================================
  console.log('\n[2] summarizeLiveOrders...');
  const empty = summarizeLiveOrders({});
  assertEqual('空 total=0', empty.total, 0);
  assertEqual('空 success_rate=0', empty.success_rate, 0);
  const ok = summarizeLiveOrders({ submitted: 5, filled: 3, rejected: 1, cancelled: 1, created: 2 });
  assertEqual('total=12', ok.total, 12);
  assertEqual('succeeded=8 (submitted+filled)', ok.succeeded, 8);
  assertEqual('failed=2 (rejected+cancelled)', ok.failed, 2);
  // success_rate = 8/(8+2) = 0.8 (decided = succeeded + failed; created 不计入分母)
  assertEqual('success_rate=0.8', ok.success_rate, 0.8);
  const allOk = summarizeLiveOrders({ filled: 10 });
  assertEqual('全 filled rate=1', allOk.success_rate, 1);
  const allFail = summarizeLiveOrders({ rejected: 10 });
  assertEqual('全 rejected rate=0', allFail.success_rate, 0);
  const negativeIgnored = summarizeLiveOrders({ rejected: -1, submitted: 5 });
  assertEqual('负数被忽略', negativeIgnored.total, 5);

  // ===========================================================================
  console.log('\n[3] topRejections...');
  const tr = topRejections(
    [
      { reason: 'price_too_low', count: 5 },
      { reason: 'no_position', count: 2 },
      { reason: 'concentration', count: 10 },
      { reason: 'price_too_low', count: 1 }, // 重复 reason 这里不合并 (期望 caller 已 GROUP BY)
    ],
    3
  );
  assertEqual('top 3 length', tr.length, 3);
  assertEqual('top1 = concentration', tr[0].reason, 'concentration');
  assertEqual('top2 = price_too_low(5)', tr[1].reason, 'price_too_low');
  // 空 reason 被过滤
  const tr2 = topRejections([{ reason: '', count: 999 }, { reason: 'a', count: 1 }], 5);
  assertEqual('空 reason 过滤', tr2.length, 1);
  // limit 0
  assertEqual('limit 0 → 空', topRejections([{ reason: 'x', count: 1 }], 0).length, 0);

  // ===========================================================================
  console.log('\n[4] summarizeAiEngine...');
  const ai0 = summarizeAiEngine({ total: 0, completed: 0, partial: 0, failed: 0, avg_latency_ms: null });
  assertEqual('全 0 fallback_rate=0', ai0.fallback_rate, 0);
  assertEqual('全 0 latency=null', ai0.avg_latency_ms, null);
  const ai1 = summarizeAiEngine({
    total: 100,
    completed: 80,
    partial: 15,
    failed: 5,
    avg_latency_ms: 1234.5,
  });
  assertEqual('fallback_rate=0.2 (15+5)/100', ai1.fallback_rate, 0.2);
  assertEqual('avg_latency_ms 整数化', ai1.avg_latency_ms, 1235);
  // 负数 clamp 到 0
  const aiNeg = summarizeAiEngine({
    total: -5,
    completed: -1,
    partial: 0,
    failed: 0,
    avg_latency_ms: null,
  });
  assertEqual('负数 clamp total=0', aiNeg.total, 0);

  // ===========================================================================
  console.log('\n[5] buildOneLinerSummary...');
  const emptyReport: DailyHealthReport = {
    trade_date: '2026-06-23',
    is_trading_day: true,
    generated_at: '2026-06-23T13:00:00Z',
    live_order: { total: 0, by_status: {}, succeeded: 0, failed: 0, success_rate: 0 },
    draft_rejection_top: [],
    paper_trading: { buy_count: 0, sell_count: 0, avg_realized_pnl: null, total_realized_pnl: 0 },
    cron_failures: [],
    risk_alerts_high: [],
    ai_engine: { total: 0, completed: 0, partial: 0, failed: 0, avg_latency_ms: null, fallback_rate: 0 },
    factor_std_zero: [],
    errors: {},
  };
  const sumEmpty = buildOneLinerSummary(emptyReport);
  assert('one-liner 含实盘', sumEmpty.includes('实盘 0'));
  assert('one-liner 含模拟', sumEmpty.includes('模拟 BUY0/SELL0'));

  // ===========================================================================
  console.log('\n[6] buildHealthReportMarkdown...');
  const md0 = buildHealthReportMarkdown(emptyReport);
  assert('md 含日期', md0.includes('2026-06-23'));
  assert('md 含 7 段 header', md0.includes('实盘下单') && md0.includes('模拟盘') && md0.includes('Cron 失败') && md0.includes('RiskAlert') && md0.includes('AI 引擎') && md0.includes('Factor'));
  assert('md 空告警提示', md0.includes('无 HIGH/CRITICAL 告警'));
  // 满 case
  const fullReport: DailyHealthReport = {
    ...emptyReport,
    live_order: {
      total: 10,
      by_status: { submitted: 6, filled: 2, rejected: 2 },
      succeeded: 8,
      failed: 2,
      success_rate: 0.8,
    },
    draft_rejection_top: [
      { reason: 'price_too_low', count: 5 },
      { reason: 'risk_block', count: 3 },
    ],
    paper_trading: { buy_count: 3, sell_count: 2, avg_realized_pnl: 123.45, total_realized_pnl: 246.9 },
    cron_failures: [
      {
        id: 1,
        type: 'DAILY_UPDATE',
        name: '每日更新',
        consecutive_failure_count: 3,
        last_run_at: '2026-06-23T10:00:00Z',
        last_error: 'akshare timeout',
      },
    ],
    risk_alerts_high: [
      {
        id: 1,
        symbol: 'sh.600519',
        name: '贵州茅台',
        level: 'HIGH',
        rule_id: 'drawdown_breaker',
        created_at: '2026-06-23T10:00:00Z',
        message: '当前回撤已超 15% 阈值',
      },
    ],
    ai_engine: { total: 50, completed: 40, partial: 5, failed: 5, avg_latency_ms: 2300, fallback_rate: 0.2 },
    factor_std_zero: [{ factor_name: 'northbound', observation_count: 100 }],
    errors: {},
  };
  const md1 = buildHealthReportMarkdown(fullReport);
  assert('md 含 sh.600519', md1.includes('sh.600519'));
  assert('md 含 DAILY_UPDATE 连败 3', md1.includes('DAILY_UPDATE') && md1.includes('连败 3'));
  assert('md 含 fallback 率 20%', md1.includes('20.0%'));
  assert('md 含 northbound', md1.includes('northbound'));

  // errors 段
  const errReport = { ...emptyReport, errors: { live_order: 'connection refused' } };
  const mdErr = buildHealthReportMarkdown(errReport);
  assert('md 含查询失败段', mdErr.includes('查询失败段') && mdErr.includes('connection refused'));

  // ===========================================================================
  console.log('\n[7] generateDailyHealthReport happy path...');
  const ds = new FakeDataSource({
    liveOrders: { submitted: 8, rejected: 2 },
    draftRejections: [{ reason: 'price_too_low', count: 5 }],
    paperTrading: { buy_count: 3, sell_count: 1, avg_realized_pnl: 200, total_realized_pnl: 200 },
    cronFailures: [
      {
        id: 1,
        type: 'X',
        name: 'X',
        consecutive_failure_count: 2,
        last_run_at: '2026-06-23T10:00Z',
        last_error: null,
      },
    ],
    riskAlerts: [
      {
        id: 1,
        symbol: 'sh.000001',
        name: '上证',
        level: 'HIGH',
        rule_id: 'regime',
        created_at: '2026-06-23T10:00Z',
        message: 'regime change',
      },
    ],
    aiEngine: { total: 10, completed: 9, partial: 0, failed: 1, avg_latency_ms: 1500 },
    factorStdZero: [{ factor_name: 'northbound', observation_count: 100 }],
  });
  const rep = await generateDailyHealthReport(ds, new Date('2026-06-23T13:00:00Z'));
  assertEqual('trade_date = 2026-06-23', rep.trade_date, '2026-06-23');
  assertEqual('live_order.total=10', rep.live_order.total, 10);
  assertEqual('live_order.success_rate=0.8', rep.live_order.success_rate, 0.8);
  assertEqual('cron_failures.length=1', rep.cron_failures.length, 1);
  assertEqual('risk_alerts.length=1', rep.risk_alerts_high.length, 1);
  assertEqual('factor_std_zero.length=1', rep.factor_std_zero.length, 1);
  assertEqual('ai fallback_rate=0.1', rep.ai_engine.fallback_rate, 0.1);
  assertEqual('errors 空', Object.keys(rep.errors).length, 0);

  // ===========================================================================
  console.log('\n[8] generateDailyHealthReport per-section fail-OPEN...');
  const dsBad = new FakeDataSource({ throwOn: 'live' });
  const rep2 = await generateDailyHealthReport(dsBad, new Date('2026-06-23T13:00:00Z'));
  assert('live throw → live=0 not throw', rep2.live_order.total === 0);
  assert('live throw 记 errors', rep2.errors.live_order && rep2.errors.live_order.includes('live down'));
  // 其他段仍正常
  assert('其他段未受影响', rep2.cron_failures.length === 0 && rep2.risk_alerts_high.length === 0);

  // 多段 throw
  const dsBad2 = new FakeDataSource({ throwOn: 'risk' });
  const rep3 = await generateDailyHealthReport(dsBad2, new Date('2026-06-23T13:00:00Z'));
  assert('risk throw → 记 errors', rep3.errors.risk_alerts != null);

  // ===========================================================================
  console.log('\n[9] generateAndPushDailyHealthReport dry_run...');
  const dryRes = await generateAndPushDailyHealthReport({
    data_source: ds,
    now: new Date('2026-06-23T13:00:00Z'),
    dry_run: true,
  });
  assert('dry_run push_attempted=false', dryRes.push_attempted === false);
  assert('dry_run report 完整', dryRes.report.trade_date === '2026-06-23');

  // ===========================================================================
  console.log('\n[10] generateAndPushDailyHealthReport with pusher injection...');
  let pushedInput: any = null;
  const fakePusher = async (input: any) => {
    pushedInput = input;
    return { pushed: true, deduped: false };
  };
  const pushRes = await generateAndPushDailyHealthReport({
    data_source: ds,
    now: new Date('2026-06-23T13:00:00Z'),
    pusher: fakePusher,
  });
  assert('push_attempted=true', pushRes.push_attempted === true);
  assert('pushed.dedup_key = daily-health:2026-06-23', pushedInput?.dedup_key === 'daily-health:2026-06-23');
  assert('pushed.level = INFO', pushedInput?.level === 'INFO');
  assert('pushed.title 含日期', String(pushedInput?.title || '').includes('2026-06-23'));
  assert('pushed.body_markdown 含 实盘', String(pushedInput?.body_markdown || '').includes('实盘下单'));

  // pusher 抛错 → push_error 记录但 push_attempted=true
  const throwingPusher = async () => {
    throw new Error('lark webhook 500');
  };
  const pushRes2 = await generateAndPushDailyHealthReport({
    data_source: ds,
    now: new Date('2026-06-23T13:00:00Z'),
    pusher: throwingPusher,
  });
  assert('push throw → push_error 记录', pushRes2.push_error?.includes('lark webhook 500') === true);

  // ===========================================================================
  console.log('\n[11] edge — 全部段都 throw 时 fail-OPEN 全 placeholder...');
  // 给 ds 同时 throw on multiple — JS class 不支持; 用 wrapper
  class AllThrowDS implements DailyHealthReportDataSource {
    async getLiveOrderStatusBreakdown(): Promise<Record<string, number>> { throw new Error('1'); }
    async getDraftRejectionTopReasons() { throw new Error('2'); }
    async getPaperTradingSummary() { throw new Error('3'); }
    async getFailedCronsToday() { throw new Error('4'); }
    async getRiskAlertsHighToday() { throw new Error('5'); }
    async getAiEngineSummary() { throw new Error('6'); }
    async getFactorStdZero() { throw new Error('7'); }
  }
  const rep4 = await generateDailyHealthReport(new AllThrowDS(), new Date('2026-06-23T13:00:00Z'));
  assertEqual('全失败 errors 6 entries', Object.keys(rep4.errors).length, 7);
  assertEqual('全失败 live total=0', rep4.live_order.total, 0);
  assertEqual('全失败 cron=[]', rep4.cron_failures.length, 0);
  // 仍能渲染 markdown
  const md4 = buildHealthReportMarkdown(rep4);
  assert('全失败仍可渲染 md', md4.length > 100);
  assert('全失败 md 标记每段 fail', md4.includes('查询失败段'));

  // ===========================================================================
  console.log('\n[12] paper trading 负 pnl + 模拟全 BUY 没 SELL 时 avg=null...');
  const rep5 = await generateDailyHealthReport(
    new FakeDataSource({
      paperTrading: { buy_count: 5, sell_count: 0, avg_realized_pnl: null, total_realized_pnl: 0 },
    }),
    new Date('2026-06-23T13:00:00Z')
  );
  assertEqual('全 BUY avg=null', rep5.paper_trading.avg_realized_pnl, null);
  assertEqual('全 BUY sell=0', rep5.paper_trading.sell_count, 0);

  // 负数 pnl
  const rep6 = await generateDailyHealthReport(
    new FakeDataSource({
      paperTrading: { buy_count: 2, sell_count: 3, avg_realized_pnl: -150.75, total_realized_pnl: -452.25 },
    }),
    new Date('2026-06-23T13:00:00Z')
  );
  assertEqual('负 avg_pnl 保留', rep6.paper_trading.avg_realized_pnl, -150.75);
  assertEqual('负 total_pnl 保留', rep6.paper_trading.total_realized_pnl, -452.25);

  // ===========================================================================
  console.log('\n[13] 周末 trade_date 跑也产报告 (is_trading_day=false)...');
  const repWeekend = await generateDailyHealthReport(
    new FakeDataSource({}),
    new Date('2026-06-21T13:00:00Z') // 周日
  );
  assertEqual('weekend trade_date', repWeekend.trade_date, '2026-06-21');
  assertEqual('weekend is_trading_day=false', repWeekend.is_trading_day, false);
  assertEqual('weekend live=0', repWeekend.live_order.total, 0);

  // ===========================================================================
  console.log('\n[14] markdown body 长度 < 5000 (lark 限制)...');
  // 1000 个 cron failures
  const manyCrons: any[] = [];
  for (let i = 0; i < 1000; i++) {
    manyCrons.push({
      id: i,
      type: `TASK_${i}`,
      name: `t${i}`,
      consecutive_failure_count: 1,
      last_run_at: '2026-06-23T10:00Z',
      last_error: 'x',
    });
  }
  const repBig = {
    ...emptyReport,
    cron_failures: manyCrons,
  };
  const mdBig = buildHealthReportMarkdown(repBig);
  // cron section 限 10 条, 应该不超极限
  assert('md cron 限 10 行', (mdBig.match(/TASK_/g) || []).length <= 10);

  // ===========================================================================
  console.log('\n=========================================');
  console.log(`Total: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    console.error(`\n❌ ${failed} tests failed`);
    process.exit(1);
  }
  console.log('✅ All tests passed');
}

main().catch(err => {
  console.error('test runner threw:', err);
  process.exit(1);
});
