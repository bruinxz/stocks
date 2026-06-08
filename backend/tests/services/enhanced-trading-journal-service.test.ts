/**
 * EnhancedTradingJournalService 单元测试 (US-087 AI 复盘日记自动生成升级)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/enhanced-trading-journal-service.test.ts
 *
 * 完全脱 DB / 网络：注入 fake EnhancedTradingJournalDataSource。
 *
 * 覆盖维度：
 *   - 常量冻结 (JOURNAL_STATUS / NLP_ENGINES)
 *   - 纯函数：
 *     - safeMoney（千分位 / 小数 / 负数 / 0 / NaN）
 *     - safePct（正/负/0/NaN/withSign）
 *     - pickTopTrades（空 / 反向过滤 / 按 amount 降序 / tie-break stable / cap）
 *     - pickTopAlerts（HIGH 优先 / 同级 rule_id tie-break / cap）
 *     - computeJournalPnLSummary（prev 缺失 fallback initial_capital / pct 计算 / prev<=0 时 null）
 *     - computeIndustryAttribution（BUY 不计 / SELL 按 industry 聚合 / 缺 industry 入 '其他' / 按 |pnl| 降序）
 *     - buildJournalId（YYYYMMDD 拆分 / rand4 padding）
 *     - buildAIPrompt（5 段 ## 标题 / 缺数据占位 / 必含 username + trade_date）
 *     - buildHeuristicMarkdown（5 段都输出 / 不撒谎 / 盈利 vs 回撤分支 / 无 trade 分支）
 *     - pickHeuristicMood（兴奋 / 开心 / 平静 / 焦虑 / 低落 / pct null）
 *     - buildHeuristicTags（买入 / 卖出 / 盈利 / 回撤 / 高风险 / 观望 / 日常 fallback）
 *     - normalizeAIPayload（4 路径：FAILED / 缺 markdown / 缺段 / 正常）
 *     - parseMarkdownSections（## 切段 / 多空行 / 缺标题）
 *     - splitMarkdownToFields（5 段分到 3 字段 / 缺段兜底）
 *   - service.generateForAll() e2e:
 *     - 无 user → scanned=0
 *     - 单 user + dry_run=true → status='generated' persisted=false
 *     - skip_ai=true → status='partial' nlp_engine='heuristic_fallback'
 *     - 远端 AI throw → fallback 启发式 → status='partial'
 *     - 远端 AI 返回缺段 markdown → fallback 启发式 → status='partial'
 *     - 远端 AI 返回完整 markdown → status='generated' nlp_engine='trading_agents'
 *     - 用户已 hand-edited (saveJournal 返回 persisted=false) → status='skipped'
 *     - overwrite_hand_edited=true → 覆盖成功
 *     - listEligibleUsers throw → 顶层 catch → 返回空 per_user
 *     - 多 user：A 成功 + B 失败 → per_user 各自独立 status 不串扰
 *     - saveJournal throw → fail-OPEN status='failed' error 填充
 *     - 无 portfolio → status='skipped' skip_reason 含 "尚未建立"
 */

import {
  EnhancedTradingJournalService,
  EnhancedTradingJournalDataSource,
  JournalTradeRow,
  JournalRiskAlertRow,
  JournalMarketSummary,
  JOURNAL_STATUS,
  NLP_ENGINES,
  DEFAULT_MOOD_GENERATED,
  DEFAULT_MOOD_FAILED,
  safeMoney,
  safePct,
  pickTopTrades,
  pickTopAlerts,
  computeJournalPnLSummary,
  computeIndustryAttribution,
  buildJournalId,
  buildAIPrompt,
  buildHeuristicMarkdown,
  pickHeuristicMood,
  buildHeuristicTags,
  normalizeAIPayload,
  parseMarkdownSections,
  splitMarkdownToFields,
} from '../../src/services/EnhancedTradingJournalService';

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
// Fake DataSource
// ---------------------------------------------------------------------------

interface FakeState {
  users?: Array<{ user_id: number; username: string }>;
  portfolios?: Record<
    number,
    {
      portfolio: { id: number; total_value: number; current_cash: number; initial_capital: number };
      positions: Array<{ market_value: number; symbol: string }>;
    } | null
  >;
  trades?: Record<number, Array<Partial<JournalTradeRow> & { symbol: string }>>;
  snapshots?: Record<number, Array<{ date: string; total_value: number }>>;
  market?: JournalMarketSummary;
  alerts?: Record<number, JournalRiskAlertRow[]>;
  candidates?: string[];
  /** simulate remote AI: 'ok' → 完整 markdown; 'incomplete' → 缺段; 'fail' → status=FAILED; 'throw' → throw */
  remoteMode?: 'ok' | 'incomplete' | 'fail' | 'throw';
  /** simulate saveJournal: 'ok' / 'skip_hand' / 'throw' */
  saveMode?: 'ok' | 'skip_hand' | 'throw';
  listShouldThrow?: boolean;
  portfolioShouldThrowFor?: Set<number>;
  savedLog?: Array<{
    user_id: number;
    trade_date: string;
    market_summary: string;
    portfolio_analysis: string;
    action_plan: string;
    tags: string[];
    mood: string;
    overwrite_hand_edited: boolean;
  }>;
  remoteCalls?: number;
}

