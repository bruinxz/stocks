/**
 * DailyTradingDigestService 单元测试 (US-063 飞书机器人当日交易日报)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/daily-trading-digest-service.test.ts
 *
 * 完全脱离 DB / 网络：注入 fake DailyTradingDigestDataSource。
 *
 * 覆盖维度：
 *   - 常量冻结 (DEFAULT_NOTIFICATION_CONFIG / DIGEST_STATUS)
 *   - 纯函数:
 *     - normalizeNotificationConfig（缺失 / 部分字段 / 非法 boolean / 非法 string / 嵌套 null）
 *     - shouldSendForUser（4 路径：未启用 / digest 关 / 缺 URL / 通过；env fallback）
 *     - pickTopTrades（空 / 反向过滤 / 按 amount 降序 / tie-break stable / cap）
 *     - pickTopCandidates（ETF 轮动候选 / 缺 strategy 跳过 / cap / score 降序 + tie-break / NaN score 在末位）
 *     - computePnLSummary（prev 缺失 fallback initial_capital / pct 计算 / prev<=0 时 null）
 *     - buildPnLLine（正/负/0 / pct null / sign 前缀）
 *     - formatTradeLine（BUY / SELL with realized_pnl）
 *     - formatCandidateLine（ETF 轮动 label / score 缺失 / reason 截断）
 *     - formatMoney（千分位 / 小数 / 负数 / 0 / NaN）
 *     - formatPercent（正/负/0/NaN）
 *     - buildDigestId（YYYYMMDD 拆分 / rand4 padding）
 *     - buildDigestCard（header template by PnL sign / sections 顺序 / 空 trade 兜底）
 *   - service.sendDigests() e2e:
 *     - 无 user 注册 → scanned=0；
 *     - user 启用 + 有 portfolio + 有 trade → status='sent' sent=true；
 *     - user 启用但无 portfolio → status='skipped' skip_reason 含 "尚未建立"；
 *     - user digest=false → status='skipped' skip_reason 含 "关闭"；
 *     - user 缺 webhook URL + 无 env fallback → status='skipped' skip_reason 含 "未配置 webhook"；
 *     - sendFeishuCard throw → fail-OPEN → status='failed' error 填充；
 *     - sendFeishuCard 返回 success=false → status='partial'；
 *     - dry_run=true → status='sent' 但 sent=false skip_reason='dry_run' webhook 未调用；
 *     - listEligibleUsers throw → 顶层 catch → 返回空 per_user；
 *     - 多个 user：A 成功 + B 失败 → per_user 各自独立 status 不串扰；
 *     - per_strategy_limit override 透传给 loadTomorrowCandidates；
 *     - per_direction_trade_limit cap 生效；
 *     - candidates load 失败 → 仍发送（candidates 空）。
 */

import {
  DailyTradingDigestService,
  DailyTradingDigestDataSource,
  NotificationChannelsConfig,
  DigestTradeRow,
  DigestCandidateRow,
  DigestPayload,
  DIGEST_STATUS,
  DEFAULT_NOTIFICATION_CONFIG,
  normalizeNotificationConfig,
  shouldSendForUser,
  pickTopTrades,
  pickTopCandidates,
  computePnLSummary,
  buildPnLLine,
  formatTradeLine,
  formatCandidateLine,
  formatMoney,
  formatPercent,
  buildDigestId,
  buildDigestCard,
} from '../../src/services/DailyTradingDigestService';
import { FeishuBotWebhookSendResult } from '../../src/services/FeishuBotWebhookService';

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

// ---------------------------------------------------------------------------
// Fake DataSource state
// ---------------------------------------------------------------------------

interface FakeState {
  users?: Array<{
    user_id: number;
    username: string;
    config: NotificationChannelsConfig;
  }>;
  /** user_id → { portfolio, positions } | null（null = 用户无 portfolio） */
  portfolios?: Record<
    number,
    {
      portfolio: { id: number; total_value: number; current_cash: number; initial_capital: number };
      positions: Array<{ market_value: number; symbol: string }>;
    } | null
  >;
  /** portfolio_id → trades */
  trades?: Record<
    number,
    Array<{
      symbol: string;
      name: string;
      direction: 'BUY' | 'SELL';
      quantity: number;
      execute_price: number;
      amount: number;
      realized_pnl?: number | null;
    }>
  >;
  /** portfolio_id → recent snapshots（DESC by date） */
  snapshots?: Record<number, Array<{ date: string; total_value: number }>>;
  /** 候选 list */
  candidates?: DigestCandidateRow[];
  /** loadTomorrowCandidates throw 模拟 */
  candidatesShouldThrow?: boolean;
  /** listEligibleUsers throw 模拟 */
  listShouldThrow?: boolean;
  /** loadPortfolioSummary throw 模拟（user_id 粒度） */
  portfolioShouldThrowFor?: Set<number>;
  /** loadTodayTrades throw 模拟（portfolio_id 粒度） */
  tradesShouldThrowFor?: Set<number>;
  /** loadRecentSnapshots throw 模拟 */
  snapshotsShouldThrowFor?: Set<number>;
  /** sendFeishuCard 模拟（webhook → result）；fn override 时优先 */
  sendResult?:
    | FeishuBotWebhookSendResult
    | ((payload: DigestPayload, url: string) => FeishuBotWebhookSendResult);
  /** sendFeishuCard throw 模拟 */
  sendShouldThrow?: boolean;
  /** 已发送的 [webhook_url, payload] 录制 */
  sentLog?: Array<{ webhook_url: string; payload: DigestPayload }>;
}

