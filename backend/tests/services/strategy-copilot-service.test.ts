/**
 * StrategyCopilotService 单元测试 (US-062 AI 策略人机协同 Copilot)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/strategy-copilot-service.test.ts
 *
 * 完全脱离 DB / Python 子进程 / TradingAgents 远端: 注入 fake StrategyCopilotDataSource.
 *
 * 覆盖维度:
 *   - 常量冻结校验 (COPILOT_INTENTS / NLP_ENGINES);
 *   - 纯函数:
 *     - nullableNumber (DECIMAL string / null / NaN / Infinity / 正常数);
 *     - normalizeBacktestLookback (默认 / clamp 上下限 / 非有限 / 浮点向下取整 / 负数);
 *     - normalizeIntent (4 种意图关键词 / override 优先 / 强类 > 普通类 / 空 / 兜底);
 *     - formatBacktestSummary (full / 部分字段缺失 / 比例 win_rate / 百分比 win_rate / 无日期);
 *     - safeJsonStringify (普通对象 / 循环引用 / undefined);
 *     - parseStrategyDraft (单块 / 多块 / typescript 别名 / 大小写 / 无代码 / 空字符串 / 仅 fence);
 *     - buildPromptContext (full / 空 user_prompt / 非字符串);
 *     - buildPromptText (有策略 / 无策略 / 有回测 / 无回测 / 完整模板);
 *     - buildHeuristicFallback (4 种 intent 分别 + 空 backtests + sharpe 强弱分级);
 *     - buildResponseFromPayload (success / FAILED → fallback / 远端 intent 覆盖 / generate_draft 抓代码 / suggested_params 非 object);
 *     - extractKeyDelta (有差异 / 完全相同 / 部分相同 / null 输入);
 *     - buildConversationId (固定时间格式校验 / 不同时间生成不同 ID);
 *   - service.askCopilot() e2e:
 *     - 普通 prompt + 策略 + 完整流程 success;
 *     - 远端 FAILED → 启发式 fallback (status='partial');
 *     - 远端 throw → 双重防御 catch + fallback (status='partial');
 *     - dry_run=true → persisted=false 不写表;
 *     - saveConversation throws → fail-OPEN (返回 + persisted=false + metadata.save_error);
 *     - 无 strategy_key → 跳过 loadStrategy + loadRecentBacktests;
 *     - intent_override 优先 normalizeIntent;
 *     - conversation_id 续接对话;
 *     - context load 失败仍能调远端;
 *   - service.loadContext() 边界 (空 strategy_key / lookback clamp).
 */

import {
  StrategyCopilotService,
  StrategyCopilotDataSource,
  CopilotResponse,
  StrategyMeta,
  BacktestSummary,
  RemoteCopilotPayload,
  CopilotIntent,
  COPILOT_INTENTS,
  TASK_INTENTS,
  ALL_COPILOT_INTENTS,
  isTaskIntent,
  NLP_ENGINES,
  DEFAULT_BACKTEST_LOOKBACK,
  MAX_BACKTEST_LOOKBACK,
  nullableNumber,
  normalizeBacktestLookback,
  normalizeIntent,
  formatBacktestSummary,
  safeJsonStringify,
  parseStrategyDraft,
  buildPromptContext,
  buildPromptText,
  buildHeuristicFallback,
  buildResponseFromPayload,
  extractKeyDelta,
  buildConversationId,
  // CO-002 / US-033 EntityExtractor
  inferStockMarket,
  extractStocks,
  extractIndustries,
  extractIndicators,
  extractNumbers,
  extractDates,
  extractStrategyParams,
  extractEntities,
  INDUSTRY_KEYWORDS,
  INDICATOR_ALIASES,
} from '../../src/services/StrategyCopilotService';

let failed = 0;
let passed = 0;

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
  assert(
    name,
    ok,
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
  );
}

// ---------------------------------------------------------------------------
// In-memory fake StrategyCopilotDataSource
// ---------------------------------------------------------------------------

interface FakeDataSourceState {
  /** strategy_key → StrategyMeta or null（null 表示策略不存在） */
  strategies?: Record<string, StrategyMeta | null>;
  /** strategy_key → BacktestSummary[] */
  backtests?: Record<string, BacktestSummary[]>;
  /** 远端 AI 返回的 payload。可以是 fn 接收 (prompt, intent) → payload，或固定值 */
  remotePayload?:
    | RemoteCopilotPayload
    | ((prompt: string, intent: CopilotIntent, metadata: Record<string, unknown>) => RemoteCopilotPayload);
  /** loadStrategy 调用时 throw */
  loadStrategyShouldThrow?: boolean;
  /** loadRecentBacktests 调用时 throw */
  loadBacktestsShouldThrow?: boolean;
  /** callRemoteCopilot 直接 throw（模拟双重防御） */
  callRemoteShouldThrow?: boolean;
  /** saveConversation 调用时 throw（测试 fail-OPEN） */
  saveShouldThrow?: boolean;
}

interface CallLog {
  loadStrategy: string[];
  loadRecentBacktests: Array<{ key: string; limit: number }>;
  callRemoteCopilot: Array<{ prompt: string; intent: CopilotIntent }>;
  saveConversation: CopilotResponse[];
}

function makeFakeDataSource(state: FakeDataSourceState = {}): {
  ds: StrategyCopilotDataSource;
  calls: CallLog;
} {
  const calls: CallLog = {
    loadStrategy: [],
    loadRecentBacktests: [],
    callRemoteCopilot: [],
    saveConversation: [],
  };
  const ds: StrategyCopilotDataSource = {
    async loadStrategy(strategyKey: string): Promise<StrategyMeta | null> {
      calls.loadStrategy.push(strategyKey);
      if (state.loadStrategyShouldThrow) throw new Error('fake loadStrategy boom');
      return state.strategies?.[strategyKey] ?? null;
    },
    async loadRecentBacktests(strategyKey: string, limit: number): Promise<BacktestSummary[]> {
      calls.loadRecentBacktests.push({ key: strategyKey, limit });
      if (state.loadBacktestsShouldThrow) throw new Error('fake loadBacktests boom');
      return state.backtests?.[strategyKey] ?? [];
    },
    async callRemoteCopilot(promptText, intent, metadata): Promise<RemoteCopilotPayload> {
      calls.callRemoteCopilot.push({ prompt: promptText, intent });
      if (state.callRemoteShouldThrow) throw new Error('fake callRemote boom');
      if (typeof state.remotePayload === 'function') {
        return state.remotePayload(promptText, intent, metadata);
      }
      return state.remotePayload || { status: 'COMPLETED', data: { reply: '默认回复' } };
    },
    async saveConversation(record: CopilotResponse): Promise<void> {
      calls.saveConversation.push(record);
      if (state.saveShouldThrow) throw new Error('fake save boom');
    },
  };
  return { ds, calls };
}

function makeStrategy(overrides: Partial<StrategyMeta> = {}): StrategyMeta {
  return {
    strategy_key: 'multi_factor',
    name: '多因子 Alpha',
    description: 'PB/PE/MOM 多因子组合',
    category: 'multi_factor',
    risk_level: 'medium',
    tags: ['factor', 'monthly'],
    default_params: { topN: 30, rebalance: 'monthly', weights: { value: 0.4, momentum: 0.6 } },
    ...overrides,
  };
}