function makeFakeDataSource(state: FakeState): {
  ds: EnhancedTradingJournalDataSource;
  state: FakeState;
} {
  state.savedLog = [];
  state.remoteCalls = 0;
  const ds: EnhancedTradingJournalDataSource = {
    async listEligibleUsers(opts) {
      if (state.listShouldThrow) throw new Error('mock listEligibleUsers throw');
      let us = state.users || [];
      if (opts?.user_id !== undefined) {
        us = us.filter(u => u.user_id === opts.user_id);
      }
      return us.slice();
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
      const rows = state.trades?.[portfolio_id] || [];
      return rows.map(r => ({
        symbol: r.symbol,
        name: r.name || r.symbol,
        direction: r.direction || 'BUY',
        quantity: r.quantity ?? 100,
        execute_price: r.execute_price ?? 10,
        amount: r.amount ?? 1000,
        realized_pnl: r.realized_pnl ?? null,
        industry: r.industry,
      })) as any;
    },
    async loadRecentSnapshots(portfolio_id, _limit) {
      return (state.snapshots?.[portfolio_id] || []).slice();
    },
    async loadMarketSummary(_trade_date) {
      return (
        state.market || {
          benchmark_symbol: 'sh.000300',
          prev_close: null,
          today_close: null,
          change_pct: null,
          northbound_net_yi: null,
          limit_up_count: null,
          ai_view: null,
          ai_view_engine: null,
        }
      );
    },
    async loadRiskAlerts(user_id, _trade_date, _limit) {
      return (state.alerts?.[user_id] || []).slice();
    },
    async loadTomorrowCandidates(_trade_date, _limit) {
      return (state.candidates || []).slice();
    },
    async callRemoteAI(_prompt) {
      state.remoteCalls = (state.remoteCalls || 0) + 1;
      const mode = state.remoteMode || 'fail';
      if (mode === 'throw') throw new Error('mock callRemoteAI throw');
      if (mode === 'fail') return { status: 'FAILED', error: 'mock failed' };
      if (mode === 'incomplete') {
        return {
          status: 'OK',
          markdown: '## 今日战报\n短\n## 操作复盘\n短',
          mood: 'AI',
          tags: ['AI'],
        };
      }
      // ok
      return {
        status: 'OK',
        markdown: [
          '## 今日战报',
          '今日战报正文',
          '',
          '## 操作复盘',
          '操作复盘正文',
          '',
          '## 市场观察',
          '市场观察正文',
          '',
          '## 明日策略',
          '明日策略正文',
          '',
          '## 风险提醒',
          '风险提醒正文',
        ].join('\n'),
        mood: '冷静',
        tags: ['AI', '复盘'],
      };
    },
    async saveJournal(record) {
      state.savedLog!.push({ ...record });
      const mode = state.saveMode || 'ok';
      if (mode === 'throw') throw new Error('mock saveJournal throw');
      if (mode === 'skip_hand') {
        return { id: 99, persisted: false, skip_reason: 'mock hand-edited skip' };
      }
      return { id: 1, persisted: true };
    },
  };
  return { ds, state };
}

// ---------------------------------------------------------------------------
// Constants frozen
// ---------------------------------------------------------------------------

function testConstantsFrozen(): void {
  assert('JOURNAL_STATUS frozen', Object.isFrozen(JOURNAL_STATUS));
  assert('NLP_ENGINES frozen', Object.isFrozen(NLP_ENGINES));
  assertEqual('JOURNAL_STATUS keys', Object.keys(JOURNAL_STATUS).sort(), [
    'FAILED',
    'GENERATED',
    'PARTIAL',
    'SKIPPED',
  ]);
  assertEqual('NLP_ENGINES.TRADING_AGENTS', NLP_ENGINES.TRADING_AGENTS, 'trading_agents' as any);
  assertEqual('NLP_ENGINES.HEURISTIC', NLP_ENGINES.HEURISTIC, 'heuristic_fallback' as any);
  assertEqual('DEFAULT_MOOD_GENERATED', DEFAULT_MOOD_GENERATED, 'AI');
  assertEqual('DEFAULT_MOOD_FAILED', DEFAULT_MOOD_FAILED, '未生成');
}