function makeFakeDataSource(state: FakeState): {
  ds: DailyTradingDigestDataSource;
  state: FakeState;
} {
  state.sentLog = [];
  const ds: DailyTradingDigestDataSource = {
    async listEligibleUsers(opts) {
      if (state.listShouldThrow) throw new Error('mock listEligibleUsers throw');
      let users = state.users || [];
      if (opts?.user_id !== undefined) {
        users = users.filter(u => u.user_id === opts.user_id);
      }
      return users;
    },
    async loadPortfolioSummary(user_id) {
      if (state.portfolioShouldThrowFor && state.portfolioShouldThrowFor.has(user_id)) {
        throw new Error('mock loadPortfolioSummary throw');
      }
      const entry = state.portfolios?.[user_id];
      if (!entry) return null;
      return { portfolio: entry.portfolio as any, positions: entry.positions as any };
    },
    async loadTodayTrades(portfolio_id, _trade_date) {
      if (state.tradesShouldThrowFor && state.tradesShouldThrowFor.has(portfolio_id)) {
        throw new Error('mock loadTodayTrades throw');
      }
      const trades = state.trades?.[portfolio_id] || [];
      return trades.map(t => ({ ...t })) as any;
    },
    async loadRecentSnapshots(portfolio_id, _limit) {
      if (state.snapshotsShouldThrowFor && state.snapshotsShouldThrowFor.has(portfolio_id)) {
        throw new Error('mock loadRecentSnapshots throw');
      }
      return (state.snapshots?.[portfolio_id] || []).slice();
    },
    async loadTomorrowCandidates(_opts) {
      if (state.candidatesShouldThrow) throw new Error('mock loadTomorrowCandidates throw');
      return (state.candidates || []).slice();
    },
    async sendFeishuCard(payload, webhook_url) {
      if (state.sendShouldThrow) throw new Error('mock sendFeishuCard throw');
      state.sentLog!.push({ webhook_url, payload });
      if (typeof state.sendResult === 'function') {
        return (state.sendResult as any)(payload, webhook_url);
      }
      return state.sendResult || { success: true };
    },
  };
  return { ds, state };
}

function makeBaseConfig(
  overrides: Partial<NotificationChannelsConfig['feishu']> = {}
): NotificationChannelsConfig {
  return {
    feishu: {
      enabled: true,
      webhook_url: 'https://hooks.example.com/webhook-A',
      daily_digest: true,
      earnings_alert: true,
      risk_alert: true,
      ...overrides,
    },
    email: { ...DEFAULT_NOTIFICATION_CONFIG.email },
    wechat: { ...DEFAULT_NOTIFICATION_CONFIG.wechat },
  };
}

function makePortfolioPair(opts: {
  user_id: number;
  portfolio_id: number;
  total_value?: number;
  current_cash?: number;
  initial_capital?: number;
  positions_market_value?: number;
}) {
  return {
    portfolio: {
      id: opts.portfolio_id,
      total_value: opts.total_value ?? 210000,
      current_cash: opts.current_cash ?? 100000,
      initial_capital: opts.initial_capital ?? 200000,
    },
    positions: [{ symbol: '002594.SZ', market_value: opts.positions_market_value ?? 110000 }],
  };
}

// ---------------------------------------------------------------------------
// Constants frozen
// ---------------------------------------------------------------------------

function testConstantsFrozen(): void {
  assertEqual('DIGEST_STATUS keys', Object.keys(DIGEST_STATUS).sort(), [
    'FAILED',
    'PARTIAL',
    'SENT',
    'SKIPPED',
  ]);
  assert('DIGEST_STATUS frozen', Object.isFrozen(DIGEST_STATUS));
  assert('DEFAULT_NOTIFICATION_CONFIG frozen', Object.isFrozen(DEFAULT_NOTIFICATION_CONFIG));
  assertEqual('DEFAULT feishu daily_digest', DEFAULT_NOTIFICATION_CONFIG.feishu.daily_digest, true);
  assertEqual('DEFAULT email enabled', DEFAULT_NOTIFICATION_CONFIG.email.enabled, false);
}

// ---------------------------------------------------------------------------
// normalizeNotificationConfig
// ---------------------------------------------------------------------------

