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
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await testConstantsFrozen();
  await testNullableNumber();
  await testNormalizeBacktestLookback();
  await testNormalizeIntent();
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