// ---------------------------------------------------------------------------
// safeMoney / safePct
// ---------------------------------------------------------------------------

function testFormatters(): void {
  assertEqual('safeMoney 千分位', safeMoney(1234567.89), '1,234,567.89');
  assertEqual('safeMoney 小数', safeMoney(0.5), '0.50');
  assertEqual('safeMoney 负数', safeMoney(-1234.5), '-1,234.50');
  assertEqual('safeMoney 0', safeMoney(0), '0.00');
  assertEqual('safeMoney NaN', safeMoney(NaN), '0.00');
  assertEqual('safeMoney null', safeMoney(null), '0.00');
  assertEqual('safeMoney string', safeMoney('1234.5'), '1,234.50');

  assertEqual('safePct 1.23%', safePct(1.23), '1.23%');
  assertEqual('safePct -0.5%', safePct(-0.5), '-0.50%');
  assertEqual('safePct 0', safePct(0), '0.00%');
  assertEqual('safePct NaN', safePct(NaN), '0.00%');
  assertEqual('safePct withSign 正数', safePct(1.5, true), '+1.50%');
  assertEqual('safePct withSign 负数 不变', safePct(-1.5, true), '-1.50%');
  assertEqual('safePct withSign 0 不加', safePct(0, true), '0.00%');
}

// ---------------------------------------------------------------------------
// pickTopTrades
// ---------------------------------------------------------------------------

function testPickTopTrades(): void {
  assertEqual('empty input', pickTopTrades([], 'BUY', 5), []);
  assertEqual('not array', pickTopTrades(null as any, 'BUY', 5), []);
  const rows: JournalTradeRow[] = [
    { symbol: '000001', name: 'A', direction: 'BUY', quantity: 100, execute_price: 10, amount: 1000 },
    { symbol: '000002', name: 'B', direction: 'SELL', quantity: 200, execute_price: 20, amount: 4000 },
    { symbol: '000003', name: 'C', direction: 'BUY', quantity: 300, execute_price: 5, amount: 1500 },
    { symbol: '000004', name: 'D', direction: 'BUY', quantity: 100, execute_price: 8, amount: 1000 },
  ];
  const buys = pickTopTrades(rows, 'BUY', 5);
  assertEqual('BUY 过滤', buys.length, 3);
  assertEqual('amount 降序 #0', buys[0].symbol, '000003');
  // tie-break by symbol asc
  assertEqual('amount tie-break #1', buys[1].symbol, '000001');
  assertEqual('amount tie-break #2', buys[2].symbol, '000004');

  const sells = pickTopTrades(rows, 'SELL', 5);
  assertEqual('SELL 过滤', sells.length, 1);
  assertEqual('SELL 第一', sells[0].symbol, '000002');

  const capped = pickTopTrades(rows, 'BUY', 1);
  assertEqual('cap 生效', capped.length, 1);
}

// ---------------------------------------------------------------------------
// pickTopAlerts
// ---------------------------------------------------------------------------

function testPickTopAlerts(): void {
  assertEqual('alerts empty', pickTopAlerts([], 5), []);
  const alerts: JournalRiskAlertRow[] = [
    { level: 'LOW', rule_id: 'r1', symbol: 's1', message: 'low alert' },
    { level: 'HIGH', rule_id: 'r2', symbol: 's2', message: 'high alert' },
    { level: 'MEDIUM', rule_id: 'r3', symbol: 's3', message: 'med alert' },
    { level: 'HIGH', rule_id: 'r4', symbol: 's4', message: 'high alert 2' },
  ];
  const top = pickTopAlerts(alerts, 10);
  assertEqual('alerts 4 条都进', top.length, 4);
  assertEqual('alerts HIGH 优先 #0', top[0].rule_id, 'r2');
  assertEqual('alerts HIGH 优先 #1', top[1].rule_id, 'r4');
  assertEqual('alerts MEDIUM 居中', top[2].rule_id, 'r3');
  assertEqual('alerts LOW 最末', top[3].rule_id, 'r1');

  const capped = pickTopAlerts(alerts, 2);
  assertEqual('alerts cap 2', capped.length, 2);
  assertEqual('alerts cap 仍取 HIGH', capped[0].level, 'HIGH');
}

// ---------------------------------------------------------------------------
// computeJournalPnLSummary
// ---------------------------------------------------------------------------