function testNormalizeNotificationConfig(): void {
  const def = normalizeNotificationConfig(null);
  assertEqual('normalize null → default feishu.enabled', def.feishu.enabled, true);
  assertEqual('normalize null → default email.enabled', def.email.enabled, false);

  const def2 = normalizeNotificationConfig('bad-input');
  assertEqual('normalize string → default', def2.feishu.enabled, true);

  const def3 = normalizeNotificationConfig({ position_limits: {} });
  assertEqual('normalize missing nc → default', def3.feishu.daily_digest, true);

  const partial = normalizeNotificationConfig({
    notification_channels: {
      feishu: { enabled: false, webhook_url: 'https://custom.example.com/h' },
    },
  });
  assertEqual('partial enabled override', partial.feishu.enabled, false);
  assertEqual('partial webhook_url override', partial.feishu.webhook_url, 'https://custom.example.com/h');
  assertEqual('partial daily_digest fallback default', partial.feishu.daily_digest, true);
  assertEqual('partial email.enabled fallback default', partial.email.enabled, false);

  const strBool = normalizeNotificationConfig({
    notification_channels: { feishu: { enabled: 'yes', daily_digest: 'false', risk_alert: '1' } },
  });
  assertEqual('string bool yes → true', strBool.feishu.enabled, true);
  assertEqual('string bool false → false', strBool.feishu.daily_digest, false);
  assertEqual('string bool 1 → true', strBool.feishu.risk_alert, true);

  const garbage = normalizeNotificationConfig({
    notification_channels: { feishu: 42, wechat: ['no'], email: null },
  });
  assertEqual('garbage feishu → default', garbage.feishu.enabled, true);
  assertEqual('garbage wechat → default', garbage.wechat.enabled, false);

  const nullUrl = normalizeNotificationConfig({
    notification_channels: { feishu: { webhook_url: null } },
  });
  assertEqual('null webhook_url → empty string', nullUrl.feishu.webhook_url, '');
}

// ---------------------------------------------------------------------------
// shouldSendForUser
// ---------------------------------------------------------------------------

function testShouldSendForUser(): void {
  const off = shouldSendForUser(makeBaseConfig({ enabled: false }), false);
  assertEqual('feishu disabled → no', off.shouldSend, false);
  assert('feishu disabled reason has 未启用', String(off.reason).includes('未启用'));

  const digestOff = shouldSendForUser(makeBaseConfig({ daily_digest: false }), false);
  assertEqual('daily_digest disabled → no', digestOff.shouldSend, false);
  assert('digest disabled reason 关闭', String(digestOff.reason).includes('关闭'));

  const noUrl = shouldSendForUser(makeBaseConfig({ webhook_url: '' }), false);
  assertEqual('no URL no env → no', noUrl.shouldSend, false);

  const noUrlEnv = shouldSendForUser(makeBaseConfig({ webhook_url: '' }), true);
  assertEqual('no URL with env → yes', noUrlEnv.shouldSend, true);

  const ok = shouldSendForUser(makeBaseConfig(), false);
  assertEqual('all good → yes', ok.shouldSend, true);
  assertEqual('all good no reason', ok.reason, undefined);
}

// ---------------------------------------------------------------------------
// pickTopTrades
// ---------------------------------------------------------------------------

function testPickTopTrades(): void {
  assertEqual('empty trades', pickTopTrades([], 'BUY', 3), []);
  assertEqual('non-array', pickTopTrades(null as any, 'BUY', 3), []);

  const trades: DigestTradeRow[] = [
    { symbol: 'B', name: 'B', direction: 'BUY', quantity: 100, execute_price: 10, amount: 1000 },
    { symbol: 'A', name: 'A', direction: 'BUY', quantity: 100, execute_price: 20, amount: 2000 },
    { symbol: 'C', name: 'C', direction: 'SELL', quantity: 100, execute_price: 30, amount: 3000 },
    { symbol: 'D', name: 'D', direction: 'BUY', quantity: 100, execute_price: 10, amount: 1000 },
  ];

  const buys = pickTopTrades(trades, 'BUY', 5);
  assertEqual('BUY count', buys.length, 3);
  assertEqual('BUY top by amount desc', buys[0].symbol, 'A');
  assertEqual('BUY tie-break B before D', [buys[1].symbol, buys[2].symbol], ['B', 'D']);

  const top2 = pickTopTrades(trades, 'BUY', 2);
  assertEqual('cap 2', top2.length, 2);

  const top100 = pickTopTrades(trades, 'BUY', 100);
  assertEqual('cap 100 clamped (still 3 buys)', top100.length, 3);

  const sells = pickTopTrades(trades, 'SELL', 3);
  assertEqual('SELL count', sells.length, 1);
  assertEqual('SELL symbol', sells[0].symbol, 'C');
}

// ---------------------------------------------------------------------------
// pickTopCandidates
// ---------------------------------------------------------------------------

