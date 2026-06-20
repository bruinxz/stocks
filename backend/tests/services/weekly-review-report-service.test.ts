/**
 * WeeklyReviewReportService 单元测试 (US-065 邮件周度策略复盘报告)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/weekly-review-report-service.test.ts
 *
 * 完全脱离 DB / 网络：注入 fake WeeklyReviewDataSource。
 *
 * 覆盖维度（参考 earnings-forecast-watcher / daily-trading-digest 测试模板）：
 *   - 常量冻结 (WEEKLY_REVIEW_STATUS)
 *   - 纯函数：
 *     - shouldSendWeeklyReviewForUser（4 路径：通道关 / weekly_review 关 / 缺地址 / 通过）
 *     - computePrevWeekRange（周一 / 周二 / 周日 reference / 跨月 / 跨年 / 非法日期兜底）
 *     - computeWeeklyPnL（empty / single / multi / start=0 / pct=null）
 *     - aggregateIndustryContribution（仅 SELL / 忽略 BUY / industry 缺失走 __UNKNOWN__ / 排序 + tie-break）
 *     - aggregateSymbolContribution（top winners desc / top losers asc / 仅 SELL / 仅 >0 或 <0 / cap）
 *     - buildEquityCurveSparkline（empty / single / flat / up / down / 边界 width/height）
 *     - buildHeuristicWeeklyOpinion（pct null / 大涨 / 小涨 / 平 / 小回 / 大回 / 行业 + 个股 + 事件描述）
 *     - buildReportId（PR rand4 padding / 端到端格式）
 *     - buildWeeklyReviewEmail（subject 含 PnL / sparkline 嵌入 / 表格行渲染 / 关注事件 / AI opinion）
 *     - formatMoney（千分位 / 小数 / 负数 / 0 / NaN）
 *   - service.sendWeeklyReviewReports() e2e:
 *     - 无 user → scanned=0；
 *     - listEligibleUsers throw → 顶层 catch → 返回空 per_user；
 *     - user weekly_review off → skip with reason；
 *     - user 邮件通道关 → skip with reason；
 *     - user 缺地址 → skip with reason；
 *     - user 无 portfolio → skip；
 *     - dry_run=true → status='sent' sent=false skip_reason='dry_run'；
 *     - sendEmail throw → fail-OPEN → status='failed'；
 *     - sendEmail returns success=false → status='partial'；
 *     - sendEmail returns success=true → status='sent' sent=true；
 *     - sendEmail returns skipped → status='skipped'；
 *     - sendEmail uses correct address from config；
 *     - generateAIWeeklyOpinion throw → 兜底 heuristic 不阻塞；
 *     - loadWeeklySnapshots / loadWeeklyTrades / loadStockMetadata / loadUpcomingEvents 任一 throw 不阻塞；
 *     - 多 user：A 成功 + B 失败 → per_user 各自独立 status；
 *   - service.updateEmailConfig() 单测（DB-stub via fake User mock 难度大，跳过）
 *
 * EmailNotificationService pure helpers 也一并覆盖：
 *   - readSmtpConfigFromEnv（缺 HOST/USER/PASS 任一返回 null，全有 + 默认 port=587）
 *   - isEmailDisabledByEnv（true/1/yes/on / false 默认）
 *   - isValidEmailAddress（合法 / 无 @ / 双 @ / 空格 / 长度边界 / 缺域名 . / 控制字符）
 *   - resetTransporter（不抛 + cache 重置）
 *   - EmailNotificationService.isEnabled / sendEmail：env 禁用 / 缺 SMTP / 缺 buildEmail / payload 非法 / buildEmail throw / EmailPayload 非法 / 注入 transporter happy path / transporter throw fail-OPEN
 */

import {
  WeeklyReviewReportService,
  WeeklyReviewDataSource,
  WEEKLY_REVIEW_STATUS,
  shouldSendWeeklyReviewForUser,
  computePrevWeekRange,
  computeWeeklyPnL,
  aggregateIndustryContribution,
  aggregateStrategyContribution,
  strategyLabel,
  aggregateSymbolContribution,
  buildEquityCurveSparkline,
  buildHeuristicWeeklyOpinion,
  buildReportId,
  buildWeeklyReviewEmail,
  formatMoney,
  WeeklyReviewPayload,
  IndustryContributionRow,
  StrategyContributionRow,
  StrategyTradeRow,
  SymbolContributionRow,
  WeeklyEquityPoint,
  UpcomingEventRow,
  AIWeeklyOpinion,
  PrevWeekRange,
} from '../../src/services/WeeklyReviewReportService';
import {
  EmailNotificationService,
  EmailNotificationSendResult,
  readSmtpConfigFromEnv,
  isEmailDisabledByEnv,
  isValidEmailAddress,
  resetTransporter,
} from '../../src/services/EmailNotificationService';
import {
  NotificationChannelsConfig,
  DEFAULT_NOTIFICATION_CONFIG,
} from '../../src/services/DailyTradingDigestService';

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

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function makeConfig(patch: Partial<NotificationChannelsConfig> = {}): NotificationChannelsConfig {
  // deep-clone default + patch；email channel 关键字段必须明示 enabled+address+weekly_review
  const base = JSON.parse(JSON.stringify(DEFAULT_NOTIFICATION_CONFIG));
  if (patch.email) base.email = { ...base.email, ...patch.email };
  if (patch.feishu) base.feishu = { ...base.feishu, ...patch.feishu };
  if (patch.wechat) base.wechat = { ...base.wechat, ...patch.wechat };
  return base;
}

// ---------------------------------------------------------------------------
// Fake DataSource state
// ---------------------------------------------------------------------------

interface FakeState {
  users?: Array<{
    user_id: number;
    username: string;
    config: NotificationChannelsConfig;
  }>;
  portfolios?: Record<number, any | null>;
  snapshots?: Record<number, WeeklyEquityPoint[]>;
  trades?: Record<number, any[]>;
  /** US-087 PM-011 — portfolio_id → Map<trade_id, strategy_key> */
  tradeStrategyMap?: Record<number, Map<number, string>>;
  stockMeta?: Map<string, { name: string; industry: string | null }>;
  upcomingEvents?: UpcomingEventRow[];
  aiOpinion?: AIWeeklyOpinion;
  sendEmailResults?: EmailNotificationSendResult[];
  /** Throw spec: 任一 method 设置为 true → throw new Error('FAKE') */
  throwOn?: Partial<{
    listEligibleUsers: boolean;
    loadPortfolio: boolean;
    loadWeeklySnapshots: boolean;
    loadWeeklyTrades: boolean;
    loadTradeStrategyMap: boolean;
    loadStockMetadata: boolean;
    loadUpcomingEvents: boolean;
    generateAIWeeklyOpinion: boolean;
    sendEmail: boolean;
  }>;
  /** Spy: 记录 sendEmail 调用 */
  sendEmailCalls?: Array<{ to: string; payload: WeeklyReviewPayload }>;
}