function testComputePnL(): void {
  const r1 = computeJournalPnLSummary({
    total_value: 210000,
    current_cash: 100000,
    initial_capital: 200000,
    positions_market_value: 110000,
    prev_snapshot_total_value: 205000,
  });
  assertEqual('pnl_today', r1.pnl_today, 5000);
  assertEqual('pnl_today_pct', r1.pnl_today_pct, 2.44);
  assertEqual('prev_total_value', r1.prev_total_value, 205000);

  const r2 = computeJournalPnLSummary({
    total_value: 210000,
    current_cash: 100000,
    initial_capital: 200000,
    positions_market_value: 110000,
    prev_snapshot_total_value: null,
  });
  assertEqual('null prev → initial fallback', r2.prev_total_value, 200000);
  assertEqual('pnl with fallback', r2.pnl_today, 10000);

  const r3 = computeJournalPnLSummary({
    total_value: 100000,
    current_cash: 100000,
    initial_capital: 0,
    positions_market_value: 0,
    prev_snapshot_total_value: 0,
  });
  assertEqual('prev=0 → pct null', r3.pnl_today_pct, null);

  const r4 = computeJournalPnLSummary({
    total_value: 100000,
    current_cash: 100000,
    initial_capital: 0,
    positions_market_value: 0,
    prev_snapshot_total_value: -100,
  });
  assertEqual('prev<0 → pct null', r4.pnl_today_pct, null);
}

// ---------------------------------------------------------------------------
// computeIndustryAttribution
// ---------------------------------------------------------------------------

function testComputeIndustryAttribution(): void {
  assertEqual('empty input', computeIndustryAttribution([]), []);

  const rows: JournalTradeRow[] = [
    {
      symbol: '600519',
      name: '茅台',
      direction: 'SELL',
      quantity: 100,
      execute_price: 1800,
      amount: 180000,
      realized_pnl: 5000,
      industry: '白酒',
    },
    {
      symbol: '600036',
      name: '招商银行',
      direction: 'SELL',
      quantity: 200,
      execute_price: 40,
      amount: 8000,
      realized_pnl: -1000,
      industry: '银行',
    },
    {
      symbol: '600519',
      name: '茅台',
      direction: 'BUY',
      quantity: 100,
      execute_price: 1800,
      amount: 180000,
      realized_pnl: null,
      industry: '白酒',
    },
    {
      symbol: '601398',
      name: '工商银行',
      direction: 'SELL',
      quantity: 100,
      execute_price: 5,
      amount: 500,
      realized_pnl: -2000,
      industry: '银行',
    },
    {
      symbol: '000001',
      name: '平安',
      direction: 'SELL',
      quantity: 100,
      execute_price: 12,
      amount: 1200,
      realized_pnl: 100,
      industry: undefined,
    },
  ];
  const out = computeIndustryAttribution(rows);
  assertEqual('行业归因数量', out.length, 3);
  // 按 |pnl| 降序：白酒 5000 (|5000|) > 银行 -3000 (|3000|) > 其他 100 (|100|)
  assertEqual('归因 #0 industry', out[0].industry, '白酒');
  assertEqual('归因 #0 pnl', out[0].pnl, 5000);
  assertEqual('归因 #0 count', out[0].trade_count, 1);
  assertEqual('归因 #1 industry', out[1].industry, '银行');
  assertEqual('归因 #1 pnl', out[1].pnl, -3000);
  assertEqual('归因 #1 count', out[1].trade_count, 2);
  assertEqual('归因 #2 industry 缺失归 其他', out[2].industry, '其他');
  assertEqual('归因 #2 pnl', out[2].pnl, 100);

  // BUY 不计入归因
  const buyOnly: JournalTradeRow[] = [
    {
      symbol: '600519',
      name: '茅台',
      direction: 'BUY',
      quantity: 100,
      execute_price: 1800,
      amount: 180000,
      realized_pnl: null,
      industry: '白酒',
    },
  ];
  assertEqual('BUY only → 空', computeIndustryAttribution(buyOnly).length, 0);
}

// ---------------------------------------------------------------------------
// buildJournalId
// ---------------------------------------------------------------------------

function testBuildJournalId(): void {
  assertEqual('basic', buildJournalId(7, '2026-06-09', 'a3f9'), 'JRN-20260609-7-a3f9');
  assertEqual('rand padding', buildJournalId(7, '2026-06-09', 'a'), 'JRN-20260609-7-000a');
  assertEqual('rand truncate', buildJournalId(7, '2026-06-09', 'abcdef'), 'JRN-20260609-7-abcd');
}

// ---------------------------------------------------------------------------
// buildAIPrompt
// ---------------------------------------------------------------------------