function testPickTopCandidates(): void {
  assertEqual('empty', pickTopCandidates([], 5), []);

  const cands: DigestCandidateRow[] = [
    { strategy: 'etf_rotation', symbol: 'ETF-1', score: 90 },
    { strategy: 'etf_rotation', symbol: 'ETF-2', score: 80 },
    { strategy: 'etf_rotation', symbol: 'ETF-3', score: 70 },
    { strategy: 'etf_rotation', symbol: 'ETF-B-NaN', score: NaN },
    { strategy: 'etf_rotation', symbol: 'ETF-A-NoScore' },
    { strategy: 'etf_rotation', symbol: 'ETF-tie', score: 90 },
  ];

  const all = pickTopCandidates(cands, 10);
  const etfSymbols = all.map(c => c.symbol);
  assertEqual('ETF tie-break ETF-1 before ETF-tie', etfSymbols.slice(0, 2), ['ETF-1', 'ETF-tie']);
  assertEqual('ETF finite scores descend', etfSymbols.slice(2, 4), ['ETF-2', 'ETF-3']);
  assertEqual('ETF missing/NaN scores sort last by symbol', etfSymbols.slice(4), [
    'ETF-A-NoScore',
    'ETF-B-NaN',
  ]);

  const limited = pickTopCandidates(cands, 1);
  assertEqual('cap 1 for ETF rotation', limited.map(c => c.symbol), ['ETF-1']);

  const badCands: DigestCandidateRow[] = [
    { strategy: '' as any, symbol: 'X', score: 1 },
    { strategy: 'etf_rotation', symbol: '', score: 1 },
    { strategy: 'etf_rotation', symbol: 'GOOD', score: 1 },
  ];
  const filtered = pickTopCandidates(badCands, 5);
  assertEqual('filtered invalid rows', filtered.length, 1);
  assertEqual('filtered keeps GOOD', filtered[0].symbol, 'GOOD');
}

// ---------------------------------------------------------------------------
// computePnLSummary
// ---------------------------------------------------------------------------

function testComputePnLSummary(): void {
  const r = computePnLSummary({
    total_value: 210000,
    current_cash: 100000,
    initial_capital: 200000,
    positions_market_value: 110000,
    prev_snapshot_total_value: 205000,
  });
  assertEqual('pnl_today = 5000', r.pnl_today, 5000);
  assertEqual('pnl_today_pct = 2.44', r.pnl_today_pct, 2.44);
  assertEqual('total_value', r.total_value, 210000);
  assertEqual('prev_total_value', r.prev_total_value, 205000);
  assertEqual('position_value', r.position_value, 110000);

  const fb = computePnLSummary({
    total_value: 201500,
    current_cash: 200000,
    initial_capital: 200000,
    positions_market_value: 1500,
    prev_snapshot_total_value: null,
  });
  assertEqual('fallback prev = initial_capital', fb.prev_total_value, 200000);
  assertEqual('fallback pnl_today', fb.pnl_today, 1500);
  assertEqual('fallback pnl_today_pct', fb.pnl_today_pct, 0.75);

  const zero = computePnLSummary({
    total_value: 100,
    current_cash: 100,
    initial_capital: 0,
    positions_market_value: 0,
    prev_snapshot_total_value: 0,
  });
  assertEqual('prev=0 → pct null', zero.pnl_today_pct, null);

  const nan = computePnLSummary({
    total_value: NaN,
    current_cash: NaN,
    initial_capital: 200000,
    positions_market_value: 0,
    prev_snapshot_total_value: 200000,
  });
  assertEqual('NaN total → 0', nan.total_value, 0);
  assertEqual('NaN total → pnl = -200000', nan.pnl_today, -200000);
}

// ---------------------------------------------------------------------------
// buildPnLLine
// ---------------------------------------------------------------------------

function testBuildPnLLine(): void {
  const profit = buildPnLLine({
    total_value: 0,
    prev_total_value: 0,
    position_value: 0,
    current_cash: 0,
    pnl_today: 1234.56,
    pnl_today_pct: 0.62,
  });
  assert('profit + prefix', profit.includes('+1,234.56') && profit.includes('+0.62%'));

  const loss = buildPnLLine({
    total_value: 0,
    prev_total_value: 0,
    position_value: 0,
    current_cash: 0,
    pnl_today: -1234.56,
    pnl_today_pct: -0.62,
  });
  assert('loss no + prefix on amount', !loss.includes('+-'));
  assert('loss has - on amount', loss.includes('-1,234.56'));
  assert('loss has - on pct', loss.includes('-0.62%'));

  const flat = buildPnLLine({
    total_value: 0,
    prev_total_value: 0,
    position_value: 0,
    current_cash: 0,
    pnl_today: 0,
    pnl_today_pct: 0,
  });
  assert('flat no sign', flat.includes('0.00 元'));

  const nopct = buildPnLLine({
    total_value: 0,
    prev_total_value: 0,
    position_value: 0,
    current_cash: 0,
    pnl_today: 100,
    pnl_today_pct: null,
  });
  assert('no pct skipped paren', !nopct.includes('('));
}