function makeFakeDataSource(state: FakeState): WeeklyReviewDataSource {
  state.sendEmailCalls = [];
  let sendCallIdx = 0;
  return {
    async listEligibleUsers(_opts) {
      if (state.throwOn?.listEligibleUsers) throw new Error('FAKE listEligibleUsers');
      return state.users || [];
    },
    async loadPortfolio(user_id) {
      if (state.throwOn?.loadPortfolio) throw new Error('FAKE loadPortfolio');
      const v = state.portfolios?.[user_id];
      return v === undefined ? null : v;
    },
    async loadWeeklySnapshots(portfolio_id, _start, _end) {
      if (state.throwOn?.loadWeeklySnapshots) throw new Error('FAKE loadWeeklySnapshots');
      return state.snapshots?.[portfolio_id] || [];
    },
    async loadWeeklyTrades(portfolio_id, _start, _end) {
      if (state.throwOn?.loadWeeklyTrades) throw new Error('FAKE loadWeeklyTrades');
      return (state.trades?.[portfolio_id] || []) as any;
    },
    async loadTradeStrategyMap(portfolio_id, _trade_ids) {
      if (state.throwOn?.loadTradeStrategyMap) throw new Error('FAKE loadTradeStrategyMap');
      return state.tradeStrategyMap?.[portfolio_id] || new Map<number, string>();
    },
    async loadStockMetadata(_symbols) {
      if (state.throwOn?.loadStockMetadata) throw new Error('FAKE loadStockMetadata');
      return state.stockMeta || new Map();
    },
    async loadUpcomingEvents(_symbols, _from, _to) {
      if (state.throwOn?.loadUpcomingEvents) throw new Error('FAKE loadUpcomingEvents');
      return state.upcomingEvents || [];
    },
    async generateAIWeeklyOpinion(_payload) {
      if (state.throwOn?.generateAIWeeklyOpinion) throw new Error('FAKE generateAIWeeklyOpinion');
      return (
        state.aiOpinion || {
          source: 'heuristic',
          headline: 'FAKE',
          paragraphs: [],
        }
      );
    },
    async sendEmail(payload, to) {
      state.sendEmailCalls!.push({ to, payload });
      if (state.throwOn?.sendEmail) throw new Error('FAKE sendEmail');
      const arr = state.sendEmailResults || [];
      const r = arr[Math.min(sendCallIdx, arr.length - 1)] || { success: true };
      sendCallIdx += 1;
      return r;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

function testConstantsFrozen(): void {
  assertEqual('WEEKLY_REVIEW_STATUS.SENT', WEEKLY_REVIEW_STATUS.SENT, 'sent');
  assertEqual('WEEKLY_REVIEW_STATUS.SKIPPED', WEEKLY_REVIEW_STATUS.SKIPPED, 'skipped');
  assertEqual('WEEKLY_REVIEW_STATUS.FAILED', WEEKLY_REVIEW_STATUS.FAILED, 'failed');
  assertEqual('WEEKLY_REVIEW_STATUS.PARTIAL', WEEKLY_REVIEW_STATUS.PARTIAL, 'partial');
  let frozenOk = false;
  try {
    (WEEKLY_REVIEW_STATUS as any).SENT = 'foo';
    frozenOk = WEEKLY_REVIEW_STATUS.SENT === 'sent';
  } catch {
    frozenOk = true;
  }
  assert('WEEKLY_REVIEW_STATUS frozen', frozenOk);
}

function testShouldSendWeeklyReviewForUser(): void {
  const cfgOff = makeConfig({ email: { enabled: false, address: 'a@b.com', weekly_review: true } as any });
  const r1 = shouldSendWeeklyReviewForUser(cfgOff);
  assertEqual('email 通道关', r1.shouldSend, false);
  assert('email 通道关 reason', !!r1.reason && r1.reason.includes('email'));

  const cfgWeeklyOff = makeConfig({
    email: { enabled: true, address: 'a@b.com', weekly_review: false } as any,
  });
  const r2 = shouldSendWeeklyReviewForUser(cfgWeeklyOff);
  assertEqual('weekly_review 关', r2.shouldSend, false);
  assert('weekly_review 关 reason', !!r2.reason && r2.reason.includes('weekly'));

  const cfgNoAddr = makeConfig({
    email: { enabled: true, address: '', weekly_review: true } as any,
  });
  const r3 = shouldSendWeeklyReviewForUser(cfgNoAddr);
  assertEqual('缺地址', r3.shouldSend, false);
  assert('缺地址 reason', !!r3.reason && r3.reason.includes('地址'));

  const cfgOk = makeConfig({
    email: { enabled: true, address: 'a@b.com', weekly_review: true } as any,
  });
  const r4 = shouldSendWeeklyReviewForUser(cfgOk);
  assertEqual('通过', r4.shouldSend, true);
}

function testComputePrevWeekRange(): void {
  // 2026-06-08 周一 → 上周一 = 2026-06-01 / 上周日 = 2026-06-07
  const r1 = computePrevWeekRange('2026-06-08');
  assertEqual('Mon ref → prev Monday', r1.start_date, '2026-06-01');
  assertEqual('Mon ref → prev Sunday', r1.end_date, '2026-06-07');
  assertEqual('Mon ref → week_id format', r1.week_id, '2026-W23');

  // 2026-06-09 周二 → 同上周
  const r2 = computePrevWeekRange('2026-06-09');
  assertEqual('Tue ref → prev Monday', r2.start_date, '2026-06-01');
  assertEqual('Tue ref → prev Sunday', r2.end_date, '2026-06-07');

  // 2026-06-07 周日 → 上周一 = 2026-05-25 / 上周日 = 2026-05-31
  const r3 = computePrevWeekRange('2026-06-07');
  assertEqual('Sun ref → prev Monday', r3.start_date, '2026-05-25');
  assertEqual('Sun ref → prev Sunday', r3.end_date, '2026-05-31');

  // 跨年 — 2026-01-05 周一 → 上周一 = 2025-12-29 / 上周日 = 2026-01-04
  const r4 = computePrevWeekRange('2026-01-05');
  assertEqual('Cross-year start_date', r4.start_date, '2025-12-29');
  assertEqual('Cross-year end_date', r4.end_date, '2026-01-04');

  // 非法日期 → 兜底 (不抛)
  const r5 = computePrevWeekRange('not-a-date');
  assert('Invalid date 不抛', typeof r5.start_date === 'string' && r5.start_date.length === 10);
}

function testComputeWeeklyPnL(): void {
  // 空
  const r1 = computeWeeklyPnL([]);
  assertEqual('empty start', r1.start_value, 0);
  assertEqual('empty end', r1.end_value, 0);
  assertEqual('empty pnl', r1.pnl_amount, 0);
  assertEqual('empty pct', r1.pnl_pct, null);

  // 单点 — start == end，pct = 0
  const r2 = computeWeeklyPnL([{ date: '2026-06-01', total_value: 100000 }]);
  assertEqual('single start', r2.start_value, 100000);
  assertEqual('single end', r2.end_value, 100000);
  assertEqual('single pnl', r2.pnl_amount, 0);
  assertEqual('single pct', r2.pnl_pct, 0);

  // 多点 — 上涨
  const r3 = computeWeeklyPnL([
    { date: '2026-06-01', total_value: 100000 },
    { date: '2026-06-02', total_value: 102000 },
    { date: '2026-06-03', total_value: 103000 },
  ]);
  assertEqual('multi pnl', r3.pnl_amount, 3000);
  assertEqual('multi pct', r3.pnl_pct, 3);

  // start 为 0 → pct=null
  const r4 = computeWeeklyPnL([
    { date: '2026-06-01', total_value: 0 },
    { date: '2026-06-02', total_value: 1000 },
  ]);
  assertEqual('start=0 pct=null', r4.pnl_pct, null);

  // 下跌
  const r5 = computeWeeklyPnL([
    { date: '2026-06-01', total_value: 100000 },
    { date: '2026-06-07', total_value: 95000 },
  ]);
  assertEqual('down pnl', r5.pnl_amount, -5000);
  assertEqual('down pct', r5.pnl_pct, -5);
}

function testAggregateIndustryContribution(): void {
  const meta = new Map<string, { name: string; industry: string | null }>([
    ['600519.SH', { name: '茅台', industry: '白酒' }],
    ['000858.SZ', { name: '五粮液', industry: '白酒' }],
    ['000725.SZ', { name: '京东方A', industry: '半导体' }],
    ['UNKNOWN.X', { name: '未知股', industry: null }],
  ]);

  // 仅 SELL trade 才被聚合；BUY 忽略；未知 industry → __UNKNOWN__
  const trades = [
    { symbol: '600519.SH', direction: 'SELL', realized_pnl: 1000 },
    { symbol: '600519.SH', direction: 'BUY', realized_pnl: 0 }, // 忽略
    { symbol: '000858.SZ', direction: 'SELL', realized_pnl: 500 },
    { symbol: '000725.SZ', direction: 'SELL', realized_pnl: -200 },
    { symbol: 'UNKNOWN.X', direction: 'SELL', realized_pnl: -100 },
  ] as any[];

  const result = aggregateIndustryContribution(trades, meta);
  // 排序：白酒 (+1500) > 半导体 (-200) > __UNKNOWN__ (-100)？
  // 注意排序按 realized_pnl 降序 + industry 字母升序 tie-break
  assertEqual('industry count', result.length, 3);
  assertEqual('top industry', result[0].industry, '白酒');
  assertEqual('top realized_pnl', result[0].realized_pnl, 1500);
  assertEqual('top trade_count', result[0].trade_count, 2);
  assert(
    'top symbols 含两个',
    result[0].symbols.length === 2 &&
      result[0].symbols.includes('600519.SH') &&
      result[0].symbols.includes('000858.SZ')
  );
  // -100 > -200，所以 __UNKNOWN__ 在前
  assertEqual('second industry', result[1].industry, '__UNKNOWN__');
  assertEqual('second pnl', result[1].realized_pnl, -100);
  assertEqual('third industry', result[2].industry, '半导体');
  assertEqual('third pnl', result[2].realized_pnl, -200);

  // 完全空
  const empty = aggregateIndustryContribution([], meta);
  assertEqual('empty industry contrib', empty.length, 0);
}

function testAggregateSymbolContribution(): void {
  const meta = new Map<string, { name: string; industry: string | null }>([
    ['600519.SH', { name: '茅台', industry: '白酒' }],
    ['000858.SZ', { name: '五粮液', industry: '白酒' }],
    ['000725.SZ', { name: '京东方A', industry: '半导体' }],
    ['002475.SZ', { name: '立讯精密', industry: '消费电子' }],
  ]);

  const trades = [
    { symbol: '600519.SH', direction: 'SELL', realized_pnl: 2000, name: '茅台' },
    { symbol: '000858.SZ', direction: 'SELL', realized_pnl: 1000, name: '五粮液' },
    { symbol: '000725.SZ', direction: 'SELL', realized_pnl: -500, name: '京东方A' },
    { symbol: '002475.SZ', direction: 'SELL', realized_pnl: -200, name: '立讯精密' },
    { symbol: '002475.SZ', direction: 'BUY', realized_pnl: 0, name: '立讯精密' }, // 忽略
  ] as any[];

  // Top winners (desc) — 只保留 > 0
  const winners = aggregateSymbolContribution(trades, meta, 'desc', 5);
  assertEqual('winners len', winners.length, 2);
  assertEqual('top winner', winners[0].symbol, '600519.SH');
  assertEqual('top winner pnl', winners[0].realized_pnl, 2000);
  assertEqual('top winner name', winners[0].name, '茅台');
  assertEqual('top winner industry', winners[0].industry, '白酒');

  // Top losers (asc) — 只保留 < 0
  const losers = aggregateSymbolContribution(trades, meta, 'asc', 5);
  assertEqual('losers len', losers.length, 2);
  assertEqual('top loser', losers[0].symbol, '000725.SZ');
  assertEqual('top loser pnl', losers[0].realized_pnl, -500);

  // limit cap
  const cap = aggregateSymbolContribution(trades, meta, 'desc', 1);
  assertEqual('cap to 1', cap.length, 1);
  assertEqual('cap top', cap[0].symbol, '600519.SH');
}

// ---------------------------------------------------------------------------
// US-087 PM-011 — strategy_contribution
// ---------------------------------------------------------------------------

function testStrategyLabel(): void {
  // 已知枚举 → 中文
  assertEqual('quant 标签', strategyLabel('quant_recommendation'), '量化推荐');
  assertEqual('tradingagents 标签', strategyLabel('tradingagents'), 'TradingAgents');
  assertEqual('daily_screener 标签', strategyLabel('daily_screener'), 'AI每日优选');
  assertEqual('manual_analysis 标签', strategyLabel('manual_analysis'), '人工分析');
  assertEqual('analysis_engine 标签', strategyLabel('analysis_engine'), '多维分析引擎');
  // sentinel 默认值
  assertEqual('__MANUAL__ 标签', strategyLabel('__MANUAL__'), '手动交易');
  assertEqual('__UNKNOWN__ 标签', strategyLabel('__UNKNOWN__'), '未标注策略');
  // 未知 → 落 fallback (返回原值, 与 sourceTypeLabel 同款语义)
  assertEqual('未知 source 透传', strategyLabel('future_source'), 'future_source');
  // 空 → 默认 兜底
  assertEqual('空字符串', strategyLabel(''), '未标注策略');
}

function testAggregateStrategyContribution(): void {
  const trades: StrategyTradeRow[] = [
    // 量化推荐: 2 笔, +2000 / +500 → 2 胜 0 负
    {
      symbol: '600519.SH',
      direction: 'SELL',
      realized_pnl: 2000,
      strategy_key: 'quant_recommendation',
    },
    {
      symbol: '000858.SZ',
      direction: 'SELL',
      realized_pnl: 500,
      strategy_key: 'quant_recommendation',
    },
    // 量化推荐 BUY → 忽略
    {
      symbol: '600519.SH',
      direction: 'BUY',
      realized_pnl: 0,
      strategy_key: 'quant_recommendation',
    },
    // analysis_engine: 1 笔 -800 → 0 胜 1 负
    {
      symbol: '000725.SZ',
      direction: 'SELL',
      realized_pnl: -800,
      strategy_key: 'analysis_engine',
    },
    // 缺 strategy_key → '__MANUAL__'
    {
      symbol: '002475.SZ',
      direction: 'SELL',
      realized_pnl: 100,
      strategy_key: '',
    },
    // 重复 symbol 同 strategy → dedup 但 trade_count 累加
    {
      symbol: '600519.SH',
      direction: 'SELL',
      realized_pnl: 300,
      strategy_key: 'quant_recommendation',
    },
  ];
  const result = aggregateStrategyContribution(trades);

  assertEqual('strategy bucket count', result.length, 3);
  // 排序: 量化 (+2800) > __MANUAL__ (+100) > analysis_engine (-800)
  assertEqual('top strategy_key', result[0].strategy_key, 'quant_recommendation');
  assertEqual('top strategy_label', result[0].strategy_label, '量化推荐');
  assertEqual('top realized_pnl', result[0].realized_pnl, 2800);
  assertEqual('top trade_count', result[0].trade_count, 3);
  assertEqual('top win_count', result[0].win_count, 3);
  assertEqual('top loss_count', result[0].loss_count, 0);
  assert(
    'top symbols 含 600519/000858 两个 (符号去重)',
    result[0].symbols.length === 2 &&
      result[0].symbols.includes('600519.SH') &&
      result[0].symbols.includes('000858.SZ')
  );

  assertEqual('second strategy', result[1].strategy_key, '__MANUAL__');
  assertEqual('second label', result[1].strategy_label, '手动交易');
  assertEqual('second pnl', result[1].realized_pnl, 100);
  assertEqual('second win_count', result[1].win_count, 1);
  assertEqual('second loss_count', result[1].loss_count, 0);

  assertEqual('third strategy', result[2].strategy_key, 'analysis_engine');
  assertEqual('third label', result[2].strategy_label, '多维分析引擎');
  assertEqual('third pnl', result[2].realized_pnl, -800);
  assertEqual('third win_count', result[2].win_count, 0);
  assertEqual('third loss_count', result[2].loss_count, 1);

  // 空入
  assertEqual('empty input', aggregateStrategyContribution([]).length, 0);

  // tie-break: 同 realized_pnl 按 strategy_key 字母升序
  const tieRows: StrategyTradeRow[] = [
    { symbol: 'A', direction: 'SELL', realized_pnl: 100, strategy_key: 'zzz' },
    { symbol: 'B', direction: 'SELL', realized_pnl: 100, strategy_key: 'aaa' },
  ];
  const tie = aggregateStrategyContribution(tieRows);
  assertEqual('tie first', tie[0].strategy_key, 'aaa');
  assertEqual('tie second', tie[1].strategy_key, 'zzz');
}

function testBuildEquityCurveSparkline(): void {
  // empty / single → ''
  assertEqual('empty sparkline', buildEquityCurveSparkline([]), '');
  assertEqual('single sparkline', buildEquityCurveSparkline([{ date: 'x', total_value: 1 }]), '');

  // flat — line element + 灰色 #94a3b8
  const flat = buildEquityCurveSparkline([
    { date: '1', total_value: 1000 },
    { date: '2', total_value: 1000 },
    { date: '3', total_value: 1000 },
  ]);
  assert('flat 含 svg', flat.includes('<svg'));
  assert('flat 含 line tag', flat.includes('<line'));
  assert('flat 颜色 #94a3b8', flat.includes('#94a3b8'));

  // up → green
  const up = buildEquityCurveSparkline([
    { date: '1', total_value: 1000 },
    { date: '2', total_value: 1010 },
    { date: '3', total_value: 1100 },
  ]);
  assert('up 含 path', up.includes('<path'));
  assert('up 颜色 green', up.includes('#16a34a'));

  // down → red
  const down = buildEquityCurveSparkline([
    { date: '1', total_value: 1100 },
    { date: '2', total_value: 1090 },
    { date: '3', total_value: 1000 },
  ]);
  assert('down 含 path', down.includes('<path'));
  assert('down 颜色 red', down.includes('#dc2626'));

  // 边界 width / height
  const sized = buildEquityCurveSparkline(
    [
      { date: '1', total_value: 100 },
      { date: '2', total_value: 200 },
    ],
    { width: 50, height: 20 }
  );
  // clamp lower bound to 80×40
  assert('width clamp', sized.includes('width="80"'));
  assert('height clamp', sized.includes('height="40"'));

  const bigsized = buildEquityCurveSparkline(
    [
      { date: '1', total_value: 100 },
      { date: '2', total_value: 200 },
    ],
    { width: 99999, height: 99999 }
  );
  assert('width upper clamp', bigsized.includes('width="1024"'));
  assert('height upper clamp', bigsized.includes('height="256"'));
}

function testBuildHeuristicWeeklyOpinion(): void {
  // pct null
  const r1 = buildHeuristicWeeklyOpinion({
    pnl_pct: null,
    industry_contribution: [],
    top_winners: [],
    top_losers: [],
    upcoming_events: [],
  });
  assertEqual('null source', r1.source, 'heuristic');
  assert('null headline 含 不足', r1.headline.includes('不足'));

  // 大涨
  const r2 = buildHeuristicWeeklyOpinion({
    pnl_pct: 5,
    industry_contribution: [{ industry: '白酒', realized_pnl: 5000, trade_count: 2, symbols: ['a', 'b'] }],
    top_winners: [{ symbol: '600519.SH', name: '茅台', industry: '白酒', realized_pnl: 5000, trade_count: 1 }],
    top_losers: [],
    upcoming_events: [],
  });
  assert('大涨 headline 含跑赢', r2.headline.includes('跑赢') || r2.headline.includes('+5.00%'));
  assert('大涨 含 paragraphs', r2.paragraphs.length > 0);

  // 平
  const r3 = buildHeuristicWeeklyOpinion({
    pnl_pct: 0,
    industry_contribution: [],
    top_winners: [],
    top_losers: [],
    upcoming_events: [],
  });
  assert('平 headline 含平稳', r3.headline.includes('平稳'));

  // 大回撤
  const r4 = buildHeuristicWeeklyOpinion({
    pnl_pct: -5,
    industry_contribution: [
      { industry: '半导体', realized_pnl: -3000, trade_count: 2, symbols: ['c', 'd'] },
    ],
    top_winners: [],
    top_losers: [
      { symbol: '000725.SZ', name: '京东方A', industry: '半导体', realized_pnl: -2000, trade_count: 1 },
    ],
    upcoming_events: [
      {
        symbol: '600519.SH',
        name: '茅台',
        event_type: 'earnings_forecast',
        detail: '净利大幅增长',
        announce_date: '2026-06-10',
      },
    ],
  });
  assert('大回撤 headline 含 回撤', r4.headline.includes('回撤') || r4.headline.includes('-5.00%'));
  assert('paragraphs 含 行业回撤', r4.paragraphs.some(p => p.includes('回撤') || p.includes('半导体')));
  assert('paragraphs 含 关注事件', r4.paragraphs.some(p => p.includes('关注事件') || p.includes('事件')));
  assert('paragraphs 含 个股亏损', r4.paragraphs.some(p => p.includes('亏损股') || p.includes('京东方')));

  // 无事件 → 句末 fallback
  const r5 = buildHeuristicWeeklyOpinion({
    pnl_pct: 1,
    industry_contribution: [],
    top_winners: [],
    top_losers: [],
    upcoming_events: [],
  });
  assert('无事件 fallback', r5.paragraphs.some(p => p.includes('暂无重要事件')));
}

function testBuildReportId(): void {
  assertEqual('id 格式', buildReportId(1, '2026-06-07', 'abcd'), 'WEEKLY-1-20260607-abcd');
  assertEqual('id rand4 截断', buildReportId(1, '2026-06-07', 'abcdef'), 'WEEKLY-1-20260607-abcd');
  assertEqual('id rand4 padding', buildReportId(1, '2026-06-07', 'a'), 'WEEKLY-1-20260607-000a');
  assertEqual('id 空 rand4', buildReportId(1, '2026-06-07', ''), 'WEEKLY-1-20260607-0000');
}

function testBuildWeeklyReviewEmail(): void {
  const payload: WeeklyReviewPayload = {
    user_id: 1,
    username: 'lym',
    week: { start_date: '2026-06-01', end_date: '2026-06-07', week_id: '2026-W23' },
    pnl: { start_value: 100000, end_value: 105000, pnl_amount: 5000, pnl_pct: 5 },
    equity_curve: [
      { date: '2026-06-01', total_value: 100000 },
      { date: '2026-06-07', total_value: 105000 },
    ],
    industry_contribution: [
      { industry: '白酒', realized_pnl: 3000, trade_count: 2, symbols: ['600519.SH'] },
      { industry: '__UNKNOWN__', realized_pnl: -500, trade_count: 1, symbols: ['UNK.X'] },
    ],
    strategy_contribution: [
      {
        strategy_key: 'quant_recommendation',
        strategy_label: '量化推荐',
        realized_pnl: 3000,
        trade_count: 2,
        symbols: ['600519.SH'],
        win_count: 2,
        loss_count: 0,
      },
      {
        strategy_key: '__MANUAL__',
        strategy_label: '手动交易',
        realized_pnl: -500,
        trade_count: 1,
        symbols: ['UNK.X'],
        win_count: 0,
        loss_count: 1,
      },
    ],
    top_winners: [
      { symbol: '600519.SH', name: '茅台', industry: '白酒', realized_pnl: 3000, trade_count: 1 },
    ],
    top_losers: [],
    trade_count: 3,
    realized_pnl_total: 2500,
    upcoming_events: [
      {
        symbol: '000725.SZ',
        name: '京东方A',
        event_type: 'earnings_forecast',
        detail: '净利+30%',
        announce_date: '2026-06-10',
      },
    ],
    ai_opinion: {
      source: 'heuristic',
      headline: '组合本周大幅跑赢 +5.00%',
      paragraphs: ['白酒主推', '半导体平稳'],
    },
  };
  const mail = buildWeeklyReviewEmail(payload);
  assert('subject 非空', mail.subject.length > 0);
  assert('subject 含日期', mail.subject.includes('2026-06-01') && mail.subject.includes('2026-06-07'));
  assert('subject 含金额', mail.subject.includes('5,000.00'));
  assert('subject 含 +5.00%', mail.subject.includes('+5.00%'));
  assert('html 含 sparkline svg', mail.html.includes('<svg'));
  assert('html 含 username', mail.html.includes('lym'));
  assert('html 含 week_id', mail.html.includes('2026-W23'));
  assert('html 含 白酒 row', mail.html.includes('白酒'));
  assert('html 含 未分类 row（__UNKNOWN__ 替换）', mail.html.includes('未分类'));
  assert('html 含 京东方 关注事件', mail.html.includes('京东方'));
  assert('html 含 业绩预告 label', mail.html.includes('业绩预告'));
  assert('html 含 AI 周观点', mail.html.includes('AI 周观点'));
  assert('html 含 本地启发式 tag', mail.html.includes('本地启发式'));
  assert('html 含 headline', mail.html.includes('跑赢'));
  assert('text plain fallback 含 主要数据', !!mail.text && mail.text.includes('lym'));
  assert('text 含 PnL line', !!mail.text && mail.text.includes('+5,000.00'));
  // US-087 PM-011 — strategy 维度渲染
  assert('html 含 各策略贡献 section header', mail.html.includes('各策略贡献'));
  assert('html 含 量化推荐 label', mail.html.includes('量化推荐'));
  assert('html 含 手动交易 label (来自 __MANUAL__)', mail.html.includes('手动交易'));
  assert('html 含 胜率 列头', mail.html.includes('胜率'));
  assert('html 含 100% 胜率 (quant 2 胜 0 负)', mail.html.includes('100%'));
  assert('text 含 策略贡献 section', !!mail.text && mail.text.includes('策略贡献'));
  assert('text 含 量化推荐 line', !!mail.text && mail.text.includes('量化推荐'));
  assert('text 含 手动交易 line', !!mail.text && mail.text.includes('手动交易'));
}

function testFormatMoney(): void {
  assertEqual('formatMoney 0', formatMoney(0), '0.00');
  assertEqual('formatMoney 1k', formatMoney(1000), '1,000.00');
  assertEqual('formatMoney 1m', formatMoney(1000000), '1,000,000.00');
  assertEqual('formatMoney negative', formatMoney(-12345.67), '-12,345.67');
  assertEqual('formatMoney NaN → 0', formatMoney('not a number'), '0.00');
  assertEqual('formatMoney decimal', formatMoney(99.5), '99.50');
}

// ---------------------------------------------------------------------------
// EmailNotificationService pure helper tests
// ---------------------------------------------------------------------------

function testReadSmtpConfigFromEnv(): void {
  // 缺 HOST
  assertEqual(
    'cfg missing HOST → null',
    readSmtpConfigFromEnv({ SMTP_USER: 'u', SMTP_PASS: 'p' } as any),
    null
  );
  // 缺 USER
  assertEqual(
    'cfg missing USER → null',
    readSmtpConfigFromEnv({ SMTP_HOST: 'h', SMTP_PASS: 'p' } as any),
    null
  );
  // 缺 PASS
  assertEqual(
    'cfg missing PASS → null',
    readSmtpConfigFromEnv({ SMTP_HOST: 'h', SMTP_USER: 'u' } as any),
    null
  );
  // 全有 + 默认 port = 587 + 默认 secure = false + 默认 from = user
  const r = readSmtpConfigFromEnv({
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'noreply@example.com',
    SMTP_PASS: 'pw',
  } as any);
  assertEqual('cfg host', r?.host, 'smtp.example.com');
  assertEqual('cfg port default 587', r?.port, 587);
  assertEqual('cfg secure default false', r?.secure, false);
  assertEqual('cfg from defaults to user', r?.from, 'noreply@example.com');

  // 覆盖 port + secure=true + from
  const r2 = readSmtpConfigFromEnv({
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_FROM: 'sender@example.com',
  } as any);
  assertEqual('cfg port 465', r2?.port, 465);
  assertEqual('cfg secure true', r2?.secure, true);
  assertEqual('cfg from override', r2?.from, 'sender@example.com');

  // 非法 port → fallback 587
  const r3 = readSmtpConfigFromEnv({
    SMTP_HOST: 'h',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    SMTP_PORT: 'abc',
  } as any);
  assertEqual('cfg port invalid → 587', r3?.port, 587);

  // out-of-range port → fallback
  const r4 = readSmtpConfigFromEnv({
    SMTP_HOST: 'h',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    SMTP_PORT: '99999',
  } as any);
  assertEqual('cfg port out of range → 587', r4?.port, 587);
}

function testIsEmailDisabledByEnv(): void {
  assertEqual('disabled true', isEmailDisabledByEnv({ DISABLE_EMAIL_NOTIFICATION: 'true' } as any), true);
  assertEqual('disabled 1', isEmailDisabledByEnv({ DISABLE_EMAIL_NOTIFICATION: '1' } as any), true);
  assertEqual('disabled yes', isEmailDisabledByEnv({ DISABLE_EMAIL_NOTIFICATION: 'yes' } as any), true);
  assertEqual('disabled on', isEmailDisabledByEnv({ DISABLE_EMAIL_NOTIFICATION: 'on' } as any), true);
  assertEqual('disabled false → false', isEmailDisabledByEnv({ DISABLE_EMAIL_NOTIFICATION: 'false' } as any), false);
  assertEqual('disabled empty → false', isEmailDisabledByEnv({} as any), false);
}

function testIsValidEmailAddress(): void {
  assertEqual('valid simple', isValidEmailAddress('a@b.com'), true);
  assertEqual('valid complex', isValidEmailAddress('noreply+test@sub.example.com'), true);
  assertEqual('invalid empty', isValidEmailAddress(''), false);
  assertEqual('invalid no @', isValidEmailAddress('abc.com'), false);
  assertEqual('invalid double @', isValidEmailAddress('a@b@c.com'), false);
  assertEqual('invalid space', isValidEmailAddress('a b@c.com'), false);
  assertEqual('invalid no dot in domain', isValidEmailAddress('a@bcom'), false);
  assertEqual('invalid leading @', isValidEmailAddress('@b.com'), false);
  assertEqual('invalid trailing @', isValidEmailAddress('a@'), false);
  // 长度边界
  assertEqual('invalid 4-char short', isValidEmailAddress('a@bc'), false);
  // 控制字符
  assertEqual('invalid angle bracket', isValidEmailAddress('a<@b.com'), false);
}

function testResetTransporter(): void {
  // 不抛即可
  let thrown = false;
  try {
    resetTransporter();
  } catch {
    thrown = true;
  }
  assert('resetTransporter 不抛', !thrown);
}

async function testEmailServiceIsEnabled(): Promise<void> {
  const svc = new EmailNotificationService();
  // 取决于 process.env，这里不强校验返回值，只确保不抛
  let thrown = false;
  try {
    svc.isEnabled();
  } catch {
    thrown = true;
  }
  assert('isEnabled 不抛', !thrown);
}

async function testEmailServiceSendDisabled(): Promise<void> {
  const svc = new EmailNotificationService();
  const restoreEnv = process.env.DISABLE_EMAIL_NOTIFICATION;
  process.env.DISABLE_EMAIL_NOTIFICATION = 'true';
  const r = await svc.sendEmail({ x: 1 }, 'a@b.com', { buildEmail: () => ({ subject: 's', html: 'h' }) });
  assertEqual('disabled → success false', r.success, false);
  assertEqual('disabled → skipped true', r.skipped, true);
  assert('disabled message 含禁用', !!r.message && r.message.includes('禁用'));
  if (restoreEnv === undefined) {
    delete process.env.DISABLE_EMAIL_NOTIFICATION;
  } else {
    process.env.DISABLE_EMAIL_NOTIFICATION = restoreEnv;
  }
}

async function testEmailServiceSendEmptyAddress(): Promise<void> {
  const svc = new EmailNotificationService();
  const r = await svc.sendEmail(
    { x: 1 },
    '',
    {
      buildEmail: () => ({ subject: 's', html: 'h' }),
      smtpOverride: { host: 'h', port: 587, user: 'u', pass: 'p', secure: false, from: 'u' },
    }
  );
  assertEqual('empty addr → skipped', r.skipped, true);
  assertEqual('empty addr success false', r.success, false);
}

async function testEmailServiceSendInvalidAddress(): Promise<void> {
  const svc = new EmailNotificationService();
  const r = await svc.sendEmail(
    { x: 1 },
    'not-an-email',
    {
      buildEmail: () => ({ subject: 's', html: 'h' }),
      smtpOverride: { host: 'h', port: 587, user: 'u', pass: 'p', secure: false, from: 'u' },
    }
  );
  assertEqual('invalid addr success false', r.success, false);
  assert('invalid addr message 含 非法', !!r.message && r.message.includes('非法'));
}

async function testEmailServiceSendMissingBuildEmail(): Promise<void> {
  const svc = new EmailNotificationService();
  const r = await svc.sendEmail({ x: 1 }, 'a@b.com', {
    smtpOverride: { host: 'h', port: 587, user: 'u', pass: 'p', secure: false, from: 'u' },
  } as any);
  assertEqual('missing buildEmail success false', r.success, false);
  assert('missing buildEmail msg', !!r.message && r.message.includes('buildEmail'));
}

async function testEmailServiceSendBuildEmailThrows(): Promise<void> {
  const svc = new EmailNotificationService();
  const r = await svc.sendEmail({ x: 1 }, 'a@b.com', {
    buildEmail: () => {
      throw new Error('boom');
    },
    smtpOverride: { host: 'h', port: 587, user: 'u', pass: 'p', secure: false, from: 'u' },
  });
  assertEqual('buildEmail throw → success false', r.success, false);
  assert('buildEmail throw → message 含 boom', !!r.message && r.message.includes('boom'));
}

async function testEmailServiceSendInvalidPayload(): Promise<void> {
  const svc = new EmailNotificationService();
  const r = await svc.sendEmail(null as any, 'a@b.com', {
    buildEmail: () => ({ subject: 's', html: 'h' }),
    smtpOverride: { host: 'h', port: 587, user: 'u', pass: 'p', secure: false, from: 'u' },
  });
  assertEqual('null payload success false', r.success, false);
  assert('null payload msg', !!r.message && r.message.includes('payload'));
}

async function testEmailServiceSendInvalidEmailPayload(): Promise<void> {
  const svc = new EmailNotificationService();
  const r = await svc.sendEmail(
    { x: 1 },
    'a@b.com',
    {
      buildEmail: () => ({ subject: '', html: '' }) as any,
      smtpOverride: { host: 'h', port: 587, user: 'u', pass: 'p', secure: false, from: 'u' },
    }
  );
  assertEqual('empty subject success false', r.success, false);
  assert('empty subject msg 含 subject', !!r.message && r.message.includes('subject'));
}

async function testEmailServiceSendNoSmtpConfig(): Promise<void> {
  const svc = new EmailNotificationService();
  // 清空 env 让 readSmtpConfigFromEnv 返回 null
  const saved = {
    H: process.env.SMTP_HOST,
    U: process.env.SMTP_USER,
    P: process.env.SMTP_PASS,
  };
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  const r = await svc.sendEmail({ x: 1 }, 'a@b.com', {
    buildEmail: () => ({ subject: 's', html: 'h' }),
  });
  assertEqual('no smtp success false', r.success, false);
  assertEqual('no smtp skipped', r.skipped, true);
  assert('no smtp msg', !!r.message && r.message.includes('SMTP'));
  if (saved.H !== undefined) process.env.SMTP_HOST = saved.H;
  if (saved.U !== undefined) process.env.SMTP_USER = saved.U;
  if (saved.P !== undefined) process.env.SMTP_PASS = saved.P;
}

async function testEmailServiceSendHappyPath(): Promise<void> {
  const svc = new EmailNotificationService();
  let captured: any = null;
  const fakeTransporter = {
    async sendMail(opts: any) {
      captured = opts;
      return { messageId: 'msg-123', accepted: ['a@b.com'], rejected: [], response: 'OK' };
    },
  };
  const r = await svc.sendEmail({ x: 1 }, 'a@b.com', {
    buildEmail: () => ({ subject: 'HELLO', html: '<p>hi</p>', text: 'hi' }),
    smtpOverride: { host: 'h', port: 587, user: 'u', pass: 'p', secure: false, from: 'sender@example.com' },
    transporterOverride: fakeTransporter,
  });
  assertEqual('happy success', r.success, true);
  assertEqual('happy data messageId', r.data?.messageId, 'msg-123');
  assertEqual('captured to', captured?.to, 'a@b.com');
  assertEqual('captured subject', captured?.subject, 'HELLO');
  assertEqual('captured from', captured?.from, 'sender@example.com');
  assertEqual('captured html', captured?.html, '<p>hi</p>');
  assertEqual('captured text', captured?.text, 'hi');
}

async function testEmailServiceSendTransporterThrows(): Promise<void> {
  const svc = new EmailNotificationService();
  const fakeTransporter = {
    async sendMail() {
      throw new Error('smtp boom');
    },
  };
  const r = await svc.sendEmail({ x: 1 }, 'a@b.com', {
    buildEmail: () => ({ subject: 'HELLO', html: '<p>hi</p>' }),
    smtpOverride: { host: 'h', port: 587, user: 'u', pass: 'p', secure: false, from: 'u' },
    transporterOverride: fakeTransporter,
  });
  assertEqual('throw success false', r.success, false);
  assert('throw msg 含 smtp boom', !!r.message && r.message.includes('smtp boom'));
}

// ---------------------------------------------------------------------------
// Service e2e tests
// ---------------------------------------------------------------------------

function eligibleUser(
  user_id: number,
  username: string,
  patch?: Partial<NotificationChannelsConfig>
): { user_id: number; username: string; config: NotificationChannelsConfig } {
  return {
    user_id,
    username,
    config: makeConfig({
      email: { enabled: true, address: `${username}@example.com`, weekly_review: true } as any,
      ...(patch || {}),
    }),
  };
}

async function testSendEmptyUsers(): Promise<void> {
  const state: FakeState = { users: [] };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('empty scanned', r.scanned_users, 0);
  assertEqual('empty sent', r.sent_count, 0);
  assertEqual('empty per_user', r.per_user.length, 0);
  assertEqual('empty week start', r.week.start_date, '2026-06-01');
}

async function testSendListEligibleUsersThrows(): Promise<void> {
  const state: FakeState = { throwOn: { listEligibleUsers: true } };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('list throw scanned', r.scanned_users, 0);
  assertEqual('list throw per_user', r.per_user.length, 0);
}

async function testSendWeeklyReviewOff(): Promise<void> {
  const state: FakeState = {
    users: [
      {
        user_id: 1,
        username: 'lym',
        config: makeConfig({
          email: { enabled: true, address: 'a@b.com', weekly_review: false } as any,
        }),
      },
    ],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('weekly off skipped', r.skipped_count, 1);
  assertEqual('weekly off per_user status', r.per_user[0].status, 'skipped');
  assert('weekly off skip_reason 含 weekly', !!r.per_user[0].skip_reason);
}

async function testSendEmailDisabled(): Promise<void> {
  const state: FakeState = {
    users: [
      {
        user_id: 1,
        username: 'lym',
        config: makeConfig({
          email: { enabled: false, address: 'a@b.com', weekly_review: true } as any,
        }),
      },
    ],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('email off skipped', r.skipped_count, 1);
  assertEqual('email off status', r.per_user[0].status, 'skipped');
}

async function testSendNoPortfolio(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: null },
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('no portfolio skipped', r.skipped_count, 1);
  assertEqual('no portfolio status', r.per_user[0].status, 'skipped');
  assert(
    'no portfolio skip_reason 含 模拟盘',
    !!r.per_user[0].skip_reason && r.per_user[0].skip_reason!.includes('模拟盘')
  );
}

async function testSendDryRun(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: {
      100: [
        { date: '2026-06-01', total_value: 100000 },
        { date: '2026-06-07', total_value: 102000 },
      ],
    },
    trades: { 100: [] },
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08', dry_run: true });
  assertEqual('dry_run sent', r.sent_count, 1);
  assertEqual('dry_run status', r.per_user[0].status, 'sent');
  assertEqual('dry_run sent flag false', r.per_user[0].sent, false);
  assertEqual('dry_run skip_reason', r.per_user[0].skip_reason, 'dry_run');
  assert('dry_run payload exists', !!r.per_user[0].payload);
  assertEqual('dry_run pnl pct', r.per_user[0].payload!.pnl.pnl_pct, 2);
  // dry_run 不调 sendEmail
  assertEqual('dry_run sendEmail not called', state.sendEmailCalls!.length, 0);
  // US-087 PM-011 — payload.strategy_contribution 必然存在 (即便为空)
  assert(
    'dry_run payload 含 strategy_contribution 字段',
    Array.isArray(r.per_user[0].payload!.strategy_contribution)
  );
}

// ---------------------------------------------------------------------------
// US-087 PM-011 — sendForUser strategy lookup e2e
// ---------------------------------------------------------------------------
async function testSendStrategyContributionPropagates(): Promise<void> {
  // 模拟: portfolio 100 内 trade 11/12/13, 其中 11 → quant_recommendation,
  // 12 → analysis_engine, 13 无映射 (手动) → '__MANUAL__'.
  const tradeStrategyMap = new Map<number, string>([
    [11, 'quant_recommendation'],
    [12, 'analysis_engine'],
  ]);
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: {
      100: [
        { date: '2026-06-01', total_value: 100000 },
        { date: '2026-06-07', total_value: 103000 },
      ],
    },
    trades: {
      100: [
        { id: 11, symbol: '600519.SH', name: '茅台', direction: 'SELL', realized_pnl: 2000 },
        { id: 12, symbol: '000725.SZ', name: '京东方A', direction: 'SELL', realized_pnl: -500 },
        { id: 13, symbol: '002475.SZ', name: '立讯精密', direction: 'SELL', realized_pnl: 200 },
        // BUY 永远不入策略聚合
        { id: 14, symbol: '600519.SH', name: '茅台', direction: 'BUY', realized_pnl: 0 },
      ],
    },
    tradeStrategyMap: { 100: tradeStrategyMap },
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08', dry_run: true });
  const payload = r.per_user[0].payload!;
  const strat = payload.strategy_contribution;
  assert('3 个策略桶', strat.length === 3);
  // 排序: 量化 (+2000) > __MANUAL__ (+200) > analysis_engine (-500)
  assertEqual('top strategy', strat[0].strategy_key, 'quant_recommendation');
  assertEqual('top strategy label', strat[0].strategy_label, '量化推荐');
  assertEqual('top strategy pnl', strat[0].realized_pnl, 2000);
  assertEqual('top strategy win=1', strat[0].win_count, 1);
  assertEqual('second strategy', strat[1].strategy_key, '__MANUAL__');
  assertEqual('second strategy pnl', strat[1].realized_pnl, 200);
  assertEqual('third strategy', strat[2].strategy_key, 'analysis_engine');
  assertEqual('third strategy pnl', strat[2].realized_pnl, -500);
  assertEqual('third strategy loss=1', strat[2].loss_count, 1);
}

async function testSendStrategyLookupFailureFallsBackManual(): Promise<void> {
  // loadTradeStrategyMap throw → 不阻塞主流程, 所有 SELL trade 走 '__MANUAL__'
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: { 100: [{ date: '2026-06-01', total_value: 100000 }] },
    trades: {
      100: [{ id: 11, symbol: '600519.SH', name: '茅台', direction: 'SELL', realized_pnl: 100 }],
    },
    throwOn: { loadTradeStrategyMap: true },
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08', dry_run: true });
  // 主流程不挂
  assertEqual('strategy throw → dry_run sent', r.sent_count, 1);
  const strat = r.per_user[0].payload!.strategy_contribution;
  assertEqual('strategy throw → 1 bucket', strat.length, 1);
  assertEqual('strategy throw → __MANUAL__ key', strat[0].strategy_key, '__MANUAL__');
  assertEqual('strategy throw → 手动交易 label', strat[0].strategy_label, '手动交易');
  assertEqual('strategy throw → pnl', strat[0].realized_pnl, 100);
}

async function testSendEmailThrows(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: { 100: [{ date: '2026-06-01', total_value: 100000 }] },
    trades: { 100: [] },
    throwOn: { sendEmail: true },
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('send throw failed', r.failed_count, 1);
  assertEqual('send throw status', r.per_user[0].status, 'failed');
  assert('send throw error 填充', !!r.per_user[0].error);
}

async function testSendEmailReturnsFailure(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: { 100: [{ date: '2026-06-01', total_value: 100000 }] },
    trades: { 100: [] },
    sendEmailResults: [{ success: false, message: 'smtp 500' }],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('partial status', r.per_user[0].status, 'partial');
  assertEqual('partial failed_count', r.failed_count, 1);
  assert('partial error 含 smtp', !!r.per_user[0].error && r.per_user[0].error!.includes('smtp'));
}

async function testSendEmailHappyPath(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [{ symbol: '600519.SH', market_value: 50000 }] } },
    snapshots: {
      100: [
        { date: '2026-06-01', total_value: 100000 },
        { date: '2026-06-07', total_value: 103000 },
      ],
    },
    trades: {
      100: [
        { symbol: '600519.SH', name: '茅台', direction: 'SELL', realized_pnl: 1500, portfolio_id: 100 } as any,
      ],
    },
    stockMeta: new Map([['600519.SH', { name: '茅台', industry: '白酒' }]]),
    sendEmailResults: [{ success: true, data: { messageId: 'm1' } }],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('happy sent', r.sent_count, 1);
  assertEqual('happy status', r.per_user[0].status, 'sent');
  assertEqual('happy sent flag true', r.per_user[0].sent, true);
  assertEqual('happy email_used', r.per_user[0].email_used, 'lym@example.com');
  assertEqual('happy payload pnl pct', r.per_user[0].payload!.pnl.pnl_pct, 3);
  assertEqual('happy industry count', r.per_user[0].payload!.industry_contribution.length, 1);
  assertEqual('happy industry top', r.per_user[0].payload!.industry_contribution[0].industry, '白酒');
  // sendEmail 调用一次
  assertEqual('happy sendEmail calls', state.sendEmailCalls!.length, 1);
  assertEqual('happy sendEmail to', state.sendEmailCalls![0].to, 'lym@example.com');
}

async function testSendEmailReturnsSkipped(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: { 100: [{ date: '2026-06-01', total_value: 100000 }] },
    trades: { 100: [] },
    sendEmailResults: [{ success: false, skipped: true, message: '未配置 SMTP' }],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('skipped status', r.per_user[0].status, 'skipped');
  assertEqual('skipped count', r.skipped_count, 1);
  assert('skipped skip_reason', !!r.per_user[0].skip_reason);
}

async function testSendGenerateAIOpinionThrows(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: { 100: [{ date: '2026-06-01', total_value: 100000 }] },
    trades: { 100: [] },
    throwOn: { generateAIWeeklyOpinion: true },
    sendEmailResults: [{ success: true }],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  // 兜底成 heuristic
  assertEqual('AI throw → still sent', r.per_user[0].status, 'sent');
  assertEqual('AI throw → heuristic source', r.per_user[0].payload!.ai_opinion.source, 'heuristic');
}

async function testSendSnapshotsThrowsNonBlocking(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    throwOn: { loadWeeklySnapshots: true },
    trades: { 100: [] },
    sendEmailResults: [{ success: true }],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('snapshots throw → still sent', r.per_user[0].status, 'sent');
  // snapshots 空 → pnl 全 0 / pct null
  assertEqual('snapshots throw → start_value 0', r.per_user[0].payload!.pnl.start_value, 0);
  assertEqual('snapshots throw → pnl_pct null', r.per_user[0].payload!.pnl.pnl_pct, null);
}

async function testSendTradesThrowsNonBlocking(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: { 100: [{ date: '2026-06-01', total_value: 100000 }] },
    throwOn: { loadWeeklyTrades: true },
    sendEmailResults: [{ success: true }],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('trades throw → still sent', r.per_user[0].status, 'sent');
  assertEqual('trades throw → industry empty', r.per_user[0].payload!.industry_contribution.length, 0);
  assertEqual('trades throw → trade_count 0', r.per_user[0].payload!.trade_count, 0);
}

async function testSendMultipleUsersIsolated(): Promise<void> {
  // A 成功，B sendEmail throw
  const state: FakeState = {
    users: [eligibleUser(1, 'lym'), eligibleUser(2, 'alice')],
    portfolios: {
      1: { portfolio: { id: 100 }, positions: [] },
      2: { portfolio: { id: 200 }, positions: [] },
    },
    snapshots: { 100: [{ date: 'x', total_value: 1 }], 200: [{ date: 'y', total_value: 1 }] },
    trades: { 100: [], 200: [] },
    sendEmailResults: [{ success: true, data: { messageId: 'ok-1' } }, { success: false, message: 'boom' }],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('multi scanned', r.scanned_users, 2);
  assertEqual('multi per_user len', r.per_user.length, 2);
  // 第一个 lym 成功，第二个 alice partial
  assertEqual('multi user1 status', r.per_user[0].status, 'sent');
  assertEqual('multi user2 status', r.per_user[1].status, 'partial');
  assertEqual('multi sent_count', r.sent_count, 1);
  assertEqual('multi failed_count', r.failed_count, 1);
}

async function testSendUserIdFilter(): Promise<void> {
  // user_id filter 透传给 listEligibleUsers
  let opts: any = null;
  const ds: WeeklyReviewDataSource = {
    async listEligibleUsers(o) {
      opts = o;
      return [];
    },
    async loadPortfolio() {
      return null;
    },
    async loadWeeklySnapshots() {
      return [];
    },
    async loadWeeklyTrades() {
      return [] as any;
    },
    async loadStockMetadata() {
      return new Map();
    },
    async loadUpcomingEvents() {
      return [];
    },
    async generateAIWeeklyOpinion() {
      return { source: 'heuristic', headline: 'x', paragraphs: [] };
    },
    async sendEmail() {
      return { success: true };
    },
  };
  const svc = new WeeklyReviewReportService(ds);
  await svc.sendWeeklyReviewReports({ user_id: 42, reference_date: '2026-06-08' });
  assertEqual('user_id filter propagates', opts?.user_id, 42);
}

async function testSendLookaheadClampAndPropagate(): Promise<void> {
  let captured: any = null;
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: { 100: [{ date: 'x', total_value: 1 }] },
    trades: { 100: [] },
    sendEmailResults: [{ success: true }],
  };
  const ds = makeFakeDataSource(state);
  const origLoadEvents = ds.loadUpcomingEvents;
  ds.loadUpcomingEvents = async (symbols, from, to) => {
    captured = { symbols, from, to };
    return origLoadEvents(symbols, from, to);
  };
  const svc = new WeeklyReviewReportService(ds);
  // lookahead 100 → 应 clamp 到 30
  await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08', upcoming_lookahead_days: 100 });
  assert('lookahead from 与 ref 一致', captured?.from === '2026-06-08');
  // 100 days from 2026-06-08 → 2026-09-16，但 clamp 到 30 → 2026-07-08
  assertEqual('lookahead clamp to 30', captured?.to, '2026-07-08');
}

async function testSendUpcomingEventsThrowsNonBlocking(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: { 100: [{ date: 'x', total_value: 1 }] },
    trades: { 100: [] },
    throwOn: { loadUpcomingEvents: true },
    sendEmailResults: [{ success: true }],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('events throw → still sent', r.per_user[0].status, 'sent');
  assertEqual('events throw → events empty', r.per_user[0].payload!.upcoming_events.length, 0);
}

async function testSendStockMetadataThrowsNonBlocking(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: { 100: [{ date: 'x', total_value: 1 }] },
    trades: {
      100: [{ symbol: '600519.SH', name: '茅台', direction: 'SELL', realized_pnl: 100 } as any],
    },
    throwOn: { loadStockMetadata: true },
    sendEmailResults: [{ success: true }],
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('meta throw → still sent', r.per_user[0].status, 'sent');
  // 无 meta → industry 全部走 __UNKNOWN__
  assertEqual('meta throw → industry UNKNOWN', r.per_user[0].payload!.industry_contribution[0].industry, '__UNKNOWN__');
}

async function testSendLoadPortfolioThrows(): Promise<void> {
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    throwOn: { loadPortfolio: true },
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08' });
  assertEqual('loadPortfolio throw failed', r.failed_count, 1);
  assertEqual('loadPortfolio throw status', r.per_user[0].status, 'failed');
  assert('loadPortfolio throw error', !!r.per_user[0].error);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testConstantsFrozen();
  testShouldSendWeeklyReviewForUser();
  testComputePrevWeekRange();
  testComputeWeeklyPnL();
  testAggregateIndustryContribution();
  testAggregateSymbolContribution();
  testStrategyLabel();
  testAggregateStrategyContribution();
  testBuildEquityCurveSparkline();
  testBuildHeuristicWeeklyOpinion();
  testBuildReportId();
  testBuildWeeklyReviewEmail();
  testFormatMoney();

  testReadSmtpConfigFromEnv();
  testIsEmailDisabledByEnv();
  testIsValidEmailAddress();
  testResetTransporter();
  await testEmailServiceIsEnabled();
  await testEmailServiceSendDisabled();
  await testEmailServiceSendEmptyAddress();
  await testEmailServiceSendInvalidAddress();
  await testEmailServiceSendMissingBuildEmail();
  await testEmailServiceSendBuildEmailThrows();
  await testEmailServiceSendInvalidPayload();
  await testEmailServiceSendInvalidEmailPayload();
  await testEmailServiceSendNoSmtpConfig();
  await testEmailServiceSendHappyPath();
  await testEmailServiceSendTransporterThrows();

  await testSendEmptyUsers();
  await testSendListEligibleUsersThrows();
  await testSendWeeklyReviewOff();
  await testSendEmailDisabled();
  await testSendNoPortfolio();
  await testSendDryRun();
  await testSendStrategyContributionPropagates();
  await testSendStrategyLookupFailureFallsBackManual();
  await testSendEmailThrows();
  await testSendEmailReturnsFailure();
  await testSendEmailHappyPath();
  await testSendEmailReturnsSkipped();
  await testSendGenerateAIOpinionThrows();
  await testSendSnapshotsThrowsNonBlocking();
  await testSendTradesThrowsNonBlocking();
  await testSendMultipleUsersIsolated();
  await testSendUserIdFilter();
  await testSendLookaheadClampAndPropagate();
  await testSendUpcomingEventsThrowsNonBlocking();
  await testSendStockMetadataThrowsNonBlocking();
  await testSendLoadPortfolioThrows();

  console.log(`\n────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log(`────────────────────────────────────`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