function testBuildAIPrompt(): void {
  const input = makeMinimalInput();
  const prompt = buildAIPrompt(input);
  // 必含 5 段标题
  assert('prompt 含 今日战报', prompt.includes('## 今日战报'));
  assert('prompt 含 操作复盘', prompt.includes('## 操作复盘'));
  assert('prompt 含 市场观察', prompt.includes('## 市场观察'));
  assert('prompt 含 明日策略', prompt.includes('## 明日策略'));
  assert('prompt 含 风险提醒', prompt.includes('## 风险提醒'));
  // 必含 username / date
  assert('prompt 含 username', prompt.includes(input.username));
  assert('prompt 含 trade_date', prompt.includes(input.trade_date));
  // 缺数据占位
  assert('prompt 缺数据用 —', prompt.includes('—'));
}

// ---------------------------------------------------------------------------
// buildHeuristicMarkdown
// ---------------------------------------------------------------------------

function testBuildHeuristicMarkdown(): void {
  const input = makeMinimalInput();
  const out = buildHeuristicMarkdown(input);
  assert(
    'heuristic market_summary 含 今日战报',
    out.market_summary.includes('## 今日战报')
  );
  assert(
    'heuristic market_summary 含 市场观察',
    out.market_summary.includes('## 市场观察')
  );
  assertEqual('heuristic engine', out.nlp_engine, NLP_ENGINES.HEURISTIC);
  assert('heuristic mood', typeof out.mood === 'string' && out.mood.length > 0);
  assert('heuristic tags array', Array.isArray(out.tags) && out.tags.length > 0);

  // 盈利分支
  const profitInput = { ...input, pnl: { ...input.pnl, pnl_today: 5000, pnl_today_pct: 2.5 } };
  const profitOut = buildHeuristicMarkdown(profitInput);
  assert('盈利分支 含 盈利', profitOut.market_summary.includes('盈利'));

  // 回撤分支
  const lossInput = { ...input, pnl: { ...input.pnl, pnl_today: -5000, pnl_today_pct: -3.5 } };
  const lossOut = buildHeuristicMarkdown(lossInput);
  assert('回撤分支 含 回撤', lossOut.market_summary.includes('回撤'));
  // 大回撤应有减仓提示
  assert(
    '大回撤含减仓提示',
    lossOut.action_plan.includes('减仓') || lossOut.action_plan.includes('回撤')
  );

  // 无 trade 分支
  const noTradeInput = {
    ...input,
    trades_buy: [],
    trades_sell: [],
    buy_count: 0,
    sell_count: 0,
  };
  const noTradeOut = buildHeuristicMarkdown(noTradeInput);
  assert(
    '无 trade 显示 观望',
    noTradeOut.portfolio_analysis.includes('无交易') ||
      noTradeOut.portfolio_analysis.includes('观望')
  );

  // 无候选 + 无 trade → 'tag 观望' (需同时清空 tomorrow_candidates)
  const watchTags = buildHeuristicTags({
    ...noTradeInput,
    tomorrow_candidates: [],
    pnl: { ...noTradeInput.pnl, pnl_today_pct: 0 },
    risk_alerts: [],
  });
  assert('观望 tag', watchTags.includes('观望'));
}

// ---------------------------------------------------------------------------
// pickHeuristicMood
// ---------------------------------------------------------------------------

function testPickHeuristicMood(): void {
  const base = { total_value: 0, prev_total_value: 0, pnl_today: 0, pnl_today_pct: 0, position_value: 0, current_cash: 0 };
  assertEqual('pct null → AI', pickHeuristicMood({ ...base, pnl_today_pct: null }), 'AI');
  assertEqual('pct 3.5 → 兴奋', pickHeuristicMood({ ...base, pnl_today_pct: 3.5 }), '兴奋');
  assertEqual('pct 1.5 → 开心', pickHeuristicMood({ ...base, pnl_today_pct: 1.5 }), '开心');
  assertEqual('pct 0 → 平静', pickHeuristicMood({ ...base, pnl_today_pct: 0 }), '平静');
  assertEqual('pct -0.5 → 平静', pickHeuristicMood({ ...base, pnl_today_pct: -0.5 }), '平静');
  assertEqual('pct -2 → 焦虑', pickHeuristicMood({ ...base, pnl_today_pct: -2 }), '焦虑');
  assertEqual('pct -5 → 低落', pickHeuristicMood({ ...base, pnl_today_pct: -5 }), '低落');
}

// ---------------------------------------------------------------------------
// buildHeuristicTags
// ---------------------------------------------------------------------------