// ---------------------------------------------------------------------------
// formatTradeLine
// ---------------------------------------------------------------------------

function testFormatTradeLine(): void {
  const buy = formatTradeLine({
    symbol: '002594',
    name: '比亚迪',
    direction: 'BUY',
    quantity: 100,
    execute_price: 185.34,
    amount: 18534,
  });
  assert('buy has 买入', buy.includes('买入'));
  assert('buy has @185.34', buy.includes('@185.34'));
  assert('buy has = 18,534.00', buy.includes('= 18,534.00'));
  assert('buy no pnl', !buy.includes('盈亏'));

  const sell = formatTradeLine({
    symbol: '002594',
    name: '比亚迪',
    direction: 'SELL',
    quantity: 100,
    execute_price: 200,
    amount: 20000,
    realized_pnl: 1466,
  });
  assert('sell has 卖出', sell.includes('卖出'));
  assert('sell has 盈亏 +1,466.00', sell.includes('盈亏 +1,466.00'));

  const sellLoss = formatTradeLine({
    symbol: '002594',
    name: '',
    direction: 'SELL',
    quantity: 100,
    execute_price: 100,
    amount: 10000,
    realized_pnl: -500,
  });
  assert('sell loss no + on negative', !sellLoss.includes('盈亏 +-'));
  assert('sell loss has 盈亏 -500.00', sellLoss.includes('盈亏 -500.00'));

  const noname = formatTradeLine({
    symbol: '600519',
    name: '',
    direction: 'BUY',
    quantity: 100,
    execute_price: 1700,
    amount: 170000,
  });
  assert('noname falls back to symbol', noname.includes('600519 600519'));
}

// ---------------------------------------------------------------------------
// formatCandidateLine
// ---------------------------------------------------------------------------

function testFormatCandidateLine(): void {
  const etf = formatCandidateLine({
    strategy: 'etf_rotation',
    symbol: '159995',
    name: '芯片ETF华夏',
    score: 91.2,
  });
  assert('ETF rotation label', etf.includes('[ETF轮动]'));
  assert('ETF rotation score', etf.includes('分 91.2'));

  const noScore = formatCandidateLine({
    strategy: 'etf_rotation',
    symbol: '512290',
    score: null,
    reason: '高质量低波',
  });
  assert('ETF rotation no score', !noScore.includes('分'));
  assert('ETF rotation reason', noScore.includes('— 高质量低波'));

  const u = formatCandidateLine({ strategy: 'unknown' as any, symbol: 'X' });
  assert('unknown label', u.includes('[unknown]'));

  const long = formatCandidateLine({
    strategy: 'etf_rotation',
    symbol: 'X',
    reason: '一'.repeat(100),
  });
  assert('long reason truncated', long.length < 80);
}

// ---------------------------------------------------------------------------
// formatMoney / formatPercent
// ---------------------------------------------------------------------------

function testFormatMoney(): void {
  assertEqual('0', formatMoney(0), '0.00');
  assertEqual('1234', formatMoney(1234), '1,234.00');
  assertEqual('1234567.89', formatMoney(1234567.89), '1,234,567.89');
  assertEqual('-500.5', formatMoney(-500.5), '-500.50');
  assertEqual('NaN', formatMoney(NaN), '0.00');
  assertEqual('string num', formatMoney('100.5'), '100.50');
  assertEqual('null', formatMoney(null), '0.00');
}

function testFormatPercent(): void {
  assertEqual('positive', formatPercent(0.62), '0.62%');
  assertEqual('negative', formatPercent(-1.5), '-1.50%');
  assertEqual('zero', formatPercent(0), '0.00%');
  assertEqual('NaN', formatPercent(NaN), '0.00%');
}

// ---------------------------------------------------------------------------
// buildDigestId
// ---------------------------------------------------------------------------

function testBuildDigestId(): void {
  assertEqual('basic', buildDigestId(42, '2026-06-08', 'ab12'), 'DIGEST-42-20260608-ab12');
  assertEqual('short rand4 padded', buildDigestId(1, '2026-06-08', 'a'), 'DIGEST-1-20260608-000a');
  assertEqual(
    'long rand4 sliced',
    buildDigestId(1, '2026-06-08', 'abcdef'),
    'DIGEST-1-20260608-abcd'
  );
}

// ---------------------------------------------------------------------------
// buildDigestCard
// ---------------------------------------------------------------------------