function makeBacktest(overrides: Partial<BacktestSummary> = {}): BacktestSummary {
  return {
    task_id: 123,
    task_name: 'multi_factor 月度调仓',
    status: 'COMPLETED',
    start_date: '2025-01-01',
    end_date: '2025-12-31',
    created_at: '2026-01-15T10:00:00.000Z',
    total_return_pct: 12.3,
    sharpe_ratio: 1.45,
    max_drawdown_pct: -8.2,
    win_rate: 0.58,
    trade_count: 42,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

async function testConstantsFrozen(): Promise<void> {
  // COPILOT_INTENTS 是 Object.freeze 锁定的
  let threwIntents = false;
  try {
    (COPILOT_INTENTS as any).EXPLAIN_BACKTEST = 'mutated';
  } catch {
    threwIntents = true;
  }
  // sloppy mode (默认)：Object.freeze 静默不抛但不修改
  assert('COPILOT_INTENTS 锁定后 explain_backtest 未变', COPILOT_INTENTS.EXPLAIN_BACKTEST === 'explain_backtest', `threw=${threwIntents}`);

  let threwEngines = false;
  try {
    (NLP_ENGINES as any).TRADING_AGENTS = 'mutated';
  } catch {
    threwEngines = true;
  }
  assert('NLP_ENGINES 锁定后 trading_agents 未变', NLP_ENGINES.TRADING_AGENTS === 'trading_agents', `threw=${threwEngines}`);

  assertEqual('DEFAULT_BACKTEST_LOOKBACK = 5', DEFAULT_BACKTEST_LOOKBACK, 5);
  assertEqual('MAX_BACKTEST_LOOKBACK = 20', MAX_BACKTEST_LOOKBACK, 20);

  // CO-001: 11 个 intent 字面量稳定 (4 v1 dialog + 7 v2 task)
  assertEqual('COPILOT_INTENTS.QUERY_STOCKS', COPILOT_INTENTS.QUERY_STOCKS, 'query_stocks');
  assertEqual('COPILOT_INTENTS.RUN_BACKTEST', COPILOT_INTENTS.RUN_BACKTEST, 'run_backtest');
  assertEqual('COPILOT_INTENTS.QUERY_POSITIONS', COPILOT_INTENTS.QUERY_POSITIONS, 'query_positions');
  assertEqual('COPILOT_INTENTS.EXPLAIN_PICK', COPILOT_INTENTS.EXPLAIN_PICK, 'explain_pick');
  assertEqual('COPILOT_INTENTS.WHAT_IF', COPILOT_INTENTS.WHAT_IF, 'what_if');
  assertEqual('COPILOT_INTENTS.SET_ALERT', COPILOT_INTENTS.SET_ALERT, 'set_alert');
  assertEqual('COPILOT_INTENTS.GET_DIAGNOSIS', COPILOT_INTENTS.GET_DIAGNOSIS, 'get_diagnosis');
  assertEqual(
    'COPILOT_INTENTS 共 11 个 intent (4 dialog + 7 task)',
    Object.keys(COPILOT_INTENTS).length,
    11
  );

  // ALL_COPILOT_INTENTS = 11 个 intent 全集 (单一事实源)
  assertEqual('ALL_COPILOT_INTENTS.size = 11', ALL_COPILOT_INTENTS.size, 11);
  for (const v of Object.values(COPILOT_INTENTS)) {
    assert(
      `ALL_COPILOT_INTENTS 包含 ${v}`,
      (ALL_COPILOT_INTENTS as Set<string>).has(v as string)
    );
  }

  // TASK_INTENTS = 7 个 v2 执行式
  assertEqual('TASK_INTENTS.size = 7', TASK_INTENTS.size, 7);
  assert('TASK_INTENTS 含 QUERY_STOCKS', TASK_INTENTS.has(COPILOT_INTENTS.QUERY_STOCKS));
  assert('TASK_INTENTS 含 RUN_BACKTEST', TASK_INTENTS.has(COPILOT_INTENTS.RUN_BACKTEST));
  assert('TASK_INTENTS 含 QUERY_POSITIONS', TASK_INTENTS.has(COPILOT_INTENTS.QUERY_POSITIONS));
  assert('TASK_INTENTS 含 EXPLAIN_PICK', TASK_INTENTS.has(COPILOT_INTENTS.EXPLAIN_PICK));
  assert('TASK_INTENTS 含 WHAT_IF', TASK_INTENTS.has(COPILOT_INTENTS.WHAT_IF));
  assert('TASK_INTENTS 含 SET_ALERT', TASK_INTENTS.has(COPILOT_INTENTS.SET_ALERT));
  assert('TASK_INTENTS 含 GET_DIAGNOSIS', TASK_INTENTS.has(COPILOT_INTENTS.GET_DIAGNOSIS));

  // dialog-style 不能落到 TASK_INTENTS
  assert(
    'TASK_INTENTS 不含 EXPLAIN_BACKTEST',
    !TASK_INTENTS.has(COPILOT_INTENTS.EXPLAIN_BACKTEST)
  );
  assert(
    'TASK_INTENTS 不含 SUGGEST_PARAMS',
    !TASK_INTENTS.has(COPILOT_INTENTS.SUGGEST_PARAMS)
  );
  assert(
    'TASK_INTENTS 不含 GENERATE_DRAFT',
    !TASK_INTENTS.has(COPILOT_INTENTS.GENERATE_DRAFT)
  );
  assert('TASK_INTENTS 不含 GENERAL', !TASK_INTENTS.has(COPILOT_INTENTS.GENERAL));

  // isTaskIntent 兼容非字符串 / 未知字符串
  assert('isTaskIntent(query_stocks) = true', isTaskIntent('query_stocks'));
  assert('isTaskIntent(explain_backtest) = false', !isTaskIntent('explain_backtest'));
  assert('isTaskIntent(unknown) = false', !isTaskIntent('foobar'));
  assert('isTaskIntent(null) = false', !isTaskIntent(null));
  assert('isTaskIntent(123) = false', !isTaskIntent(123));
  assert('isTaskIntent(undefined) = false', !isTaskIntent(undefined));
}

// ---------------------------------------------------------------------------
// 纯函数: nullableNumber / normalizeBacktestLookback
// ---------------------------------------------------------------------------

async function testNullableNumber(): Promise<void> {
  assertEqual('nullableNumber null', nullableNumber(null), null);
  assertEqual('nullableNumber undefined', nullableNumber(undefined), null);
  assertEqual('nullableNumber NaN', nullableNumber(NaN), null);
  assertEqual('nullableNumber Infinity', nullableNumber(Infinity), null);
  assertEqual('nullableNumber 0', nullableNumber(0), 0);
  assertEqual('nullableNumber 正数', nullableNumber(12.3), 12.3);
  assertEqual('nullableNumber 负数', nullableNumber(-5.5), -5.5);
  assertEqual('nullableNumber 字符串数字', nullableNumber('12.3'), 12.3);
  assertEqual('nullableNumber 字符串非数', nullableNumber('abc'), null);
  assertEqual('nullableNumber 空字符串', nullableNumber(''), null);
}

async function testNormalizeBacktestLookback(): Promise<void> {
  assertEqual('lookback 默认', normalizeBacktestLookback(undefined), DEFAULT_BACKTEST_LOOKBACK);
  assertEqual('lookback null', normalizeBacktestLookback(null), DEFAULT_BACKTEST_LOOKBACK);
  assertEqual('lookback NaN', normalizeBacktestLookback(NaN), DEFAULT_BACKTEST_LOOKBACK);
  assertEqual('lookback 0', normalizeBacktestLookback(0), DEFAULT_BACKTEST_LOOKBACK);
  assertEqual('lookback 负数', normalizeBacktestLookback(-3), DEFAULT_BACKTEST_LOOKBACK);
  assertEqual('lookback 浮点向下取整', normalizeBacktestLookback(7.9), 7);
  assertEqual('lookback 正常', normalizeBacktestLookback(10), 10);
  assertEqual('lookback 超上限', normalizeBacktestLookback(99), MAX_BACKTEST_LOOKBACK);
  assertEqual('lookback 字符串', normalizeBacktestLookback('15'), 15);
  assertEqual('lookback 等于 MAX', normalizeBacktestLookback(MAX_BACKTEST_LOOKBACK), MAX_BACKTEST_LOOKBACK);
}

// ---------------------------------------------------------------------------
// 纯函数: normalizeIntent
// ---------------------------------------------------------------------------

async function testNormalizeIntent(): Promise<void> {
  // override 优先
  assertEqual('intent override 优先 explain', normalizeIntent('随便什么', 'explain_backtest'), 'explain_backtest');
  assertEqual('intent override generate', normalizeIntent('随便什么', 'generate_draft'), 'generate_draft');
  assertEqual('intent override 无效 → 看正文', normalizeIntent('帮我写一个策略', 'unknown_intent'), 'generate_draft');

  // 空 / 非字符串
  assertEqual('intent 空 prompt', normalizeIntent('', undefined), 'general');
  assertEqual('intent null', normalizeIntent(null, undefined), 'general');
  assertEqual('intent 非字符串', normalizeIntent(123, undefined), 'general');
  assertEqual('intent 全空格', normalizeIntent('   ', undefined), 'general');

  // generate_draft (最强 - 在前)
  assertEqual('intent 写策略', normalizeIntent('帮我写一个 RSI 反转策略'), 'generate_draft');
  assertEqual('intent 策略草案', normalizeIntent('给我一个策略草案'), 'generate_draft');
  assertEqual('intent 生成策略', normalizeIntent('生成一个策略来抓涨停'), 'generate_draft');
  assertEqual('intent generate strategy', normalizeIntent('please generate a strategy'), 'generate_draft');
  assertEqual('intent 新策略代码', normalizeIntent('帮我新建策略的代码'), 'generate_draft');

  // suggest_params
  assertEqual('intent 改参数', normalizeIntent('参数能不能改一下'), 'suggest_params');
  assertEqual('intent topN 调', normalizeIntent('把 topN 改成 30 会更好吗'), 'suggest_params');
  assertEqual('intent 调整参数', normalizeIntent('调整一下参数'), 'suggest_params');
  assertEqual('intent 优化参数', normalizeIntent('参数优化建议'), 'suggest_params');
  assertEqual('intent 建议改', normalizeIntent('建议改 topN'), 'suggest_params');

  // explain_backtest
  assertEqual('intent 解释 sharpe', normalizeIntent('为什么 sharpe 这么低'), 'explain_backtest');
  assertEqual('intent 解释回测', normalizeIntent('解释一下最近的回测'), 'explain_backtest');
  assertEqual('intent 夏普', normalizeIntent('夏普值代表什么'), 'explain_backtest');
  assertEqual('intent 最大回撤', normalizeIntent('最大回撤为啥这么高'), 'explain_backtest');
  assertEqual('intent 胜率', normalizeIntent('胜率怎么样'), 'explain_backtest');

  // general 兜底
  assertEqual('intent 通用问候', normalizeIntent('你好'), 'general');
  assertEqual('intent 无关键词', normalizeIntent('今天天气真好'), 'general');

  // 强类优先: "写代码" 而不是 "解释 sharpe"
  assertEqual(
    'intent generate_draft 在 explain_backtest 之前',
    normalizeIntent('帮我写一个策略，能解释 sharpe'),
    'generate_draft'
  );
  // suggest_params 在 explain_backtest 之前
  assertEqual(
    'intent suggest_params 在 explain_backtest 之前',
    normalizeIntent('调整参数让 sharpe 更高'),
    'suggest_params'
  );
}

// ---------------------------------------------------------------------------
// CO-001 / US-032 — 7 个 v2 task-style intent 识别
// ---------------------------------------------------------------------------

async function testNormalizeIntentTaskStyle(): Promise<void> {
  // override 走白名单：7 个 task intent 都能 override
  assertEqual(
    'intent override query_stocks',
    normalizeIntent('随便什么', 'query_stocks'),
    'query_stocks'
  );
  assertEqual(
    'intent override run_backtest',
    normalizeIntent('随便什么', 'run_backtest'),
    'run_backtest'
  );
  assertEqual(
    'intent override query_positions',
    normalizeIntent('随便什么', 'query_positions'),
    'query_positions'
  );
  assertEqual(
    'intent override explain_pick',
    normalizeIntent('随便什么', 'explain_pick'),
    'explain_pick'
  );
  assertEqual(
    'intent override what_if',
    normalizeIntent('随便什么', 'what_if'),
    'what_if'
  );
  assertEqual(
    'intent override set_alert',
    normalizeIntent('随便什么', 'set_alert'),
    'set_alert'
  );
  assertEqual(
    'intent override get_diagnosis',
    normalizeIntent('随便什么', 'get_diagnosis'),
    'get_diagnosis'
  );

  // 大小写 / 空格在 override 不敏感
  assertEqual(
    'intent override 大小写 + 空格 (RUN_BACKTEST)',
    normalizeIntent('随便什么', '  RUN_BACKTEST  '),
    'run_backtest'
  );

  // RUN_BACKTEST — "跑回测" / "跑 MFA 策略 topN=50" / "回测 multi_factor" / "run backtest"
  assertEqual(
    'intent 跑回测',
    normalizeIntent('帮我跑一次回测'),
    'run_backtest'
  );
  assertEqual(
    'intent 跑 MFA 策略 topN=50',
    normalizeIntent('跑 multi_factor 策略 topN=50 lookback=20'),
    'run_backtest'
  );
  assertEqual(
    'intent 回测 multi_factor',
    normalizeIntent('回测 multi_factor 看看效果'),
    'run_backtest'
  );
  assertEqual(
    'intent run backtest 英文',
    normalizeIntent('please run a backtest for me'),
    'run_backtest'
  );

  // SET_ALERT — "提醒我" / "告警" / "set alert"
  assertEqual(
    'intent 设置提醒',
    normalizeIntent('如果 002230 跌破 50 提醒我'),
    'set_alert'
  );
  assertEqual(
    'intent 设置告警',
    normalizeIntent('设置告警条件'),
    'set_alert'
  );
  assertEqual(
    'intent alert me 英文',
    normalizeIntent('alert me when AAPL drops 5%'),
    'set_alert'
  );

  // WHAT_IF — "假如 / 假设 / 如果...会..."
  assertEqual(
    'intent 假如全清',
    normalizeIntent('假如我现在全清 ZX 行业 pnl 会变多少'),
    'what_if'
  );
  assertEqual(
    'intent 假设清仓',
    normalizeIntent('假设我现在清仓所有持仓'),
    'what_if'
  );
  assertEqual(
    'intent what if 英文',
    normalizeIntent('what if I sell half my position'),
    'what_if'
  );
  assertEqual(
    'intent 如果加仓会怎样',
    normalizeIntent('如果加仓 600519 净值会怎么变'),
    'what_if'
  );

  // EXPLAIN_PICK — "为什么 600519 被推荐"
  assertEqual(
    'intent 为什么 600519 被推荐',
    normalizeIntent('为什么 600519 今天被推荐'),
    'explain_pick'
  );
  assertEqual(
    'intent 为啥推荐 002230',
    normalizeIntent('为啥 002230 被选中'),
    'explain_pick'
  );
  assertEqual(
    'intent why was 600519 picked',
    normalizeIntent('why was 600519 recommended today'),
    'explain_pick'
  );
  assertEqual(
    'intent 解释 600519 推荐理由',
    normalizeIntent('解释 600519 入选理由'),
    'explain_pick'
  );

  // QUERY_POSITIONS — "我现在哪些持仓"
  assertEqual(
    'intent 我的持仓行业集中度',
    normalizeIntent('我现在哪些持仓行业集中度 > 25%'),
    'query_positions'
  );
  assertEqual(
    'intent 我的仓位',
    normalizeIntent('我的仓位中哪些今天涨幅最大'),
    'query_positions'
  );
  assertEqual(
    'intent 查看我的持仓',
    normalizeIntent('查看我的持仓'),
    'query_positions'
  );

  // GET_DIAGNOSIS — "为什么跑输基准 / 诊断策略"
  assertEqual(
    'intent 跑输基准',
    normalizeIntent('为什么我最近 30 天跑输基准'),
    'get_diagnosis'
  );
  assertEqual(
    'intent 跑输 underperform',
    normalizeIntent('我的组合为什么 underperform 沪深300'),
    'get_diagnosis'
  );
  assertEqual(
    'intent 诊断策略',
    normalizeIntent('帮我诊断一下策略'),
    'get_diagnosis'
  );

  // QUERY_STOCKS — "找今天 ... 的票 / 筛选 / 选股"
  assertEqual(
    'intent 找今天北向加仓的票',
    normalizeIntent('找今天北向加仓 + RSI 超卖 + 行业 hot 的票'),
    'query_stocks'
  );
  assertEqual(
    'intent 筛选股票',
    normalizeIntent('筛选出 RSI 小于 30 的股'),
    'query_stocks'
  );
  assertEqual(
    'intent list stocks with',
    normalizeIntent('list stocks with RSI below 30'),
    'query_stocks'
  );
  assertEqual(
    'intent 选股条件',
    normalizeIntent('选股条件 MACD 金叉'),
    'query_stocks'
  );

  // 优先级冲突 case — task 强模式 > v1 dialog 弱模式
  // "跑 MFA 回测看 sharpe" 该是 run_backtest 而非 explain_backtest
  assertEqual(
    'intent task RUN_BACKTEST 优先于 dialog EXPLAIN_BACKTEST',
    normalizeIntent('跑 multi_factor 回测看 sharpe'),
    'run_backtest'
  );
  // "提醒我 sharpe 跌破 1" 该是 set_alert 而非 explain_backtest
  assertEqual(
    'intent task SET_ALERT 优先于 dialog EXPLAIN_BACKTEST',
    normalizeIntent('提醒我 sharpe 跌破 1'),
    'set_alert'
  );
  // "假如我把 topN 改成 50 sharpe 会怎样" → WHAT_IF 而非 SUGGEST_PARAMS
  assertEqual(
    'intent task WHAT_IF 优先于 dialog SUGGEST_PARAMS',
    normalizeIntent('假如我把 topN 改成 50 sharpe 会怎样'),
    'what_if'
  );
  // "为什么 600519 被推荐 sharpe" → EXPLAIN_PICK 而非 EXPLAIN_BACKTEST
  assertEqual(
    'intent task EXPLAIN_PICK 优先于 dialog EXPLAIN_BACKTEST',
    normalizeIntent('为什么 600519 被推荐看 sharpe'),
    'explain_pick'
  );

  // 不应误判: 纯对话 dialog intent 仍能落到原 v1 类
  assertEqual(
    'intent 纯 explain 仍 explain_backtest (无 task 关键词)',
    normalizeIntent('为什么 sharpe 这么低'),
    'explain_backtest'
  );
  assertEqual(
    'intent 纯 generate 仍 generate_draft',
    normalizeIntent('帮我写一个 RSI 反转策略'),
    'generate_draft'
  );
  assertEqual(
    'intent 纯 suggest 仍 suggest_params',
    normalizeIntent('参数能不能改一下'),
    'suggest_params'
  );

  // buildResponseFromPayload — 远端返回任意 task intent 都能透传 (白名单)
  const ctx = {
    conversation_id: 'COP-test',
    strategy_key: null,
    intent: COPILOT_INTENTS.GENERAL,
    prompt: '',
    promptContext: buildPromptContext({
      strategy: null,
      backtests: [],
      user_prompt: '',
      intent: COPILOT_INTENTS.GENERAL,
    }),
    metadata: {},
    now: new Date('2026-06-19T00:00:00Z'),
  };
  const taskRes = buildResponseFromPayload(
    { status: 'COMPLETED', data: { reply: 'ok', intent: 'query_stocks' } },
    ctx
  );
  assertEqual('远端 intent=query_stocks 透传', taskRes.intent, 'query_stocks');
  const setAlertRes = buildResponseFromPayload(
    { status: 'COMPLETED', data: { reply: 'ok', intent: 'SET_ALERT' } },
    ctx
  );
  assertEqual('远端 intent=SET_ALERT (大写) 仍透传', setAlertRes.intent, 'set_alert');
  const bogusRes = buildResponseFromPayload(
    { status: 'COMPLETED', data: { reply: 'ok', intent: 'made_up_intent' } },
    ctx
  );
  assertEqual('远端未知 intent 回退到 ctx.intent', bogusRes.intent, 'general');
}

// ---------------------------------------------------------------------------
// 纯函数: formatBacktestSummary
// ---------------------------------------------------------------------------

async function testFormatBacktestSummary(): Promise<void> {
  const full = makeBacktest();
  const s1 = formatBacktestSummary(0, full);
  assert('summary 含 task_id', s1.includes('#123'));
  assert('summary 含 date', s1.includes('2026-01-15'));
  assert('summary 含 return', s1.includes('return=12.30%'));
  assert('summary 含 sharpe', s1.includes('sharpe=1.45'));
  assert('summary 含 max_dd', s1.includes('max_dd=-8.20%'));
  assert('summary 含 win', s1.includes('win=58%'));
  assert('summary 含 trades', s1.includes('trades=42'));
  assert('summary 含 status', s1.includes('(COMPLETED)'));
  assert('summary 索引 +1', s1.startsWith('1.'));

  // 部分缺失 → 省略 token
  const partial = makeBacktest({ sharpe_ratio: null, max_drawdown_pct: null });
  const s2 = formatBacktestSummary(1, partial);
  assert('summary 缺 sharpe 不写 null', !s2.includes('sharpe='));
  assert('summary 缺 sharpe 仍含 return', s2.includes('return='));
  assert('summary 索引 2.', s2.startsWith('2.'));

  // 百分比 win_rate (>1) 走分支
  const pctWin = makeBacktest({ win_rate: 58 });
  const s3 = formatBacktestSummary(0, pctWin);
  assert('summary 百分比 win_rate', s3.includes('win=58%'));

  // 比例 win_rate (≤1) ×100 转百分
  const ratioWin = makeBacktest({ win_rate: 0.62 });
  const s4 = formatBacktestSummary(0, ratioWin);
  assert('summary 比例 win_rate ×100', s4.includes('win=62%'));

  // 无日期
  const noDate = makeBacktest({ created_at: '' });
  const s5 = formatBacktestSummary(0, noDate);
  assert('summary 无日期 → (no date)', s5.includes('(no date)'));

  // 全部 null
  const allNull = makeBacktest({
    total_return_pct: null,
    sharpe_ratio: null,
    max_drawdown_pct: null,
    win_rate: null,
    trade_count: null,
  });
  const s6 = formatBacktestSummary(0, allNull);
  assert('summary 全 null 仍含 task_id', s6.includes('#123'));
  assert('summary 全 null 含 status', s6.includes('COMPLETED'));
}

// ---------------------------------------------------------------------------
// 纯函数: safeJsonStringify
// ---------------------------------------------------------------------------

async function testSafeJsonStringify(): Promise<void> {
  assertEqual('json 普通对象', safeJsonStringify({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
  assertEqual('json undefined → null', safeJsonStringify({ a: undefined }), '{"a":null}');
  assertEqual('json 数组', safeJsonStringify([1, 2, 3]), '[1,2,3]');

  // 循环引用
  const cyclic: any = { name: 'root' };
  cyclic.self = cyclic;
  const result = safeJsonStringify(cyclic);
  assertEqual('json 循环引用 → unserializable', result, '(unserializable)');
}

// ---------------------------------------------------------------------------
// 纯函数: parseStrategyDraft
// ---------------------------------------------------------------------------

async function testParseStrategyDraft(): Promise<void> {
  // 单块 ts
  const txt1 = '这是一个策略草案:\n```ts\nclass MyStrat {}\n```\n说明...';
  assertEqual('parseStrategyDraft 单块 ts', parseStrategyDraft(txt1), 'class MyStrat {}');

  // typescript 别名
  const txt2 = '```typescript\nexport const a = 1;\n```';
  assertEqual('parseStrategyDraft typescript 别名', parseStrategyDraft(txt2), 'export const a = 1;');

  // 大小写不敏感
  const txt3 = '```TS\nconst x = 1;\n```';
  assertEqual('parseStrategyDraft 大小写 TS', parseStrategyDraft(txt3), 'const x = 1;');

  // 多块
  const txt4 = '```ts\nblock1\n```\n中间\n```typescript\nblock2\n```';
  assertEqual('parseStrategyDraft 多块拼接', parseStrategyDraft(txt4), 'block1\n\nblock2');

  // 无代码块
  assertEqual('parseStrategyDraft 无 fence', parseStrategyDraft('普通文本'), null);

  // 空字符串
  assertEqual('parseStrategyDraft 空字符串', parseStrategyDraft(''), null);

  // 非字符串
  assertEqual('parseStrategyDraft 非字符串', parseStrategyDraft(null as any), null);

  // 仅 fence 无内容
  assertEqual('parseStrategyDraft 仅空 fence', parseStrategyDraft('```ts\n```'), null);

  // bash 块不抓
  assertEqual('parseStrategyDraft bash 块不抓', parseStrategyDraft('```bash\nls\n```'), null);
}

// ---------------------------------------------------------------------------
// 纯函数: buildPromptContext + buildPromptText
// ---------------------------------------------------------------------------

async function testBuildPromptContext(): Promise<void> {
  const ctx = buildPromptContext({
    strategy: makeStrategy(),
    backtests: [makeBacktest()],
    user_prompt: '  test  ',
    intent: 'explain_backtest',
  });
  assertEqual('promptContext 已 trim', ctx.user_prompt, 'test');
  assertEqual('promptContext intent', ctx.intent, 'explain_backtest');
  assertEqual('promptContext 1 个回测', ctx.backtests.length, 1);

  // 非字符串
  const ctx2 = buildPromptContext({
    strategy: null,
    backtests: [],
    user_prompt: 123 as any,
    intent: 'general',
  });
  assertEqual('promptContext 非字符串 user_prompt → ""', ctx2.user_prompt, '');
}

async function testBuildPromptText(): Promise<void> {
  const strategy = makeStrategy();
  const backtest = makeBacktest();
  const ctx = buildPromptContext({
    strategy,
    backtests: [backtest],
    user_prompt: '解释一下 sharpe',
    intent: 'explain_backtest',
  });
  const text = buildPromptText(ctx);
  assert('promptText 含 System', text.startsWith('System:'));
  assert('promptText 含 Strategy:', text.includes('Strategy: multi_factor'));
  assert('promptText 含 strategy name', text.includes('多因子 Alpha'));
  assert('promptText 含 risk', text.includes('risk=medium'));
  assert('promptText 含 Description', text.includes('Description: PB/PE/MOM'));
  assert('promptText 含 Default params', text.includes('Default params:'));
  assert('promptText 含 topN', text.includes('"topN":30'));
  assert('promptText 含 Recent backtests', text.includes('Recent backtests (last 1):'));
  assert('promptText 含 task_id', text.includes('#123'));
  assert('promptText 含 User intent', text.includes('User intent: explain_backtest'));
  assert('promptText 含 User question', text.includes('User question: 解释一下 sharpe'));

  // 无策略
  const ctxNoStrategy = buildPromptContext({
    strategy: null,
    backtests: [],
    user_prompt: '通用问句',
    intent: 'general',
  });
  const text2 = buildPromptText(ctxNoStrategy);
  assert('promptText 无策略 不含 Strategy:', !text2.includes('Strategy:'));
  assert('promptText 无策略 不含 Default params:', !text2.includes('Default params:'));
  assert('promptText 无回测 含 (none)', text2.includes('Recent backtests: (none)'));
  assert('promptText 仍含 User question', text2.includes('User question: 通用问句'));

  // 仅策略无回测
  const ctxOnlyStrat = buildPromptContext({
    strategy: makeStrategy({ description: null }),
    backtests: [],
    user_prompt: '',
    intent: 'general',
  });
  const text3 = buildPromptText(ctxOnlyStrat);
  assert('promptText 无 description 不写 Description:', !text3.includes('Description:'));
  assert('promptText 空 prompt 仍含 User question:', text3.includes('User question:'));
}

// ---------------------------------------------------------------------------
// 纯函数: buildHeuristicFallback (4 种 intent)
// ---------------------------------------------------------------------------

async function testBuildHeuristicFallback(): Promise<void> {
  // explain_backtest: 有最近回测
  const ctx1 = buildPromptContext({
    strategy: makeStrategy(),
    backtests: [makeBacktest({ sharpe_ratio: 1.8 })],
    user_prompt: '',
    intent: 'explain_backtest',
  });
  const fb1 = buildHeuristicFallback(ctx1);
  assert('fallback explain_backtest 含策略名', fb1.reply.includes('多因子 Alpha'));
  assert('fallback explain_backtest 含 sharpe', fb1.reply.includes('sharpe 1.80'));
  assert('fallback explain_backtest 优秀 label', fb1.reply.includes('优秀'));
  assertEqual('fallback explain 无 suggested', fb1.suggested_params, {});
  assertEqual('fallback explain 无 draft', fb1.strategy_draft, null);

  // explain_backtest: sharpe 不同档位
  const fb1b = buildHeuristicFallback(
    buildPromptContext({
      strategy: makeStrategy(),
      backtests: [makeBacktest({ sharpe_ratio: 1.2 })],
      user_prompt: '',
      intent: 'explain_backtest',
    })
  );
  assert('fallback sharpe 1.2 → 尚可', fb1b.reply.includes('尚可'));
  const fb1c = buildHeuristicFallback(
    buildPromptContext({
      strategy: makeStrategy(),
      backtests: [makeBacktest({ sharpe_ratio: 0.7 })],
      user_prompt: '',
      intent: 'explain_backtest',
    })
  );
  assert('fallback sharpe 0.7 → 一般', fb1c.reply.includes('一般'));
  const fb1d = buildHeuristicFallback(
    buildPromptContext({
      strategy: makeStrategy(),
      backtests: [makeBacktest({ sharpe_ratio: 0.2 })],
      user_prompt: '',
      intent: 'explain_backtest',
    })
  );
  assert('fallback sharpe 0.2 → 偏弱', fb1d.reply.includes('偏弱'));

  // explain_backtest: 无回测
  const fb2 = buildHeuristicFallback(
    buildPromptContext({
      strategy: makeStrategy(),
      backtests: [],
      user_prompt: '',
      intent: 'explain_backtest',
    })
  );
  assert('fallback explain 无回测 → 提示先跑', fb2.reply.includes('还没有跑过回测'));

  // suggest_params: sharpe 弱
  const fb3 = buildHeuristicFallback(
    buildPromptContext({
      strategy: makeStrategy(),
      backtests: [makeBacktest({ sharpe_ratio: 0.6 })],
      user_prompt: '',
      intent: 'suggest_params',
    })
  );
  assert('fallback suggest sharpe 弱 → 收紧选股', fb3.reply.includes('topN'));
  assertEqual('fallback suggest sharpe 弱 → topN=24', fb3.suggested_params.topN, 24);

  // suggest_params: drawdown 大
  const fb4 = buildHeuristicFallback(
    buildPromptContext({
      strategy: makeStrategy(),
      backtests: [makeBacktest({ sharpe_ratio: 1.5, max_drawdown_pct: -20 })],
      user_prompt: '',
      intent: 'suggest_params',
    })
  );
  assert('fallback suggest drawdown → stop loss 提示', fb4.reply.includes('stop loss'));

  // suggest_params: 表现 ok
  const fb5 = buildHeuristicFallback(
    buildPromptContext({
      strategy: makeStrategy(),
      backtests: [makeBacktest({ sharpe_ratio: 1.8, max_drawdown_pct: -5 })],
      user_prompt: '',
      intent: 'suggest_params',
    })
  );
  assert('fallback suggest 表现 ok → grid search', fb5.reply.includes('grid search'));

  // generate_draft
  const fb6 = buildHeuristicFallback(
    buildPromptContext({
      strategy: makeStrategy(),
      backtests: [],
      user_prompt: '',
      intent: 'generate_draft',
    })
  );
  assert('fallback generate → 提示 universe', fb6.reply.includes('universe'));
  assert('fallback generate → 提示 entry signal', fb6.reply.includes('entry signal'));

  // general
  const fb7 = buildHeuristicFallback(
    buildPromptContext({
      strategy: makeStrategy(),
      backtests: [],
      user_prompt: '',
      intent: 'general',
    })
  );
  assert('fallback general → 列出 3 大能力', fb7.reply.includes('1.') && fb7.reply.includes('2.') && fb7.reply.includes('3.'));

  // 无策略
  const fb8 = buildHeuristicFallback(
    buildPromptContext({
      strategy: null,
      backtests: [],
      user_prompt: '',
      intent: 'explain_backtest',
    })
  );
  assert('fallback 无策略 → 显示 (未指定策略)', fb8.reply.includes('(未指定策略)'));
}

// ---------------------------------------------------------------------------
// 纯函数: buildResponseFromPayload
// ---------------------------------------------------------------------------

async function testBuildResponseFromPayload(): Promise<void> {
  const baseCtx = {
    conversation_id: 'COP-test-001',
    strategy_key: 'multi_factor' as string | null,
    intent: 'explain_backtest' as CopilotIntent,
    prompt: '解释 sharpe',
    promptContext: buildPromptContext({
      strategy: makeStrategy(),
      backtests: [makeBacktest()],
      user_prompt: '解释 sharpe',
      intent: 'explain_backtest',
    }),
    metadata: { foo: 'bar' },
    now: new Date('2026-06-08T10:15:30.000Z'),
  };

  // 成功 payload
  const successPayload: RemoteCopilotPayload = {
    status: 'COMPLETED',
    data: {
      reply: '你的策略最近 sharpe 表现不错',
      intent: 'explain_backtest',
      suggested_params: { topN: 25 },
    },
  };
  const r1 = buildResponseFromPayload(successPayload, baseCtx);
  assertEqual('response success status', r1.status, 'completed');
  assertEqual('response success nlp_engine', r1.nlp_engine, NLP_ENGINES.TRADING_AGENTS);
  assertEqual('response success reply', r1.reply, '你的策略最近 sharpe 表现不错');
  assertEqual('response success suggested_params', r1.suggested_params, { topN: 25 });
  assertEqual('response success error null', r1.error, null);
  assertEqual('response success persisted=false 默认', r1.persisted, false);
  assertEqual('response success metadata 含 foo', r1.metadata.foo, 'bar');

  // FAILED → fallback
  const failedPayload: RemoteCopilotPayload = {
    status: 'FAILED',
    data: { error: '远端 503' },
  };
  const r2 = buildResponseFromPayload(failedPayload, baseCtx);
  assertEqual('response failed → status=partial', r2.status, 'partial');
  assertEqual('response failed → nlp_engine=heuristic', r2.nlp_engine, NLP_ENGINES.HEURISTIC);
  assert('response failed → reply 非空 (启发式 fallback)', r2.reply.length > 0);
  assertEqual('response failed → error 含 远端 503', r2.error, '远端 503');

  // 远端 reply 空 → fallback
  const emptyReplyPayload: RemoteCopilotPayload = {
    status: 'COMPLETED',
    data: { reply: '' },
  };
  const r3 = buildResponseFromPayload(emptyReplyPayload, baseCtx);
  assertEqual('response 空 reply → status=partial', r3.status, 'partial');
  assertEqual('response 空 reply → engine=heuristic', r3.nlp_engine, NLP_ENGINES.HEURISTIC);

  // 远端 intent 覆盖
  const overridePayload: RemoteCopilotPayload = {
    status: 'COMPLETED',
    data: {
      reply: '请考虑生成新策略',
      intent: 'generate_draft',
    },
  };
  const r4 = buildResponseFromPayload(overridePayload, baseCtx);
  assertEqual('response 远端 intent 覆盖', r4.intent, 'generate_draft');

  // 远端 intent 无效 → 用本地
  const invalidIntentPayload: RemoteCopilotPayload = {
    status: 'COMPLETED',
    data: {
      reply: '回复',
      intent: 'unknown_x',
    },
  };
  const r5 = buildResponseFromPayload(invalidIntentPayload, baseCtx);
  assertEqual('response 无效远端 intent → 用本地', r5.intent, 'explain_backtest');

  // generate_draft + 远端 strategy_draft 字段直接取
  const draftPayload: RemoteCopilotPayload = {
    status: 'COMPLETED',
    data: {
      reply: '草案如下',
      intent: 'generate_draft',
      strategy_draft: 'class MyStrat {}',
    },
  };
  const r6 = buildResponseFromPayload(draftPayload, baseCtx);
  assertEqual('response generate_draft 直接取 field', r6.strategy_draft, 'class MyStrat {}');

  // generate_draft 无 draft 字段 → 从 reply 抓 fence
  const draftFromFencePayload: RemoteCopilotPayload = {
    status: 'COMPLETED',
    data: {
      reply: '草案:\n```ts\nclass A {}\n```',
      intent: 'generate_draft',
    },
  };
  const r7 = buildResponseFromPayload(draftFromFencePayload, baseCtx);
  assertEqual('response generate_draft 抓 fence', r7.strategy_draft, 'class A {}');

  // 非 generate_draft → strategy_draft 永远 null（即使 reply 有 fence）
  const fenceButExplain: RemoteCopilotPayload = {
    status: 'COMPLETED',
    data: {
      reply: '虽然有代码:\n```ts\nconsole.log("x");\n```',
      intent: 'explain_backtest',
    },
  };
  const r8 = buildResponseFromPayload(fenceButExplain, baseCtx);
  assertEqual('response explain_backtest 不抓 fence', r8.strategy_draft, null);

  // suggested_params 非 object → {}
  const invalidParamsPayload: RemoteCopilotPayload = {
    status: 'COMPLETED',
    data: {
      reply: '回复',
      suggested_params: 'not-an-object' as any,
    },
  };
  const r9 = buildResponseFromPayload(invalidParamsPayload, baseCtx);
  assertEqual('response suggested_params 非 object → {}', r9.suggested_params, {});

  // next_action 透传
  const nextActionPayload: RemoteCopilotPayload = {
    status: 'COMPLETED',
    data: {
      reply: '回复',
      next_action: 'run_backtest',
    },
  };
  const r10 = buildResponseFromPayload(nextActionPayload, baseCtx);
  assertEqual('response next_action 透传', r10.next_action, 'run_backtest');

  // generated_at = now.toISOString()
  assertEqual('response generated_at = now', r1.generated_at, '2026-06-08T10:15:30.000Z');
}

// ---------------------------------------------------------------------------
// 纯函数: extractKeyDelta
// ---------------------------------------------------------------------------

async function testExtractKeyDelta(): Promise<void> {
  const def = { topN: 30, rebalance: 'monthly', weights: { a: 0.5 } };

  // 有差异
  const d1 = extractKeyDelta(def, { topN: 25, rebalance: 'monthly' });
  assertEqual('delta 1 项变化', d1.length, 1);
  assertEqual('delta key=topN', d1[0].key, 'topN');
  assertEqual('delta before=30', d1[0].before, 30);
  assertEqual('delta after=25', d1[0].after, 25);

  // 完全相同 → 空数组
  const d2 = extractKeyDelta(def, { topN: 30, rebalance: 'monthly' });
  assertEqual('delta 无变化', d2, []);

  // 新增 key (before 不存在)
  const d3 = extractKeyDelta(def, { newKey: 'value' });
  assertEqual('delta 新增 key 1 项', d3.length, 1);
  assertEqual('delta 新增 key before=null', d3[0].before, null);
  assertEqual('delta 新增 key after', d3[0].after, 'value');

  // 嵌套 object 比较 (JSON.stringify)
  const d4 = extractKeyDelta(def, { weights: { a: 0.5 } });
  assertEqual('delta 嵌套对象相同 → 空', d4, []);
  const d5 = extractKeyDelta(def, { weights: { a: 0.6 } });
  assertEqual('delta 嵌套对象不同 → 1 项', d5.length, 1);

  // null 输入
  assertEqual('delta suggested null', extractKeyDelta(def, null), []);
  assertEqual('delta suggested undefined', extractKeyDelta(def, undefined), []);

  // default null + suggested 有
  const d6 = extractKeyDelta(null, { topN: 25 });
  assertEqual('delta default null + suggested 1 项', d6.length, 1);
  assertEqual('delta default null before=null', d6[0].before, null);
}

// ---------------------------------------------------------------------------
// 纯函数: buildConversationId
// ---------------------------------------------------------------------------

async function testBuildConversationId(): Promise<void> {
  const t = new Date('2026-06-08T10:15:30.000Z');
  const id = buildConversationId(t);
  assert('conversation_id COP- 前缀', id.startsWith('COP-'));
  assert('conversation_id 含 20260608101530', id.includes('20260608101530'));
  // 格式: COP-{14digit}-{4hex}
  assert('conversation_id 总长度', id.length === 4 + 14 + 1 + 4, `len=${id.length}`);

  // 不同时间生成不同 ID
  const t2 = new Date('2026-06-08T10:15:31.000Z');
  const id2 = buildConversationId(t2);
  assert('conversation_id 不同秒不同 ID', id !== id2);
}

// ---------------------------------------------------------------------------
// service.askCopilot e2e
// ---------------------------------------------------------------------------

async function testAskCopilotSuccess(): Promise<void> {
  const { ds, calls } = makeFakeDataSource({
    strategies: { multi_factor: makeStrategy() },
    backtests: { multi_factor: [makeBacktest()] },
    remotePayload: {
      status: 'COMPLETED',
      data: {
        reply: 'sharpe=1.45 表现不错',
        intent: 'explain_backtest',
        suggested_params: { topN: 25 },
      },
    },
  });
  const svc = new StrategyCopilotService(ds);
  const result = await svc.askCopilot('解释 sharpe', {
    strategy_key: 'multi_factor',
    now: new Date('2026-06-08T10:15:30.000Z'),
  });

  assertEqual('askCopilot success status', result.status, 'completed');
  assertEqual('askCopilot success nlp_engine', result.nlp_engine, NLP_ENGINES.TRADING_AGENTS);
  assertEqual('askCopilot success reply', result.reply, 'sharpe=1.45 表现不错');
  assertEqual('askCopilot success suggested_params', result.suggested_params, { topN: 25 });
  assertEqual('askCopilot success persisted=true', result.persisted, true);
  assertEqual('askCopilot success strategy_key', result.strategy_key, 'multi_factor');
  assertEqual('askCopilot success intent', result.intent, 'explain_backtest');
  assert('askCopilot success conversation_id 自动生成', result.conversation_id.startsWith('COP-'));
  assertEqual('loadStrategy 调用 1 次', calls.loadStrategy.length, 1);
  assertEqual('loadStrategy 用 multi_factor', calls.loadStrategy[0], 'multi_factor');
  assertEqual('loadRecentBacktests 调用 1 次', calls.loadRecentBacktests.length, 1);
  assertEqual('loadRecentBacktests limit=5', calls.loadRecentBacktests[0].limit, 5);
  assertEqual('callRemoteCopilot 调用 1 次', calls.callRemoteCopilot.length, 1);
  assertEqual('saveConversation 调用 1 次', calls.saveConversation.length, 1);
  // prompt text 含关键拼接
  const remotePrompt = calls.callRemoteCopilot[0].prompt;
  assert('prompt 含 Strategy', remotePrompt.includes('Strategy: multi_factor'));
  assert('prompt 含 backtest', remotePrompt.includes('#123'));
  assert('prompt 含 User question', remotePrompt.includes('User question: 解释 sharpe'));
}

async function testAskCopilotRemoteFailed(): Promise<void> {
  const { ds, calls } = makeFakeDataSource({
    strategies: { multi_factor: makeStrategy() },
    backtests: { multi_factor: [makeBacktest()] },
    remotePayload: { status: 'FAILED', data: { error: 'remote down' } },
  });
  const svc = new StrategyCopilotService(ds);
  const result = await svc.askCopilot('解释 sharpe', {
    strategy_key: 'multi_factor',
  });

  assertEqual('askCopilot remote FAILED → status=partial', result.status, 'partial');
  assertEqual('askCopilot remote FAILED → nlp_engine=heuristic', result.nlp_engine, NLP_ENGINES.HEURISTIC);
  assert('askCopilot remote FAILED → reply 非空（启发式）', result.reply.length > 0);
  assertEqual('askCopilot remote FAILED → error 字段', result.error, 'remote down');
  // 仍 persist
  assertEqual('askCopilot remote FAILED 仍 persist', result.persisted, true);
  assertEqual('saveConversation 调用 1 次', calls.saveConversation.length, 1);
}

async function testAskCopilotRemoteThrows(): Promise<void> {
  const { ds } = makeFakeDataSource({
    strategies: { multi_factor: makeStrategy() },
    backtests: { multi_factor: [makeBacktest()] },
    callRemoteShouldThrow: true,
  });
  const svc = new StrategyCopilotService(ds);
  const result = await svc.askCopilot('解释 sharpe', { strategy_key: 'multi_factor' });

  assertEqual('askCopilot remote throw → status=partial', result.status, 'partial');
  assertEqual('askCopilot remote throw → nlp_engine=heuristic', result.nlp_engine, NLP_ENGINES.HEURISTIC);
  assert('askCopilot remote throw → error 含 boom', (result.error || '').includes('boom'));
}

async function testAskCopilotDryRun(): Promise<void> {
  const { ds, calls } = makeFakeDataSource({
    strategies: { multi_factor: makeStrategy() },
    backtests: { multi_factor: [] },
    remotePayload: { status: 'COMPLETED', data: { reply: '回复' } },
  });
  const svc = new StrategyCopilotService(ds);
  const result = await svc.askCopilot('问题', {
    strategy_key: 'multi_factor',
    dry_run: true,
  });

  assertEqual('askCopilot dry_run persisted=false', result.persisted, false);
  assertEqual('askCopilot dry_run saveConversation 不调', calls.saveConversation.length, 0);
}

async function testAskCopilotSaveFailOpen(): Promise<void> {
  const { ds } = makeFakeDataSource({
    strategies: { multi_factor: makeStrategy() },
    backtests: { multi_factor: [] },
    remotePayload: { status: 'COMPLETED', data: { reply: '回复' } },
    saveShouldThrow: true,
  });
  const svc = new StrategyCopilotService(ds);
  const result = await svc.askCopilot('问题', { strategy_key: 'multi_factor' });

  assertEqual('askCopilot save fail-OPEN → persisted=false', result.persisted, false);
  assertEqual('askCopilot save fail 仍 status=completed', result.status, 'completed');
  assert('askCopilot save fail → metadata 含 save_error', 'save_error' in result.metadata);
  assert(
    'askCopilot save fail → save_error 含 boom',
    String((result.metadata as any).save_error).includes('boom')
  );
}

async function testAskCopilotNoStrategy(): Promise<void> {
  const { ds, calls } = makeFakeDataSource({
    remotePayload: { status: 'COMPLETED', data: { reply: '通用回复' } },
  });
  const svc = new StrategyCopilotService(ds);
  const result = await svc.askCopilot('你好');

  assertEqual('askCopilot 无 strategy 不调 loadStrategy', calls.loadStrategy.length, 0);
  assertEqual('askCopilot 无 strategy 不调 loadBacktests', calls.loadRecentBacktests.length, 0);
  assertEqual('askCopilot 无 strategy strategy_key=null', result.strategy_key, null);
  assertEqual('askCopilot 无 strategy intent=general', result.intent, 'general');
  // prompt 也不应有 Strategy:
  assert(
    'askCopilot 无 strategy prompt 不含 Strategy:',
    !calls.callRemoteCopilot[0].prompt.includes('Strategy:')
  );
}

async function testAskCopilotIntentOverride(): Promise<void> {
  const { ds } = makeFakeDataSource({
    remotePayload: { status: 'COMPLETED', data: { reply: '回复' } },
  });
  const svc = new StrategyCopilotService(ds);
  const result = await svc.askCopilot('解释 sharpe', {
    intent_override: 'generate_draft', // 显式覆盖
  });

  assertEqual('askCopilot intent_override 生效', result.intent, 'generate_draft');
}

async function testAskCopilotConversationIdContinue(): Promise<void> {
  const { ds } = makeFakeDataSource({
    remotePayload: { status: 'COMPLETED', data: { reply: '回复' } },
  });
  const svc = new StrategyCopilotService(ds);
  const result = await svc.askCopilot('问', {
    conversation_id: 'COP-existing-001',
  });

  assertEqual('askCopilot 续接 conversation_id', result.conversation_id, 'COP-existing-001');
}

async function testAskCopilotContextLoadFailure(): Promise<void> {
  const { ds } = makeFakeDataSource({
    strategies: { multi_factor: makeStrategy() },
    backtests: { multi_factor: [makeBacktest()] },
    loadStrategyShouldThrow: true,
    remotePayload: { status: 'COMPLETED', data: { reply: '回复' } },
  });
  const svc = new StrategyCopilotService(ds);
  // 应该不抛 (因 Promise.all 被外层 try/catch 接住)
  const result = await svc.askCopilot('解释', { strategy_key: 'multi_factor' });

  // 即使 load 失败, 仍能返回结果（context 退化为 null + []）
  assertEqual('askCopilot context load fail 仍能 complete', result.status, 'completed');
  // prompt 不应含 Strategy:（因 strategy=null）
  // 但 service 已调远端, 我们查 metadata 而非 prompt
  assertEqual('askCopilot context load fail strategy_key 仍传入', result.strategy_key, 'multi_factor');
}

// ---------------------------------------------------------------------------
// service.loadContext()
// ---------------------------------------------------------------------------

async function testLoadContext(): Promise<void> {
  const { ds, calls } = makeFakeDataSource({
    strategies: { multi_factor: makeStrategy() },
    backtests: { multi_factor: [makeBacktest(), makeBacktest({ task_id: 124 })] },
  });
  const svc = new StrategyCopilotService(ds);
  const ctx = await svc.loadContext('multi_factor');

  assert('loadContext 含 strategy', ctx.strategy?.strategy_key === 'multi_factor');
  assertEqual('loadContext 含 2 个 backtests', ctx.backtests.length, 2);
  assertEqual('loadContext default lookback=5', calls.loadRecentBacktests[0].limit, 5);

  // 自定义 lookback
  const ctx2 = await svc.loadContext('multi_factor', 10);
  assertEqual('loadContext custom lookback=10', calls.loadRecentBacktests[1].limit, 10);

  // 空 strategy_key
  const ctx3 = await svc.loadContext(null);
  assertEqual('loadContext null strategy_key → 空 backtests', ctx3.backtests, []);
  assertEqual('loadContext null strategy_key → null strategy', ctx3.strategy, null);
  // 不应调 DataSource
  assertEqual('loadContext null 不调 loadStrategy 第 3 次', calls.loadStrategy.length, 2);
}

// ---------------------------------------------------------------------------
// CO-002 / US-033 EntityExtractor pure functions
// ---------------------------------------------------------------------------

async function testInferStockMarket(): Promise<void> {
  // sh
  assertEqual('inferStockMarket 600519 → sh', inferStockMarket('600519'), 'sh');
  assertEqual('inferStockMarket 601318 → sh', inferStockMarket('601318'), 'sh');
  assertEqual('inferStockMarket 603259 → sh', inferStockMarket('603259'), 'sh');
  assertEqual('inferStockMarket 688981 → sh', inferStockMarket('688981'), 'sh');
  assertEqual('inferStockMarket 900901 → sh', inferStockMarket('900901'), 'sh');
  // sz
  assertEqual('inferStockMarket 000001 → sz', inferStockMarket('000001'), 'sz');
  assertEqual('inferStockMarket 002230 → sz', inferStockMarket('002230'), 'sz');
  assertEqual('inferStockMarket 300750 → sz', inferStockMarket('300750'), 'sz');
  assertEqual('inferStockMarket 200001 → sz', inferStockMarket('200001'), 'sz');
  // bj
  assertEqual('inferStockMarket 430139 → bj', inferStockMarket('430139'), 'bj');
  assertEqual('inferStockMarket 830799 → bj', inferStockMarket('830799'), 'bj');
  assertEqual('inferStockMarket 832145 → bj', inferStockMarket('832145'), 'bj');
  // 容错
  assertEqual('inferStockMarket 短串 → sh 兜底', inferStockMarket('12345'), 'sh');
  assertEqual('inferStockMarket 非字符串 → sh 兜底', inferStockMarket(undefined as any), 'sh');
  assertEqual('inferStockMarket 7 位 → sh 兜底', inferStockMarket('1234567'), 'sh');
}

async function testExtractStocks(): Promise<void> {
  // null / 非字符串 / 空 → []
  assertEqual('extractStocks null → []', extractStocks(null), []);
  assertEqual('extractStocks undefined → []', extractStocks(undefined), []);
  assertEqual('extractStocks 非字符串 → []', extractStocks(123 as any), []);
  assertEqual('extractStocks 空字符串 → []', extractStocks(''), []);
  assertEqual('extractStocks 全空格 → []', extractStocks('   '), []);

  // 单个
  assertEqual('extractStocks 单 600519', extractStocks('看看 600519 怎么样'), [
    { code: '600519', market: 'sh', raw: '600519' },
  ]);

  // 多个 + 顺序
  assertEqual(
    'extractStocks 多个 顺序保留',
    extractStocks('对比 002230 和 600519 的差距'),
    [
      { code: '002230', market: 'sz', raw: '002230' },
      { code: '600519', market: 'sh', raw: '600519' },
    ]
  );

  // 去重
  assertEqual(
    'extractStocks 重复去重',
    extractStocks('600519 涨了 5%, 600519 创新高'),
    [{ code: '600519', market: 'sh', raw: '600519' }]
  );

  // 7 位数字不抽
  assertEqual('extractStocks 7 位不抽', extractStocks('订单号 1234567'), []);

  // 5 位数字不抽
  assertEqual('extractStocks 5 位不抽', extractStocks('编号 12345'), []);

  // 边界: 6 位前后有非数字才抽
  assertEqual(
    'extractStocks 多位数字串中切',
    extractStocks('123456 和 78901234'),
    [{ code: '123456', market: 'sh', raw: '123456' }] // 78901234 是 8 位, 不抽
  );

  // 北交所
  assertEqual('extractStocks 430139 bj', extractStocks('北交所 430139'), [
    { code: '430139', market: 'bj', raw: '430139' },
  ]);
}

async function testExtractIndustries(): Promise<void> {
  assertEqual('extractIndustries null → []', extractIndustries(null), []);
  assertEqual('extractIndustries 无命中 → []', extractIndustries('今天天气真好'), []);

  // 单命中
  assertEqual('extractIndustries 单 光伏', extractIndustries('光伏板块涨停'), ['光伏']);

  // 大小写不敏感
  assertEqual('extractIndustries AI 大写', extractIndustries('AI 是风口'), ['AI']);
  assertEqual('extractIndustries ai 小写', extractIndustries('ai 是风口'), ['AI']);

  // 多个 + 顺序
  assertEqual(
    'extractIndustries 顺序按命中位置',
    extractIndustries('新能源里我看好光伏和锂电'),
    ['新能源', '光伏', '锂电']
  );

  // 去重 (同一行业关键词反复出现)
  assertEqual(
    'extractIndustries 去重',
    extractIndustries('光伏强势, 光伏再上涨, 光伏 ETF'),
    ['光伏']
  );

  // INDUSTRY_KEYWORDS 不能 push
  assert(
    'INDUSTRY_KEYWORDS 已 frozen (Object.freeze)',
    Object.isFrozen(INDUSTRY_KEYWORDS),
    `isFrozen=${Object.isFrozen(INDUSTRY_KEYWORDS)}`
  );
}

async function testExtractIndicators(): Promise<void> {
  assertEqual('extractIndicators null → []', extractIndicators(null), []);
  assertEqual('extractIndicators 无命中 → []', extractIndicators('随便聊聊'), []);

  // 单命中
  assertEqual('extractIndicators RSI', extractIndicators('RSI 超卖'), ['rsi']);

  // 别名归一: 夏普 / sharpe 都 → sharpe; 同 canonical 只取一次
  assertEqual(
    'extractIndicators 夏普 → sharpe canonical',
    extractIndicators('夏普值不错'),
    ['sharpe']
  );
  assertEqual(
    'extractIndicators sharpe + 夏普 同 canonical 一次',
    extractIndicators('sharpe 高夏普也高'),
    ['sharpe']
  );

  // 多个 canonical 按首次命中顺序
  assertEqual(
    'extractIndicators 多个排序',
    extractIndicators('MACD 金叉, RSI 超卖, sharpe 也好'),
    ['macd', 'rsi', 'sharpe']
  );

  // 最大回撤 → max_drawdown
  assertEqual(
    'extractIndicators 最大回撤 → max_drawdown',
    extractIndicators('最大回撤太大'),
    ['max_drawdown']
  );

  // 胜率 → win_rate
  assertEqual('extractIndicators 胜率', extractIndicators('胜率 60%'), ['win_rate']);

  // INDICATOR_ALIASES frozen
  assert(
    'INDICATOR_ALIASES 已 frozen',
    Object.isFrozen(INDICATOR_ALIASES),
    `isFrozen=${Object.isFrozen(INDICATOR_ALIASES)}`
  );
}

async function testExtractNumbers(): Promise<void> {
  assertEqual('extractNumbers null → []', extractNumbers(null), []);
  assertEqual('extractNumbers 空 → []', extractNumbers(''), []);
  assertEqual('extractNumbers 无数字 → []', extractNumbers('我爱学习'), []);

  // 纯数字 (无单位)
  assertEqual('extractNumbers 纯整数', extractNumbers('数量 30'), [
    { value: 30, unit: null, raw: '30' },
  ]);

  // 小数
  assertEqual('extractNumbers 小数', extractNumbers('sharpe 是 1.45'), [
    { value: 1.45, unit: null, raw: '1.45' },
  ]);

  // 百分比
  assertEqual('extractNumbers 5% pct', extractNumbers('涨了 5%'), [
    { value: 5, unit: 'pct', raw: '5%' },
  ]);

  // 单位归一
  assertEqual('extractNumbers 100 万', extractNumbers('100万股'), [
    { value: 100, unit: 'wan', raw: '100万' },
  ]);
  assertEqual('extractNumbers 3 亿', extractNumbers('成交额 3 亿').filter(n => n.unit === 'yi'), [
    { value: 3, unit: 'yi', raw: '3亿' },
  ]);
  assertEqual('extractNumbers 50 元', extractNumbers('股价 50元'), [
    { value: 50, unit: 'yuan', raw: '50元' },
  ]);
  assertEqual('extractNumbers 2 倍', extractNumbers('涨 2倍'), [
    { value: 2, unit: 'x', raw: '2倍' },
  ]);
  assertEqual('extractNumbers 7 天', extractNumbers('持仓 7 天').filter(n => n.unit === 'day'), [
    { value: 7, unit: 'day', raw: '7天' },
  ]);
  assertEqual(
    'extractNumbers 3 个月',
    extractNumbers('未来 3 个月').filter(n => n.unit === 'month'),
    [{ value: 3, unit: 'month', raw: '3个月' }]
  );

  // 多数字按位置
  const multi = extractNumbers('topN=30 lookback=20');
  assert('extractNumbers 多个长度 2', multi.length === 2, `len=${multi.length}`);
  assertEqual('extractNumbers 第一个 value', multi[0].value, 30);
  assertEqual('extractNumbers 第二个 value', multi[1].value, 20);

  // 负数
  const neg = extractNumbers('回撤 -8.2%');
  assertEqual('extractNumbers 负数', neg, [{ value: -8.2, unit: 'pct', raw: '-8.2%' }]);
}

async function testExtractDates(): Promise<void> {
  assertEqual('extractDates null → []', extractDates(null), []);
  assertEqual('extractDates 无日期 → []', extractDates('随便聊'), []);

  // 绝对 YYYY-MM-DD
  const a1 = extractDates('从 2026-06-19 开始');
  assert('extractDates abs 1 个', a1.length === 1);
  assertEqual('extractDates abs iso', a1[0].iso, '2026-06-19');
  assertEqual('extractDates abs kind', a1[0].kind, 'absolute');
  assertEqual('extractDates abs offset null', a1[0].offset_days, null);

  // 绝对 YYYY/MM/DD
  const a2 = extractDates('2026/6/19');
  assertEqual('extractDates 斜杠 iso', a2[0].iso, '2026-06-19');

  // 绝对 YYYY年M月D日
  const a3 = extractDates('2026年6月19日');
  assertEqual('extractDates 中文年月日 iso', a3[0].iso, '2026-06-19');

  // M月D日 (无年, iso null)
  const a4 = extractDates('6月19日的会议');
  assertEqual('extractDates 无年 kind', a4[0].kind, 'absolute');
  assertEqual('extractDates 无年 iso=null', a4[0].iso, null);
  assertEqual('extractDates 无年 raw', a4[0].raw, '6月19日');

  // 相对词
  const r1 = extractDates('今天大涨');
  assertEqual('extractDates 今天 kind', r1[0].kind, 'relative');
  assertEqual('extractDates 今天 offset 0', r1[0].offset_days, 0);

  const r2 = extractDates('昨天');
  assertEqual('extractDates 昨天 -1', r2[0].offset_days, -1);

  const r3 = extractDates('前天');
  assertEqual('extractDates 前天 -2', r3[0].offset_days, -2);

  const r4 = extractDates('明天和后天');
  assertEqual('extractDates 明天 +1', r4[0].offset_days, 1);
  assertEqual('extractDates 后天 +2', r4[1].offset_days, 2);

  // 最近 N 天
  const r5 = extractDates('最近 30 天');
  assertEqual('extractDates 最近30天 offset', r5[0].offset_days, -30);
  assertEqual('extractDates 最近30天 raw', r5[0].raw, '最近 30 天');

  // 最近 N 个月 → -N*30
  const r6 = extractDates('最近 3 个月');
  assertEqual('extractDates 最近3个月 offset -90', r6[0].offset_days, -90);

  // 混合: 绝对 + 相对 + 排序
  const mix = extractDates('从 2026-06-01 到今天, 最近 7 天');
  assertEqual('extractDates 混合 len 3', mix.length, 3);
  assertEqual('extractDates 混合 第 1 绝对', mix[0].kind, 'absolute');
  assertEqual('extractDates 混合 第 2 相对', mix[1].kind, 'relative');
  assertEqual('extractDates 混合 第 3 相对', mix[2].kind, 'relative');
}

async function testExtractStrategyParams(): Promise<void> {
  assertEqual('extractStrategyParams null → {}', extractStrategyParams(null), {});
  assertEqual('extractStrategyParams 空 → {}', extractStrategyParams(''), {});
  assertEqual('extractStrategyParams 无 kv → {}', extractStrategyParams('随便聊'), {});

  // 单 key=value
  assertEqual('extractStrategyParams topN=30', extractStrategyParams('topN=30'), { topN: 30 });

  // 多个 key=value
  assertEqual(
    'extractStrategyParams 多个 kv',
    extractStrategyParams('调整 topN=30 lookback=20'),
    { topN: 30, lookback: 20 }
  );

  // key:value 也支持
  assertEqual('extractStrategyParams key:value 形态', extractStrategyParams('topN:30'), {
    topN: 30,
  });

  // 浮点
  assertEqual('extractStrategyParams 浮点', extractStrategyParams('threshold=0.5'), {
    threshold: 0.5,
  });

  // 负数
  assertEqual('extractStrategyParams 负数', extractStrategyParams('shift=-1'), { shift: -1 });

  // 字符串 value
  assertEqual('extractStrategyParams 字符串 value', extractStrategyParams('mode=hard'), {
    mode: 'hard',
  });

  // 同 key 后覆盖
  assertEqual(
    'extractStrategyParams 同 key 后覆盖',
    extractStrategyParams('topN=10 topN=30'),
    { topN: 30 }
  );

  // 纯数字开头的"key"不抽 (避免抽 "30=value")
  assertEqual(
    'extractStrategyParams 纯数字 key 不抽',
    extractStrategyParams('30=abc'),
    {}
  );

  // 大小写敏感
  const cs = extractStrategyParams('topN=10 TopN=20');
  assertEqual('extractStrategyParams 大小写敏感 topN', cs.topN, 10);
  assertEqual('extractStrategyParams 大小写敏感 TopN', cs.TopN, 20);
}

async function testExtractEntities(): Promise<void> {
  // 综合: 一句话同时含 6 类
  const result = extractEntities(
    '跑 multi_factor 策略 topN=30 lookback=20, 看看 600519 在光伏板块的 RSI 表现, 最近 30 天 sharpe 是否 > 1.5'
  );
  assert(
    'extractEntities 综合 stocks 含 600519',
    result.stocks.some(s => s.code === '600519')
  );
  assert(
    'extractEntities 综合 industries 含 光伏',
    result.industries.includes('光伏')
  );
  assert(
    'extractEntities 综合 indicators 含 rsi + sharpe',
    result.indicators.includes('rsi') && result.indicators.includes('sharpe')
  );
  assert(
    'extractEntities 综合 numbers 非空',
    result.numbers.length > 0
  );
  assert(
    'extractEntities 综合 dates 含 relative',
    result.dates.some(d => d.kind === 'relative' && d.offset_days === -30)
  );
  assertEqual(
    'extractEntities 综合 strategy_params',
    result.strategy_params,
    { topN: 30, lookback: 20 }
  );

  // 空输入 → 6 空切片
  const empty = extractEntities('');
  assertEqual('extractEntities 空 stocks', empty.stocks, []);
  assertEqual('extractEntities 空 industries', empty.industries, []);
  assertEqual('extractEntities 空 indicators', empty.indicators, []);
  assertEqual('extractEntities 空 numbers', empty.numbers, []);
  assertEqual('extractEntities 空 dates', empty.dates, []);
  assertEqual('extractEntities 空 strategy_params', empty.strategy_params, {});

  // null 输入 → 6 空切片
  const nullRes = extractEntities(null);
  assertEqual('extractEntities null shape', Object.keys(nullRes).sort(), [
    'dates',
    'indicators',
    'industries',
    'numbers',
    'stocks',
    'strategy_params',
  ]);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await testConstantsFrozen();
  await testNullableNumber();
  await testNormalizeBacktestLookback();
  await testNormalizeIntent();
  await testNormalizeIntentTaskStyle();
  await testFormatBacktestSummary();
  await testSafeJsonStringify();
  await testParseStrategyDraft();
  await testBuildPromptContext();
  await testBuildPromptText();
  await testBuildHeuristicFallback();
  await testBuildResponseFromPayload();
  await testExtractKeyDelta();
  await testBuildConversationId();
  await testAskCopilotSuccess();
  await testAskCopilotRemoteFailed();
  await testAskCopilotRemoteThrows();
  await testAskCopilotDryRun();
  await testAskCopilotSaveFailOpen();
  await testAskCopilotNoStrategy();
  await testAskCopilotIntentOverride();
  await testAskCopilotConversationIdContinue();
  await testAskCopilotContextLoadFailure();
  await testLoadContext();

  console.log(`\n────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log(`────────────────────────────────────`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