function testBuildHeuristicTags(): void {
  const input = makeMinimalInput();

  const t1 = buildHeuristicTags({ ...input, buy_count: 2, sell_count: 0 });
  assert('买入 tag', t1.includes('买入'));
  assert('无卖出无 卖出 tag', !t1.includes('卖出'));

  const t2 = buildHeuristicTags({
    ...input,
    buy_count: 0,
    sell_count: 0,
    pnl: { ...input.pnl, pnl_today_pct: 3 },
  });
  assert('盈利 tag', t2.includes('盈利'));

  const t3 = buildHeuristicTags({
    ...input,
    buy_count: 0,
    sell_count: 0,
    pnl: { ...input.pnl, pnl_today_pct: -3 },
  });
  assert('回撤 tag', t3.includes('回撤'));

  const t4 = buildHeuristicTags({
    ...input,
    risk_alerts: [{ level: 'HIGH', rule_id: 'r1', symbol: 's1', message: 'm' }],
  });
  assert('高风险 tag', t4.includes('高风险'));

  const t5 = buildHeuristicTags({
    ...input,
    buy_count: 0,
    sell_count: 0,
    tomorrow_candidates: [],
    pnl: { ...input.pnl, pnl_today_pct: 0 },
    risk_alerts: [],
  });
  assert('观望 tag', t5.includes('观望'));
}

// ---------------------------------------------------------------------------
// normalizeAIPayload
// ---------------------------------------------------------------------------

function testNormalizeAIPayload(): void {
  assertEqual('null payload', normalizeAIPayload(null), null);
  assertEqual('undefined payload', normalizeAIPayload(undefined), null);
  assertEqual('FAILED status', normalizeAIPayload({ status: 'FAILED', markdown: 'x' }), null);
  assertEqual('empty markdown', normalizeAIPayload({ status: 'OK', markdown: '' }), null);
  // 缺段
  const incomplete = normalizeAIPayload({
    status: 'OK',
    markdown: '## 今日战报\nxx\n## 操作复盘\nyy',
  });
  assertEqual('缺段 → null', incomplete, null);
  // 正常
  const ok = normalizeAIPayload({
    status: 'OK',
    markdown: '## 今日战报\nA\n## 操作复盘\nB\n## 市场观察\nC\n## 明日策略\nD\n## 风险提醒\nE',
    mood: 'AI',
    tags: ['a', 'b'],
  });
  assert('完整 → 非 null', ok !== null);
  if (ok) {
    assertEqual('完整 mood', ok.mood, 'AI');
    assertEqual('完整 tags', ok.tags, ['a', 'b']);
    assert('完整 markdown 包含 5 段', ok.markdown.includes('## 风险提醒'));
  }
  // mood 非 string → null
  const noMood = normalizeAIPayload({
    status: 'OK',
    markdown: '## 今日战报\nA\n## 操作复盘\nB\n## 市场观察\nC\n## 明日策略\nD\n## 风险提醒\nE',
    mood: undefined,
  });
  assert('无 mood', noMood !== null && noMood.mood === null);
}

// ---------------------------------------------------------------------------
// parseMarkdownSections
// ---------------------------------------------------------------------------

function testParseMarkdownSections(): void {
  const empty = parseMarkdownSections('');
  assertEqual('parse 空', empty.size, 0);

  const md = `## 今日战报
今日内容

## 操作复盘
操作内容
多行`;
  const sections = parseMarkdownSections(md);
  assertEqual('parse 段数', sections.size, 2);
  assertEqual('parse 今日战报', sections.get('今日战报'), '今日内容');
  assertEqual('parse 操作复盘', sections.get('操作复盘'), '操作内容\n多行');

  // 无标题
  const noTitle = parseMarkdownSections('just plain text');
  assertEqual('parse 无标题', noTitle.size, 0);
}

// ---------------------------------------------------------------------------
// splitMarkdownToFields
// ---------------------------------------------------------------------------

function testSplitMarkdownToFields(): void {
  const full = [
    '## 今日战报\nA',
    '## 操作复盘\nB',
    '## 市场观察\nC',
    '## 明日策略\nD',
    '## 风险提醒\nE',
  ].join('\n\n');
  const split = splitMarkdownToFields(full);
  assert('split market_summary 含 今日战报', split.market_summary.includes('## 今日战报'));
  assert('split market_summary 含 市场观察', split.market_summary.includes('## 市场观察'));
  assert('split portfolio_analysis 含 操作复盘', split.portfolio_analysis.includes('## 操作复盘'));
  assert('split action_plan 含 明日策略', split.action_plan.includes('## 明日策略'));
  assert('split action_plan 含 风险提醒', split.action_plan.includes('## 风险提醒'));

  // 无标题 fallback
  const empty = splitMarkdownToFields('plain text');
  assertEqual('split fallback market_summary', empty.market_summary, 'plain text');
  assertEqual('split fallback portfolio', empty.portfolio_analysis, '');
  assertEqual('split fallback action', empty.action_plan, '');
}

// ---------------------------------------------------------------------------
// service.generateForAll
// ---------------------------------------------------------------------------