function testBuildDigestCard(): void {
  const payload: DigestPayload = {
    user_id: 42,
    username: 'lym',
    trade_date: '2026-06-08',
    pnl: {
      total_value: 210000,
      prev_total_value: 205000,
      position_value: 110000,
      current_cash: 100000,
      pnl_today: 5000,
      pnl_today_pct: 2.44,
    },
    trades_today_buy: [
      {
        symbol: '002594',
        name: '比亚迪',
        direction: 'BUY',
        quantity: 100,
        execute_price: 185.34,
        amount: 18534,
      },
    ],
    trades_today_sell: [],
    trades_today_buy_count: 1,
    trades_today_sell_count: 0,
    candidates_tomorrow: [
      { strategy: 'etf_rotation', symbol: '159995', name: '芯片ETF华夏', score: 91.2 },
    ],
  };
  const card = buildDigestCard(payload);

  assertEqual('msg_type', card.msg_type, 'interactive');
  assertEqual('header template red for profit', card.card.header.template, 'red');
  assert('header title trade_date', String(card.card.header.title.content).includes('2026-06-08'));
  assert(
    'header title 当日交易日报',
    String(card.card.header.title.content).includes('当日交易日报')
  );

  const allMd = JSON.stringify(card.card.elements);
  assert('PnL line in card', allMd.includes('+5,000.00') && allMd.includes('+2.44%'));
  assert('total_value line', allMd.includes('210,000.00'));
  assert('BUY count 1 笔', allMd.includes('今日新增买入 1 笔'));
  assert('SELL count 0 笔', allMd.includes('今日新增卖出 0 笔'));
  assert('SELL empty placeholder', allMd.includes('暂无新增卖出'));
  assert('candidates section', allMd.includes('明日候选'));
  assert('candidate row', allMd.includes('159995') && allMd.includes('芯片ETF华夏'));
  assert('footer note', allMd.includes('lym') && allMd.includes('2026-06-08'));

  const lossCard = buildDigestCard({
    ...payload,
    pnl: { ...payload.pnl, pnl_today: -5000, pnl_today_pct: -2.44 },
  });
  assertEqual('header template green for loss', lossCard.card.header.template, 'green');

  const flatCard = buildDigestCard({
    ...payload,
    pnl: { ...payload.pnl, pnl_today: 0, pnl_today_pct: 0 },
  });
  assertEqual('header template blue for flat', flatCard.card.header.template, 'blue');

  const emptyTrades = buildDigestCard({
    ...payload,
    trades_today_buy: [],
    trades_today_sell: [],
    trades_today_buy_count: 0,
    trades_today_sell_count: 0,
  });
  const emptyMd = JSON.stringify(emptyTrades.card.elements);
  assert('empty buy placeholder', emptyMd.includes('暂无新增买入'));
  assert('empty sell placeholder', emptyMd.includes('暂无新增卖出'));

  const noCand = buildDigestCard({ ...payload, candidates_tomorrow: [] });
  const noCandMd = JSON.stringify(noCand.card.elements);
  assert('empty candidates placeholder', noCandMd.includes('今日策略无候选'));

  const truncated = buildDigestCard({
    ...payload,
    trades_today_buy: payload.trades_today_buy,
    trades_today_buy_count: 5,
  });
  const truncMd = JSON.stringify(truncated.card.elements);
  assert('buy truncated label', truncMd.includes('展示前 1 只'));
}

// ---------------------------------------------------------------------------
// service.sendDigests e2e
// ---------------------------------------------------------------------------

async function testSendDigestsEmptyUsers(): Promise<void> {
  const { ds } = makeFakeDataSource({ users: [] });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('scanned_users empty', r.scanned_users, 0);
  assertEqual('sent_count 0', r.sent_count, 0);
  assertEqual('per_user empty', r.per_user.length, 0);
}

async function testSendDigestsHappyPath(): Promise<void> {
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
    trades: {
      100: [
        {
          symbol: '002594',
          name: '比亚迪',
          direction: 'BUY',
          quantity: 100,
          execute_price: 185.34,
          amount: 18534,
        },
        {
          symbol: '600519',
          name: '贵州茅台',
          direction: 'SELL',
          quantity: 100,
          execute_price: 1700,
          amount: 170000,
          realized_pnl: 5000,
        },
      ],
    },
    snapshots: { 100: [{ date: '2026-06-07', total_value: 205000 }] },
    candidates: [
      { strategy: 'etf_rotation', symbol: '159995', name: '芯片ETF华夏', score: 91.2 },
      { strategy: 'etf_rotation', symbol: '512290', name: '生物医药ETF国联', score: 88.5 },
    ],
    sendResult: { success: true, data: { code: 0 } },
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('scanned_users', r.scanned_users, 1);
  assertEqual('sent_count', r.sent_count, 1);
  assertEqual('failed_count', r.failed_count, 0);
  assertEqual('skipped_count', r.skipped_count, 0);
  const u = r.per_user[0];
  assertEqual('status sent', u.status, DIGEST_STATUS.SENT);
  assertEqual('sent true', u.sent, true);
  assertEqual('webhook_url_used', u.webhook_url_used, 'https://hooks.example.com/webhook-A');
  assert('payload exists', !!u.payload);
  assertEqual('payload trade_buy_count', u.payload!.trades_today_buy_count, 1);
  assertEqual('payload trade_sell_count', u.payload!.trades_today_sell_count, 1);
  assertEqual('payload candidates count', u.payload!.candidates_tomorrow.length, 2);
  assertEqual('payload pnl_today', u.payload!.pnl.pnl_today, 5000);
  assertEqual('sentLog count 1', state.sentLog!.length, 1);
  assertEqual('sentLog url', state.sentLog![0].webhook_url, 'https://hooks.example.com/webhook-A');
}

