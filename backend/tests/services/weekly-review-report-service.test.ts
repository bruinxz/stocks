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
  buildCorrelationMatrixHtml,
  buildCorrelationMatrixPayload,
  computeCorrelationMatrix,
  computePearson,
  dailyReturnsFromCloses,
  selectCorrelationSymbols,
  CORRELATION_MAX_SYMBOLS,
  CORRELATION_MIN_RETURNS,
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
  CorrelationMatrixPayload,
  DailyCloseRow,
  // US-125 PM-014
  WEEKLY_OPINION_MIN_CHARS,
  WEEKLY_OPINION_MAX_CHARS,
  countChineseChars,
  countOpinionChineseChars,
  clampOpinionToWordBudget,
  parseRemoteWeeklyOpinionPayload,
  callRemoteWeeklyOpinion,
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
  /** US-088 PM-012 — symbol → DailyCloseRow[] (与 PRODUCTION loadDailyCloses 返值同形态) */
  dailyCloses?: Map<string, DailyCloseRow[]>;
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
    loadDailyCloses: boolean;
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
    async loadDailyCloses(_symbols, _start, _end) {
      if (state.throwOn?.loadDailyCloses) throw new Error('FAKE loadDailyCloses');
      return state.dailyCloses || new Map<string, DailyCloseRow[]>();
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
          recommendations: [],
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

// ---------------------------------------------------------------------------
// US-088 PM-012 — correlation matrix pure helpers
// ---------------------------------------------------------------------------

function testComputePearsonEdges(): void {
  // 完全正相关
  assertEqual('identical', computePearson([1, 2, 3, 4], [1, 2, 3, 4]), 1);
  // 完全负相关
  assertEqual('opposite', computePearson([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  // 线性放大
  assertEqual('scaled positive', computePearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  // 短输入 (len<2)
  assertEqual('too short empty', computePearson([], []), null);
  assertEqual('too short single', computePearson([1], [1]), null);
  // 常数序列 (方差 0) → null
  assertEqual('constant a', computePearson([5, 5, 5, 5], [1, 2, 3, 4]), null);
  assertEqual('constant b', computePearson([1, 2, 3, 4], [7, 7, 7, 7]), null);
  // NaN / Inf 污染 → null
  assertEqual('NaN', computePearson([1, NaN, 3, 4], [1, 2, 3, 4]), null);
  assertEqual('Inf', computePearson([1, 2, 3, 4], [1, Infinity, 3, 4]), null);
  // 长度不等 → 取较短
  assertEqual('len mismatch', computePearson([1, 2, 3, 4, 5], [1, 2, 3, 4]), 1);
  // 已知中等正相关 case (手算: r≈0.913)
  const r = computePearson([1, 2, 3, 4, 5], [2, 4, 5, 7, 9]);
  assert('moderate positive', r !== null && r > 0.9 && r <= 1, `got ${r}`);
  // 不相关
  const r2 = computePearson([1, 2, 3, 4], [3, 1, 4, 2]);
  assert('weak/none', r2 !== null && Math.abs(r2) < 0.5, `got ${r2}`);
}

function testDailyReturnsFromCloses(): void {
  // 空 / 单点
  assertEqual('empty closes', dailyReturnsFromCloses([]), []);
  assertEqual(
    'single close',
    dailyReturnsFromCloses([{ date: '2026-06-01', close: 10 }]),
    []
  );
  // 双点 +10%
  const rd1 = dailyReturnsFromCloses([
    { date: '2026-06-01', close: 10 },
    { date: '2026-06-02', close: 11 },
  ]);
  assertEqual('double close 1 return', rd1.length, 1);
  assert('double close +10%', Math.abs(rd1[0] - 0.1) < 1e-9, `got ${rd1[0]}`);
  // 5 点
  const r = dailyReturnsFromCloses([
    { date: '2026-06-01', close: 100 },
    { date: '2026-06-02', close: 102 },
    { date: '2026-06-03', close: 102 },
    { date: '2026-06-04', close: 100 },
    { date: '2026-06-05', close: 105 },
  ]);
  assertEqual('5 points returns count', r.length, 4);
  assert('day1 +2%', Math.abs(r[0] - 0.02) < 1e-9);
  assert('day2 0%', Math.abs(r[1]) < 1e-9);
  assert('day3 -1.96%', Math.abs(r[2] - -0.01960784313725492) < 1e-9);
  // 0 / 负 close → 跳过 + 重置 prev (后续不与之前对算)
  const rd2 = dailyReturnsFromCloses([
    { date: '2026-06-01', close: 100 },
    { date: '2026-06-02', close: 0 }, // 跳过
    { date: '2026-06-03', close: 110 }, // 与 0 之前不再对算 (prev 重置)
  ]);
  assertEqual('zero close skips', rd2.length, 0);
  // NaN close → 跳过
  const rd3 = dailyReturnsFromCloses([
    { date: '2026-06-01', close: 100 },
    { date: '2026-06-02', close: NaN as any },
    { date: '2026-06-03', close: 110 },
  ]);
  assertEqual('NaN close skips', rd3.length, 0);
  // 输入非数组 → 空
  assertEqual('null input', dailyReturnsFromCloses(null as any), []);
}

function testSelectCorrelationSymbols(): void {
  // 空入 → 空选
  const r1 = selectCorrelationSymbols([], []);
  assertEqual('empty positions empty trades', r1.selected.length, 0);
  assertEqual('empty capped_n', r1.capped_n, 0);

  // 仅持仓: 按 market_value 降序
  const r2 = selectCorrelationSymbols(
    [
      { symbol: 'A', market_value: 1000 },
      { symbol: 'B', market_value: 5000 },
      { symbol: 'C', market_value: 2000 },
    ],
    []
  );
  assertEqual('mv desc order', r2.selected, ['B', 'C', 'A']);
  assertEqual('mv capped_n', r2.capped_n, 3);

  // 持仓 + 交易股 (交易股 mv=0 排最后)
  const r3 = selectCorrelationSymbols(
    [{ symbol: 'A', market_value: 1000 }],
    ['B', 'C']
  );
  assertEqual('held first then traded asc', r3.selected, ['A', 'B', 'C']);
  assertEqual('held+traded capped_n', r3.capped_n, 3);

  // cap 截断
  const positions = Array.from({ length: 15 }, (_, i) => ({
    symbol: `S${String(i).padStart(2, '0')}`,
    market_value: 1000 - i, // 降序: S00=1000, S01=999, ...
  }));
  const r4 = selectCorrelationSymbols(positions, [], CORRELATION_MAX_SYMBOLS);
  assertEqual('cap to MAX', r4.selected.length, CORRELATION_MAX_SYMBOLS);
  assertEqual('cap capped_n', r4.capped_n, 15);
  assertEqual('cap first', r4.selected[0], 'S00');
  assertEqual('cap last', r4.selected[CORRELATION_MAX_SYMBOLS - 1], `S0${CORRELATION_MAX_SYMBOLS - 1}`);

  // 同 symbol 在 positions 和 trades 重复 → dedup
  const r5 = selectCorrelationSymbols(
    [{ symbol: 'A', market_value: 1000 }],
    ['A', 'B']
  );
  assertEqual('dedup A+B', r5.selected, ['A', 'B']);
  assertEqual('dedup capped_n', r5.capped_n, 2);

  // 空 symbol / null mv 兜底
  const r6 = selectCorrelationSymbols(
    [
      { symbol: '', market_value: 999 } as any,
      { symbol: 'A', market_value: null as any },
    ],
    [' ', 'B']
  );
  assert('A in selected', r6.selected.includes('A'));
  assert('empty symbol filtered', !r6.selected.includes(''));
}

function testComputeCorrelationMatrix(): void {
  // 空 / 单 symbol — 仍合法返 1x1 矩阵 (对角线)
  const closes = new Map<string, DailyCloseRow[]>();
  closes.set('A', [
    { date: '2026-06-01', close: 100 },
    { date: '2026-06-02', close: 102 },
    { date: '2026-06-03', close: 103 },
    { date: '2026-06-04', close: 105 },
    { date: '2026-06-05', close: 107 },
  ]);
  closes.set('B', [
    { date: '2026-06-01', close: 50 },
    { date: '2026-06-02', close: 51 },
    { date: '2026-06-03', close: 51.5 },
    { date: '2026-06-04', close: 52.5 },
    { date: '2026-06-05', close: 53.5 },
  ]);
  closes.set('C', [
    { date: '2026-06-01', close: 200 },
    { date: '2026-06-02', close: 196 },
    { date: '2026-06-03', close: 194 },
    { date: '2026-06-04', close: 190 },
    { date: '2026-06-05', close: 186 },
  ]);

  const m1 = computeCorrelationMatrix(['A'], closes);
  assert('single symbol matrix', m1 !== null);
  assertEqual('single len', m1!.symbols, ['A']);
  assertEqual('single diag', m1!.matrix[0].values[0], 1);
  assertEqual('single window', m1!.window_days, 4);
  assertEqual('single sample_size', m1!.sample_size, 1);

  // A 与 B 同方向, A 与 C 反方向
  const m2 = computeCorrelationMatrix(['A', 'B', 'C'], closes);
  assert('m2 not null', m2 !== null);
  assertEqual('m2 dim', m2!.symbols, ['A', 'B', 'C']);
  // 对角线 = 1
  assertEqual('m2 diag A', m2!.matrix[0].values[0], 1);
  assertEqual('m2 diag B', m2!.matrix[1].values[1], 1);
  assertEqual('m2 diag C', m2!.matrix[2].values[2], 1);
  // 对称: A-B == B-A
  assertEqual('symmetric AB=BA', m2!.matrix[0].values[1], m2!.matrix[1].values[0]);
  assertEqual('symmetric AC=CA', m2!.matrix[0].values[2], m2!.matrix[2].values[0]);
  // A 与 B 高正相关 (>0.9)
  const rAB = m2!.matrix[0].values[1]!;
  assert('A-B high positive', rAB > 0.9, `rAB=${rAB}`);
  // A 与 C 高负相关 (<-0.9)
  const rAC = m2!.matrix[0].values[2]!;
  assert('A-C high negative', rAC < -0.9, `rAC=${rAC}`);

  // 空 symbols / 空 closesMap → null
  assertEqual('empty symbols', computeCorrelationMatrix([], closes), null);
  assertEqual('null closesMap', computeCorrelationMatrix(['A'], null as any), null);

  // 数据不足 (1 个 close) → null
  const shortCloses = new Map<string, DailyCloseRow[]>();
  shortCloses.set('A', [{ date: '2026-06-01', close: 100 }]);
  assertEqual('1 close → null', computeCorrelationMatrix(['A'], shortCloses), null);

  // 不重叠日期 → intersect 不足 → null
  const noOverlap = new Map<string, DailyCloseRow[]>();
  noOverlap.set('A', [
    { date: '2026-06-01', close: 100 },
    { date: '2026-06-02', close: 101 },
    { date: '2026-06-03', close: 102 },
    { date: '2026-06-04', close: 103 },
  ]);
  noOverlap.set('B', [
    { date: '2026-06-10', close: 200 },
    { date: '2026-06-11', close: 201 },
    { date: '2026-06-12', close: 202 },
    { date: '2026-06-13', close: 203 },
  ]);
  assertEqual('no date overlap → null', computeCorrelationMatrix(['A', 'B'], noOverlap), null);

  // 常数序列 (方差 0) — 仍有矩阵, 但 A 与 D 那行/列为 null
  const constCloses = new Map<string, DailyCloseRow[]>(closes);
  constCloses.set('D', [
    { date: '2026-06-01', close: 100 },
    { date: '2026-06-02', close: 100 },
    { date: '2026-06-03', close: 100 },
    { date: '2026-06-04', close: 100 },
    { date: '2026-06-05', close: 100 },
  ]);
  const m3 = computeCorrelationMatrix(['A', 'D'], constCloses);
  assert('m3 not null (has A & D rows)', m3 !== null);
  assertEqual('m3 diag A', m3!.matrix[0].values[0], 1);
  assertEqual('m3 diag D', m3!.matrix[1].values[1], 1);
  assertEqual('A-D constant → null', m3!.matrix[0].values[1], null);
  assertEqual('D-A constant → null', m3!.matrix[1].values[0], null);
}

function testBuildCorrelationMatrixPayload(): void {
  const closes = new Map<string, DailyCloseRow[]>();
  closes.set('A', [
    { date: '2026-06-01', close: 100 },
    { date: '2026-06-02', close: 101 },
    { date: '2026-06-03', close: 102 },
    { date: '2026-06-04', close: 103 },
  ]);
  closes.set('B', [
    { date: '2026-06-01', close: 50 },
    { date: '2026-06-02', close: 51 },
    { date: '2026-06-03', close: 52 },
    { date: '2026-06-04', close: 53 },
  ]);
  // 完整 happy path
  const p = buildCorrelationMatrixPayload(
    [
      { symbol: 'A', market_value: 1000 },
      { symbol: 'B', market_value: 500 },
    ],
    [],
    closes
  );
  assert('payload not null', p !== null);
  assertEqual('symbols order', p!.symbols, ['A', 'B']);
  assertEqual('capped_n', p!.capped_n, 2);
  assertEqual('sample_size', p!.sample_size, 2);
  assertEqual('window_days', p!.window_days, 3);

  // 空持仓 / 空交易股 → null
  assertEqual('empty input', buildCorrelationMatrixPayload([], [], closes), null);

  // capped_n > sample_size (持仓多, closes 只覆盖部分)
  const partialCloses = new Map<string, DailyCloseRow[]>();
  partialCloses.set('A', closes.get('A')!);
  // B 没数据
  const p2 = buildCorrelationMatrixPayload(
    [
      { symbol: 'A', market_value: 1000 },
      { symbol: 'B', market_value: 500 },
    ],
    [],
    partialCloses
  );
  assert('p2 not null (A 可单独算)', p2 !== null);
  assertEqual('p2 only A', p2!.symbols, ['A']);
  assertEqual('p2 capped_n=2', p2!.capped_n, 2);
  assertEqual('p2 sample_size=1', p2!.sample_size, 1);
}

function testBuildCorrelationMatrixHtml(): void {
  // null → 空字符串 (整 section 不渲染)
  assertEqual('null → empty', buildCorrelationMatrixHtml(null), '');
  // 空 symbols → 空字符串
  const emptyP: CorrelationMatrixPayload = {
    symbols: [],
    matrix: [],
    window_days: 0,
    sample_size: 0,
    capped_n: 0,
  };
  assertEqual('empty symbols → empty', buildCorrelationMatrixHtml(emptyP), '');

  // 2x2 完整
  const p: CorrelationMatrixPayload = {
    symbols: ['A', 'B'],
    matrix: [
      { symbol: 'A', values: [1, 0.85] },
      { symbol: 'B', values: [0.85, 1] },
    ],
    window_days: 4,
    sample_size: 2,
    capped_n: 2,
  };
  const html = buildCorrelationMatrixHtml(p);
  assert('html includes header A', html.includes('A'));
  assert('html includes header B', html.includes('B'));
  assert('html includes corr value', html.includes('+0.85'));
  assert('html includes window_days', html.includes('4 日'));
  assert('html includes correlation icon', html.includes('🔗'));
  assert('html includes high-positive bg', html.includes('#fca5a5'));
  // 对角线深色
  assert('html includes diag styling', html.includes('1.00'));

  // capped_n > sample_size 触发"前 N 名 / 共 M 只" 提示
  const cappedP: CorrelationMatrixPayload = {
    ...p,
    capped_n: 5,
  };
  const cappedHtml = buildCorrelationMatrixHtml(cappedP);
  assert('html includes cap note', cappedHtml.includes('前 2 只') && cappedHtml.includes('共 5 只'));

  // null cell 渲染为 '—'
  const pNull: CorrelationMatrixPayload = {
    symbols: ['A', 'B'],
    matrix: [
      { symbol: 'A', values: [1, null] },
      { symbol: 'B', values: [null, 1] },
    ],
    window_days: 4,
    sample_size: 2,
    capped_n: 2,
  };
  const htmlNull = buildCorrelationMatrixHtml(pNull);
  assert('html includes — for null', htmlNull.includes('—'));
}

function testCorrelationConstantsFrozen(): void {
  assert('MAX_SYMBOLS > 0', CORRELATION_MAX_SYMBOLS > 0);
  assert('MIN_RETURNS >= 2', CORRELATION_MIN_RETURNS >= 2);
  // 不冻结 (常量本来就 const), 这里只断"暴露给单测"
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
    correlation_matrix: {
      symbols: ['600519.SH', '000858.SZ'],
      matrix: [
        { symbol: '600519.SH', values: [1, 0.78] },
        { symbol: '000858.SZ', values: [0.78, 1] },
      ],
      window_days: 4,
      sample_size: 2,
      capped_n: 2,
    },
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
      recommendations: ['设置移动止盈锁定收益', '降低单一行业曝光'],
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
  // US-125 PM-014 — recommendations 渲染
  assert('html 含 操作建议 section', mail.html.includes('操作建议'));
  assert('html 含 移动止盈 建议', mail.html.includes('设置移动止盈锁定收益'));
  assert('text 含 操作建议 line', !!mail.text && mail.text.includes('操作建议'));
  assert('text 含 移动止盈 建议', !!mail.text && mail.text.includes('设置移动止盈锁定收益'));
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
  // US-088 PM-012 — correlation matrix 渲染
  assert('html 含 相关性矩阵 section', mail.html.includes('持仓相关性矩阵'));
  assert('html 含 600519 列头', mail.html.includes('600519.SH'));
  assert('html 含 +0.78 corr', mail.html.includes('+0.78'));
  assert('html 含 日收益 window', mail.html.includes('4 日'));
  assert('text 含 相关性 section', !!mail.text && mail.text.includes('持仓相关性矩阵'));
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

// ---------------------------------------------------------------------------
// US-088 PM-012 — correlation matrix e2e
// ---------------------------------------------------------------------------
async function testSendCorrelationMatrixPropagates(): Promise<void> {
  // 持仓 A + B (同方向上涨), 上周 5 日 close 数据完整 → matrix 含 A/B 两 symbol
  const dailyCloses = new Map<string, DailyCloseRow[]>();
  dailyCloses.set('600519.SH', [
    { date: '2026-06-01', close: 1800 },
    { date: '2026-06-02', close: 1810 },
    { date: '2026-06-03', close: 1815 },
    { date: '2026-06-04', close: 1825 },
    { date: '2026-06-05', close: 1830 },
  ]);
  dailyCloses.set('000858.SZ', [
    { date: '2026-06-01', close: 150 },
    { date: '2026-06-02', close: 151 },
    { date: '2026-06-03', close: 151.5 },
    { date: '2026-06-04', close: 152.5 },
    { date: '2026-06-05', close: 153 },
  ]);
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: {
      1: {
        portfolio: { id: 100 },
        positions: [
          { symbol: '600519.SH', market_value: 90000 },
          { symbol: '000858.SZ', market_value: 30000 },
        ],
      },
    },
    snapshots: { 100: [{ date: '2026-06-01', total_value: 100000 }] },
    trades: { 100: [] },
    dailyCloses,
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08', dry_run: true });
  const cm = r.per_user[0].payload!.correlation_matrix;
  assert('correlation_matrix not null', cm !== null);
  assertEqual('cm symbols order', cm!.symbols, ['600519.SH', '000858.SZ']);
  assertEqual('cm sample_size', cm!.sample_size, 2);
  assertEqual('cm capped_n', cm!.capped_n, 2);
  assertEqual('cm window_days', cm!.window_days, 4);
  // 对角线 = 1
  assertEqual('cm diag A', cm!.matrix[0].values[0], 1);
  assertEqual('cm diag B', cm!.matrix[1].values[1], 1);
  // A 与 B 同方向上涨 → 高正相关
  const rAB = cm!.matrix[0].values[1]!;
  assert('cm AB high positive', rAB > 0.8, `rAB=${rAB}`);
  // 对称
  assertEqual('cm symmetric AB=BA', cm!.matrix[0].values[1], cm!.matrix[1].values[0]);
}

async function testSendCorrelationMatrixFailureNull(): Promise<void> {
  // loadDailyCloses throw → fail-OPEN → correlation_matrix=null, 主流程不挂
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: {
      1: {
        portfolio: { id: 100 },
        positions: [{ symbol: '600519.SH', market_value: 100 }],
      },
    },
    snapshots: { 100: [{ date: '2026-06-01', total_value: 100000 }] },
    trades: { 100: [] },
    throwOn: { loadDailyCloses: true },
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08', dry_run: true });
  // 主流程不挂 + correlation_matrix=null
  assertEqual('throw → dry_run sent', r.sent_count, 1);
  assertEqual('throw → correlation_matrix=null', r.per_user[0].payload!.correlation_matrix, null);
  // strategy_contribution 仍 OK (独立链路)
  assert(
    'throw → strategy_contribution still present',
    Array.isArray(r.per_user[0].payload!.strategy_contribution)
  );
}

async function testSendCorrelationEmptyPositionsNull(): Promise<void> {
  // 持仓为空 + 交易也空 → 不调 loadDailyCloses, correlation_matrix=null
  const state: FakeState = {
    users: [eligibleUser(1, 'lym')],
    portfolios: { 1: { portfolio: { id: 100 }, positions: [] } },
    snapshots: { 100: [{ date: '2026-06-01', total_value: 100000 }] },
    trades: { 100: [] },
    // 故意设 dailyCloses (但因为没 selected symbols 不应被调用)
    dailyCloses: new Map([['X', [{ date: '2026-06-01', close: 100 }]]]),
  };
  const svc = new WeeklyReviewReportService(makeFakeDataSource(state));
  const r = await svc.sendWeeklyReviewReports({ reference_date: '2026-06-08', dry_run: true });
  assertEqual('empty positions → null', r.per_user[0].payload!.correlation_matrix, null);
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
    async loadTradeStrategyMap() {
      return new Map<number, string>();
    },
    async loadDailyCloses() {
      return new Map<string, DailyCloseRow[]>();
    },
    async loadStockMetadata() {
      return new Map();
    },
    async loadUpcomingEvents() {
      return [];
    },
    async generateAIWeeklyOpinion() {
      return { source: 'heuristic', headline: 'x', paragraphs: [], recommendations: [] };
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
// US-125 PM-014 — AIWeeklyOpinion 字数 budget + remote payload 解析 + remote call
// ---------------------------------------------------------------------------

function testCountChineseChars(): void {
  assertEqual('empty → 0', countChineseChars(''), 0);
  assertEqual('null → 0', countChineseChars(null as any), 0);
  assertEqual('纯中文', countChineseChars('一二三四五'), 5);
  assertEqual('混合数字', countChineseChars('涨幅 +5.00%'), 2);
  assertEqual('混合英文', countChineseChars('AI 周观点'), 3);
  assertEqual('标点不计', countChineseChars('涨，跌。'), 2);
}

function testCountOpinionChineseChars(): void {
  const o: AIWeeklyOpinion = {
    source: 'heuristic',
    headline: '一二三', // 3
    paragraphs: ['四五', '六七八'], // 2 + 3
    recommendations: ['九十'], // 2
  };
  assertEqual('合计', countOpinionChineseChars(o), 10);
}

function testClampOpinionMin(): void {
  // 不够 200 字 → 自动补 recommendations
  const short: AIWeeklyOpinion = {
    source: 'heuristic',
    headline: '组合本周平稳。',
    paragraphs: ['本周整体波动较小。'],
    recommendations: ['观察一周再决定。'],
  };
  const out = clampOpinionToWordBudget(short);
  assert(
    `clamp min: ≥ ${WEEKLY_OPINION_MIN_CHARS}`,
    countOpinionChineseChars(out) >= WEEKLY_OPINION_MIN_CHARS ||
      // 边界: 填料用完仍不够时不强补 (HEURISTIC_FILLER_RECOMMENDATIONS 才 5 条),
      // 但 5 条加完肯定 > 200, 所以正常路径必满足.
      out.recommendations.length >= 5
  );
  assert('clamp min: recommendations 不空', out.recommendations.length >= 1);
  assert('clamp min: headline 不变', out.headline === short.headline);
}

function testClampOpinionMax(): void {
  // 超 300 字 → 截 recommendations 优先
  const longRec = Array.from({ length: 10 }, (_, i) =>
    `第${i + 1}条建议非常非常非常非常非常非常长长长长长长长长长长长长长长`
  );
  const longParas = Array.from({ length: 5 }, (_, i) =>
    `第${i + 1}段叙述非常非常非常非常非常非常长长长长长长长长长长长长长长`
  );
  const long: AIWeeklyOpinion = {
    source: 'remote',
    headline: '组合本周大幅跑赢',
    paragraphs: longParas,
    recommendations: longRec,
  };
  const out = clampOpinionToWordBudget(long);
  assert(
    `clamp max: ≤ ${WEEKLY_OPINION_MAX_CHARS}`,
    countOpinionChineseChars(out) <= WEEKLY_OPINION_MAX_CHARS
  );
  assert('clamp max: headline 保留', out.headline === long.headline);
  assert('clamp max: paragraphs 至少保留 1 段', out.paragraphs.length >= 1);
}

function testBuildHeuristicWeeklyOpinionWordBudget(): void {
  // AC: 输出 ≥ 200 字
  const cases: Array<Parameters<typeof buildHeuristicWeeklyOpinion>[0]> = [
    { pnl_pct: null, industry_contribution: [], top_winners: [], top_losers: [], upcoming_events: [] },
    { pnl_pct: 5, industry_contribution: [], top_winners: [], top_losers: [], upcoming_events: [] },
    { pnl_pct: 2, industry_contribution: [], top_winners: [], top_losers: [], upcoming_events: [] },
    { pnl_pct: 0, industry_contribution: [], top_winners: [], top_losers: [], upcoming_events: [] },
    { pnl_pct: -2, industry_contribution: [], top_winners: [], top_losers: [], upcoming_events: [] },
    { pnl_pct: -5, industry_contribution: [], top_winners: [], top_losers: [], upcoming_events: [] },
    {
      pnl_pct: -5,
      industry_contribution: [
        { industry: '半导体', realized_pnl: -3000, trade_count: 2, symbols: ['c'] },
      ],
      top_winners: [],
      top_losers: [
        { symbol: '000725.SZ', name: '京东方A', industry: '半导体', realized_pnl: -2000, trade_count: 1 },
      ],
      upcoming_events: [
        { symbol: '600519.SH', name: '茅台', event_type: 'earnings_forecast', detail: 'x', announce_date: null },
      ],
    },
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const out = buildHeuristicWeeklyOpinion(cases[i]);
    const n = countOpinionChineseChars(out);
    assert(`case[${i}] ≥ ${WEEKLY_OPINION_MIN_CHARS} 字`, n >= WEEKLY_OPINION_MIN_CHARS, `actual=${n} headline=${out.headline}`);
    assert(`case[${i}] ≤ ${WEEKLY_OPINION_MAX_CHARS} 字`, n <= WEEKLY_OPINION_MAX_CHARS, `actual=${n}`);
    assert(`case[${i}] recommendations 非空`, out.recommendations.length > 0);
    assertEqual(`case[${i}] source`, out.source, 'heuristic');
  }
}

function testParseRemoteWeeklyOpinionPayload(): void {
  // null / undefined / 非对象
  assertEqual('null → null', parseRemoteWeeklyOpinionPayload(null), null);
  assertEqual('undefined → null', parseRemoteWeeklyOpinionPayload(undefined), null);
  assertEqual('string → null', parseRemoteWeeklyOpinionPayload('foo'), null);

  // status 错误
  assertEqual(
    'status FAILED → null',
    parseRemoteWeeklyOpinionPayload({ status: 'FAILED', data: { headline: 'x' } }),
    null
  );

  // headline 缺失
  assertEqual(
    'no headline → null',
    parseRemoteWeeklyOpinionPayload({ status: 'success', data: { paragraphs: ['x'] } }),
    null
  );

  // 内容全空
  assertEqual(
    'empty content → null',
    parseRemoteWeeklyOpinionPayload({
      status: 'success',
      data: { headline: '组合', paragraphs: [], recommendations: [] },
    }),
    null
  );

  // happy path (status=success + data wrapper)
  const ok = parseRemoteWeeklyOpinionPayload({
    status: 'success',
    data: {
      headline: '组合本周大幅跑赢',
      paragraphs: ['行业贡献集中在白酒。', '个股贡献集中在茅台。'],
      recommendations: ['锁定收益。', '降低敞口。'],
    },
  });
  assert('happy 解析成功', ok !== null);
  assertEqual('happy source', ok!.source, 'remote');
  assertEqual('happy headline', ok!.headline, '组合本周大幅跑赢');
  assertEqual('happy paragraphs 长度', ok!.paragraphs.length, 2);
  assertEqual('happy recommendations 长度', ok!.recommendations.length, 2);

  // 无 status wrapper (data 直接顶层)
  const direct = parseRemoteWeeklyOpinionPayload({
    headline: '组合',
    paragraphs: ['段一'],
    recommendations: [],
  });
  assert('direct 解析成功', direct !== null);

  // 过滤掉非字符串元素
  const mixed = parseRemoteWeeklyOpinionPayload({
    status: 'success',
    data: { headline: '组合', paragraphs: ['段一', null, 123, 'segment 2'], recommendations: ['建议'] },
  });
  assertEqual('mixed paragraphs 过滤', mixed!.paragraphs.length, 2);
}

async function testCallRemoteWeeklyOpinionAxiosInjected(): Promise<void> {
  // Happy path: 注入 axios 返合规 payload
  const captured: Array<{ url: string; body: any; opts: any }> = [];
  const ok = await callRemoteWeeklyOpinion(
    {
      pnl_pct: 5,
      industry_contribution: [],
      top_winners: [],
      top_losers: [],
      upcoming_events: [],
    },
    {
      baseUrl: 'http://fake-trading-agents:9999',
      timeoutMs: 1234,
      axiosImpl: {
        async post(url, body, opts) {
          captured.push({ url, body, opts });
          return {
            data: {
              status: 'success',
              data: {
                headline: '组合本周大幅跑赢',
                paragraphs: ['段一段二。'],
                recommendations: ['建议一。'],
              },
            },
          };
        },
      },
    }
  );
  assert('remote 调用成功', ok !== null);
  assertEqual('remote source', ok!.source, 'remote');
  assertEqual('axios 命中 url', captured[0].url, 'http://fake-trading-agents:9999/api/weekly-opinion');
  assertEqual('axios 命中 timeout', captured[0].opts.timeout, 1234);
  assert('axios body 含 pnl_pct', captured[0].body.pnl_pct === 5);
  assert('axios body 含 word_budget', !!captured[0].body.word_budget);

  // Throw path
  const failed = await callRemoteWeeklyOpinion(
    { pnl_pct: 0, industry_contribution: [], top_winners: [], top_losers: [], upcoming_events: [] },
    {
      axiosImpl: {
        async post() {
          throw new Error('boom');
        },
      },
    }
  );
  assertEqual('remote throw → null', failed, null);

  // Bad-shape response → null
  const bad = await callRemoteWeeklyOpinion(
    { pnl_pct: 0, industry_contribution: [], top_winners: [], top_losers: [], upcoming_events: [] },
    {
      axiosImpl: {
        async post() {
          return { data: { status: 'success', data: { paragraphs: ['x'] } } }; // 无 headline
        },
      },
    }
  );
  assertEqual('remote bad shape → null', bad, null);
}

async function testGenerateAIWeeklyOpinionRemoteShortFallback(): Promise<void> {
  // 直接对 DefaultWeeklyReviewDataSource 走 generateAIWeeklyOpinion, 注入 axios
  // 让 remote 返合规但 < 200 字 — 应自动降级到 heuristic.
  const { DefaultWeeklyReviewDataSource } = await import(
    '../../src/services/WeeklyReviewReportService'
  );
  // 直接 monkey-patch 实例的 generateAIWeeklyOpinion 行不通 (依赖 require('axios')),
  // 改用 callRemoteWeeklyOpinion + clamp + 降级条件 重演 service 内逻辑.
  const remote = await callRemoteWeeklyOpinion(
    { pnl_pct: 5, industry_contribution: [], top_winners: [], top_losers: [], upcoming_events: [] },
    {
      axiosImpl: {
        async post() {
          return {
            data: {
              status: 'success',
              data: {
                headline: '组合本周大幅跑赢',
                paragraphs: ['短。'],
                recommendations: ['短。'],
              },
            },
          };
        },
      },
    }
  );
  assert('remote 解析非 null', remote !== null);
  const clamped = clampOpinionToWordBudget(remote!);
  // remote 内容短, clamp 也只能补到 filler 范围 (≥ 200 字)
  assert(
    'clamp 后 ≥ 200 字',
    countOpinionChineseChars(clamped) >= WEEKLY_OPINION_MIN_CHARS
  );
  // service 内逻辑: 若 clamp 仍 < 200 字才降级 — 此处 clamp 后会拼足
  // (filler 5 条每条 ~30 字, 加 1-2 条就够 200). 主要验 clamp 行为正确, 降级路径
  // 由下面 meta-guard 验.
  void DefaultWeeklyReviewDataSource;
}

function testMetaGuardRemoteFallbackBehavior(): void {
  // META-GUARD: 源文件正则扫 generateAIWeeklyOpinion 必须含
  // (1) callRemoteWeeklyOpinion (远端入口)
  // (2) clampOpinionToWordBudget (字数 budget 必走)
  // (3) WEEKLY_OPINION_MIN_CHARS 短文降级判定
  // (4) try/catch (fail-OPEN)
  // (5) heuristic 兜底 (buildHeuristicWeeklyOpinion)
  // 与 cron-registry / sizing-limit-consistency 同款 meta-guard 范式.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/WeeklyReviewReportService.ts'),
    'utf8'
  );
  assert('meta: 含 callRemoteWeeklyOpinion call', /await\s+callRemoteWeeklyOpinion\s*\(/.test(src));
  assert('meta: 含 clampOpinionToWordBudget', /clampOpinionToWordBudget\s*\(/.test(src));
  assert('meta: 含 WEEKLY_OPINION_MIN_CHARS gate', /WEEKLY_OPINION_MIN_CHARS/.test(src));
  assert(
    'meta: generateAIWeeklyOpinion 含 try',
    /generateAIWeeklyOpinion[\s\S]{0,800}try\s*\{/.test(src)
  );
  assert('meta: 含 heuristic 兜底', /buildHeuristicWeeklyOpinion\s*\(/.test(src));
  assert(
    'meta: AIWeeklyOpinion 含 recommendations 字段',
    /recommendations\s*:\s*string\s*\[\s*\]/.test(src)
  );
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
  testComputePearsonEdges();
  testDailyReturnsFromCloses();
  testSelectCorrelationSymbols();
  testComputeCorrelationMatrix();
  testBuildCorrelationMatrixPayload();
  testBuildCorrelationMatrixHtml();
  testCorrelationConstantsFrozen();
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
  await testSendCorrelationMatrixPropagates();
  await testSendCorrelationMatrixFailureNull();
  await testSendCorrelationEmptyPositionsNull();
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

  // US-125 PM-014
  testCountChineseChars();
  testCountOpinionChineseChars();
  testClampOpinionMin();
  testClampOpinionMax();
  testBuildHeuristicWeeklyOpinionWordBudget();
  testParseRemoteWeeklyOpinionPayload();
  await testCallRemoteWeeklyOpinionAxiosInjected();
  await testGenerateAIWeeklyOpinionRemoteShortFallback();
  testMetaGuardRemoteFallbackBehavior();

  console.log(`\n────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log(`────────────────────────────────────`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