async function testGenerateForAll_noUsers(): Promise<void> {
  const { ds } = makeFakeDataSource({ users: [] });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09' });
  assertEqual('no users scanned', res.scanned_users, 0);
  assertEqual('no users per_user empty', res.per_user.length, 0);
}

async function testGenerateForAll_dryRun(): Promise<void> {
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [{ symbol: '600519', market_value: 120000 }],
      },
    },
    trades: { 11: [] },
    remoteMode: 'ok',
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09', dry_run: true });
  assertEqual('dry_run scanned', res.scanned_users, 1);
  assertEqual('dry_run generated_count', res.generated_count, 1);
  assertEqual('dry_run not persisted', res.per_user[0].persisted, false);
  assertEqual('dry_run skip_reason', res.per_user[0].skip_reason, 'dry_run');
  assertEqual('dry_run saved nothing', state.savedLog!.length, 0);
}

async function testGenerateForAll_skipAI(): Promise<void> {
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [{ symbol: '600519', market_value: 120000 }],
      },
    },
    trades: { 11: [] },
    remoteMode: 'ok',
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09', skip_ai: true });
  assertEqual('skip_ai partial_count', res.partial_count, 1);
  assertEqual('skip_ai remote not called', state.remoteCalls!, 0);
  assertEqual('skip_ai nlp_engine', res.per_user[0].output?.nlp_engine, NLP_ENGINES.HEURISTIC);
}

async function testGenerateForAll_remoteThrow(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [{ symbol: '600519', market_value: 120000 }],
      },
    },
    trades: { 11: [] },
    remoteMode: 'throw',
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09' });
  assertEqual('remote throw → partial', res.partial_count, 1);
  assertEqual('remote throw → engine heuristic', res.per_user[0].output?.nlp_engine, NLP_ENGINES.HEURISTIC);
}

async function testGenerateForAll_remoteIncomplete(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [{ symbol: '600519', market_value: 120000 }],
      },
    },
    trades: { 11: [] },
    remoteMode: 'incomplete',
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09' });
  assertEqual('incomplete → partial', res.partial_count, 1);
  assertEqual('incomplete → fallback', res.per_user[0].output?.nlp_engine, NLP_ENGINES.HEURISTIC);
}

async function testGenerateForAll_remoteOk(): Promise<void> {
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [{ symbol: '600519', market_value: 120000 }],
      },
    },
    trades: { 11: [] },
    remoteMode: 'ok',
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09' });
  assertEqual('remote ok → generated', res.generated_count, 1);
  assertEqual('remote ok → engine trading_agents', res.per_user[0].output?.nlp_engine, NLP_ENGINES.TRADING_AGENTS);
  assertEqual('remote ok → persisted', res.per_user[0].persisted, true);
  assertEqual('remote ok → saved', state.savedLog!.length, 1);
  assertEqual('saved mood = 冷静', state.savedLog![0].mood, '冷静');
  assertEqual('saved tags = AI/复盘', state.savedLog![0].tags, ['AI', '复盘']);
}

async function testGenerateForAll_handEditedSkip(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [{ symbol: '600519', market_value: 120000 }],
      },
    },
    trades: { 11: [] },
    remoteMode: 'ok',
    saveMode: 'skip_hand',
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09' });
  assertEqual('hand-edited → skipped', res.skipped_count, 1);
  assertEqual('hand-edited skip_reason', res.per_user[0].skip_reason, 'mock hand-edited skip');
}

async function testGenerateForAll_listThrow(): Promise<void> {
  const { ds } = makeFakeDataSource({ listShouldThrow: true });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09' });
  assertEqual('list throw → scanned 0', res.scanned_users, 0);
  assertEqual('list throw → per_user empty', res.per_user.length, 0);
}

async function testGenerateForAll_multiUser_isolation(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [
      { user_id: 1, username: 'alice' },
      { user_id: 2, username: 'bob' },
    ],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [],
      },
      // user 2 无 portfolio
    },
    trades: { 11: [] },
    remoteMode: 'ok',
    portfolioShouldThrowFor: new Set([2]),
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09' });
  assertEqual('multi-user scanned', res.scanned_users, 2);
  // user 1 OK
  const u1 = res.per_user.find(u => u.user_id === 1);
  assert('user 1 exists', !!u1);
  assertEqual('user 1 generated', u1?.status, JOURNAL_STATUS.GENERATED);
  // user 2 portfolio throw → failed
  const u2 = res.per_user.find(u => u.user_id === 2);
  assert('user 2 exists', !!u2);
  assertEqual('user 2 failed', u2?.status, JOURNAL_STATUS.FAILED);
  assert('user 2 has error', !!u2?.error);
}