async function testSendDigestsNoPortfolio(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    portfolios: { 42: null },
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('skipped_count 1', r.skipped_count, 1);
  assertEqual('sent_count 0', r.sent_count, 0);
  const u = r.per_user[0];
  assertEqual('status skipped', u.status, DIGEST_STATUS.SKIPPED);
  assert('skip_reason 含 尚未建立', String(u.skip_reason).includes('尚未建立'));
}

async function testSendDigestsDigestOff(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig({ daily_digest: false }) }],
    portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('skipped_count 1', r.skipped_count, 1);
  assertEqual('status skipped', r.per_user[0].status, DIGEST_STATUS.SKIPPED);
  assert('skip_reason 含 关闭', String(r.per_user[0].skip_reason).includes('关闭'));
}

async function testSendDigestsNoWebhookNoEnv(): Promise<void> {
  const origA = process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK;
  const origB = process.env.FEISHU_BOT_WEBHOOK;
  delete process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK;
  delete process.env.FEISHU_BOT_WEBHOOK;
  try {
    const { ds } = makeFakeDataSource({
      users: [{ user_id: 42, username: 'lym', config: makeBaseConfig({ webhook_url: '' }) }],
      portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
    });
    const svc = new DailyTradingDigestService(ds);
    const r = await svc.sendDigests({ trade_date: '2026-06-08' });
    assertEqual('skipped_count 1', r.skipped_count, 1);
    assert('skip_reason 含 未配置', String(r.per_user[0].skip_reason).includes('未配置'));
  } finally {
    if (origA !== undefined) process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK = origA;
    if (origB !== undefined) process.env.FEISHU_BOT_WEBHOOK = origB;
  }
}

async function testSendDigestsSendThrows(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
    sendShouldThrow: true,
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('failed_count 1', r.failed_count, 1);
  assertEqual('sent_count 0', r.sent_count, 0);
  const u = r.per_user[0];
  assertEqual('status failed', u.status, DIGEST_STATUS.FAILED);
  assert('error contains throw msg', String(u.error).includes('throw'));
}

async function testSendDigestsSendReturnsFailure(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
    sendResult: { success: false, message: '飞书返回 code=10000' },
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('failed_count 1', r.failed_count, 1);
  const u = r.per_user[0];
  assertEqual('status partial', u.status, DIGEST_STATUS.PARTIAL);
  assert('error has 飞书返回', String(u.error).includes('code=10000'));
}

async function testSendDigestsDryRun(): Promise<void> {
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08', dry_run: true });
  assertEqual('dry_run propagated', r.dry_run, true);
  // dry_run 我们把 SENT status 当成 "已生成 payload, 没发"，仍是 sent_count
  assertEqual('sent_count 1 (status sent)', r.sent_count, 1);
  const u = r.per_user[0];
  assertEqual('status sent', u.status, DIGEST_STATUS.SENT);
  assertEqual('sent false (dry_run)', u.sent, false);
  assertEqual('skip_reason dry_run', u.skip_reason, 'dry_run');
  assertEqual('sentLog empty in dry_run', state.sentLog!.length, 0);
}

async function testSendDigestsListThrowsTopLevel(): Promise<void> {
  const { ds } = makeFakeDataSource({ listShouldThrow: true });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('scanned_users 0', r.scanned_users, 0);
  assertEqual('per_user 0', r.per_user.length, 0);
  assertEqual('sent_count 0', r.sent_count, 0);
  assertEqual('failed_count 0', r.failed_count, 0);
}

async function testSendDigestsMultipleUsersIsolated(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [
      {
        user_id: 1,
        username: 'user-a',
        config: makeBaseConfig({ webhook_url: 'https://A.example.com' }),
      },
      {
        user_id: 2,
        username: 'user-b',
        config: makeBaseConfig({ webhook_url: 'https://B.example.com' }),
      },
      { user_id: 3, username: 'user-c', config: makeBaseConfig({ daily_digest: false }) },
    ],
    portfolios: {
      1: makePortfolioPair({ user_id: 1, portfolio_id: 101 }),
      2: makePortfolioPair({ user_id: 2, portfolio_id: 102 }),
    },
    portfolioShouldThrowFor: new Set([2]),
    sendResult: { success: true, data: {} },
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('scanned 3', r.scanned_users, 3);
  assertEqual('sent 1', r.sent_count, 1);
  assertEqual('failed 1', r.failed_count, 1);
  assertEqual('skipped 1', r.skipped_count, 1);
  const byId = new Map(r.per_user.map(u => [u.user_id, u]));
  assertEqual('user 1 sent', byId.get(1)!.status, DIGEST_STATUS.SENT);
  assertEqual('user 2 failed', byId.get(2)!.status, DIGEST_STATUS.FAILED);
  assertEqual('user 3 skipped', byId.get(3)!.status, DIGEST_STATUS.SKIPPED);
}