async function testGenerateForAll_saveThrow(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [],
      },
    },
    trades: { 11: [] },
    remoteMode: 'ok',
    saveMode: 'throw',
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09' });
  assertEqual('save throw → failed', res.failed_count, 1);
  assert('save throw error 包含 DB', String(res.per_user[0].error).includes('写入 DB'));
}

async function testGenerateForAll_noPortfolio(): Promise<void> {
  const { ds } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {},
    remoteMode: 'ok',
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09' });
  assertEqual('no portfolio → skipped', res.skipped_count, 1);
  assert(
    'no portfolio skip_reason',
    String(res.per_user[0].skip_reason || '').includes('尚未建立')
  );
}

async function testGenerateForAll_overwriteHandEdited(): Promise<void> {
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [],
      },
    },
    trades: { 11: [] },
    remoteMode: 'ok',
    saveMode: 'ok',
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({
    trade_date: '2026-06-09',
    overwrite_hand_edited: true,
  });
  assertEqual('overwrite_hand_edited → generated', res.generated_count, 1);
  assertEqual(
    'saveJournal received overwrite=true',
    state.savedLog![0].overwrite_hand_edited,
    true
  );

  // 默认 overwrite_hand_edited=false 也透传正确
  const { ds: ds2, state: state2 } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [],
      },
    },
    trades: { 11: [] },
    remoteMode: 'ok',
    saveMode: 'ok',
  });
  const svc2 = new EnhancedTradingJournalService(ds2);
  await svc2.generateForAll({ trade_date: '2026-06-09' });
  assertEqual(
    'saveJournal 默认 overwrite=false',
    state2.savedLog![0].overwrite_hand_edited,
    false
  );
}

async function testGenerateForAll_prevSnapshotUsed(): Promise<void> {
  const { ds, state } = makeFakeDataSource({
    users: [{ user_id: 1, username: 'alice' }],
    portfolios: {
      1: {
        portfolio: { id: 11, total_value: 220000, current_cash: 100000, initial_capital: 200000 },
        positions: [{ symbol: '600519', market_value: 120000 }],
      },
    },
    snapshots: {
      11: [
        { date: '2026-06-08', total_value: 210000 },
        { date: '2026-06-05', total_value: 205000 },
        // 一个未来日期，应被过滤
        { date: '2026-06-10', total_value: 230000 },
      ],
    },
    trades: { 11: [] },
    remoteMode: 'ok',
  });
  const svc = new EnhancedTradingJournalService(ds);
  const res = await svc.generateForAll({ trade_date: '2026-06-09' });
  assertEqual('generated count', res.generated_count, 1);
  assertEqual('saved trade_date', state.savedLog![0].trade_date, '2026-06-09');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeMinimalInput() {
  return {
    user_id: 1,
    username: 'alice',
    trade_date: '2026-06-09',
    pnl: {
      total_value: 220000,
      prev_total_value: 215000,
      pnl_today: 5000,
      pnl_today_pct: 2.33,
      position_value: 120000,
      current_cash: 100000,
    },
    trades_buy: [] as JournalTradeRow[],
    trades_sell: [] as JournalTradeRow[],
    buy_count: 0,
    sell_count: 0,
    market: {
      benchmark_symbol: 'sh.000300',
      prev_close: 3800,
      today_close: 3815,
      change_pct: 0.39,
      northbound_net_yi: 12.5,
      limit_up_count: 65,
      ai_view: '今日大盘震荡偏强',
      ai_view_engine: NLP_ENGINES.TRADING_AGENTS,
    },
    industry_attribution: [],
    risk_alerts: [],
    tomorrow_candidates: ['600519', '000001'],
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testConstantsFrozen();
  testFormatters();
  testPickTopTrades();
  testPickTopAlerts();
  testComputePnL();
  testComputeIndustryAttribution();
  testBuildJournalId();
  testBuildAIPrompt();
  testBuildHeuristicMarkdown();
  testPickHeuristicMood();
  testBuildHeuristicTags();
  testNormalizeAIPayload();
  testParseMarkdownSections();
  testSplitMarkdownToFields();

  await testGenerateForAll_noUsers();
  await testGenerateForAll_dryRun();
  await testGenerateForAll_skipAI();
  await testGenerateForAll_remoteThrow();
  await testGenerateForAll_remoteIncomplete();
  await testGenerateForAll_remoteOk();
  await testGenerateForAll_handEditedSkip();
  await testGenerateForAll_listThrow();
  await testGenerateForAll_multiUser_isolation();
  await testGenerateForAll_saveThrow();
  await testGenerateForAll_noPortfolio();
  await testGenerateForAll_overwriteHandEdited();
  await testGenerateForAll_prevSnapshotUsed();

  console.log(
    `\nEnhancedTradingJournalService tests: ${passed} ok, ${failed} failed (total ${
      passed + failed
    })`
  );
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