async function testSendDigestsPerStrategyLimitPropagates(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
    candidates: Array.from({ length: 8 }, (_, i) => ({
      strategy: 'etf_rotation' as const,
      symbol: `S${i.toString().padStart(2, '0')}`,
      score: 100 - i,
    })),
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08', per_strategy_limit: 3 });
  const u = r.per_user[0];
  assertEqual('candidates capped', u.payload!.candidates_tomorrow.length, 3);
}

async function testSendDigestsCandidatesFailureNonBlocking(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
    candidatesShouldThrow: true,
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('sent despite no candidates', r.sent_count, 1);
  const u = r.per_user[0];
  assertEqual('candidates empty fallback', u.payload!.candidates_tomorrow.length, 0);
}

async function testSendDigestsPerDirectionTradeLimit(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
    trades: {
      100: Array.from({ length: 8 }, (_, i) => ({
        symbol: `B${i.toString().padStart(2, '0')}`,
        name: `名称${i}`,
        direction: 'BUY' as const,
        quantity: 100,
        execute_price: 10,
        amount: 1000 + i,
      })),
    },
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08', per_direction_trade_limit: 2 });
  const u = r.per_user[0];
  assertEqual('buy capped at 2', u.payload!.trades_today_buy.length, 2);
  assertEqual('top buy is B07', u.payload!.trades_today_buy[0].symbol, 'B07');
  assertEqual('count = 8', u.payload!.trades_today_buy_count, 8);
}

async function testSendDigestsSnapshotsFailureNonBlocking(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
    snapshotsShouldThrowFor: new Set([100]),
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('sent despite snapshots throw', r.sent_count, 1);
  const u = r.per_user[0];
  assertEqual('pnl_today vs initial_capital', u.payload!.pnl.pnl_today, 10000);
}

async function testSendDigestsTradesFailureNonBlocking(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 42, username: 'lym', config: makeBaseConfig() }],
    portfolios: { 42: makePortfolioPair({ user_id: 42, portfolio_id: 100 }) },
    tradesShouldThrowFor: new Set([100]),
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08' });
  assertEqual('sent despite trades throw', r.sent_count, 1);
  const u = r.per_user[0];
  assertEqual('buy count 0 fallback', u.payload!.trades_today_buy_count, 0);
  assertEqual('sell count 0 fallback', u.payload!.trades_today_sell_count, 0);
}

async function testSendDigestsUserIdFilter(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [
      { user_id: 1, username: 'a', config: makeBaseConfig() },
      { user_id: 2, username: 'b', config: makeBaseConfig() },
    ],
    portfolios: {
      1: makePortfolioPair({ user_id: 1, portfolio_id: 101 }),
      2: makePortfolioPair({ user_id: 2, portfolio_id: 102 }),
    },
  });
  const svc = new DailyTradingDigestService(ds);
  const r = await svc.sendDigests({ trade_date: '2026-06-08', user_id: 1 });
  assertEqual('user_id filter scanned 1', r.scanned_users, 1);
  assertEqual('per_user has 1', r.per_user.length, 1);
  assertEqual('per_user user_id', r.per_user[0].user_id, 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testConstantsFrozen();
  testNormalizeNotificationConfig();
  testShouldSendForUser();
  testPickTopTrades();
  testPickTopCandidates();
  testComputePnLSummary();
  testBuildPnLLine();
  testFormatTradeLine();
  testFormatCandidateLine();
  testFormatMoney();
  testFormatPercent();
  testBuildDigestId();
  testBuildDigestCard();
  await testSendDigestsEmptyUsers();
  await testSendDigestsHappyPath();
  await testSendDigestsNoPortfolio();
  await testSendDigestsDigestOff();
  await testSendDigestsNoWebhookNoEnv();
  await testSendDigestsSendThrows();
  await testSendDigestsSendReturnsFailure();
  await testSendDigestsDryRun();
  await testSendDigestsListThrowsTopLevel();
  await testSendDigestsMultipleUsersIsolated();
  await testSendDigestsPerStrategyLimitPropagates();
  await testSendDigestsCandidatesFailureNonBlocking();
  await testSendDigestsPerDirectionTradeLimit();
  await testSendDigestsSnapshotsFailureNonBlocking();
  await testSendDigestsTradesFailureNonBlocking();
  await testSendDigestsUserIdFilter();

  console.log(`\n────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log(`────────────────────────────────────`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
