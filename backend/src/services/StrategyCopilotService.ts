import axios from 'axios';
import { Op } from 'sequelize';
import { logger } from '../utils/logger';
import { QuantStrategyModel } from '../models/QuantStrategyModel';
import { QuantBacktestTask } from '../models/QuantBacktestTask';
import { QuantBacktestResult } from '../models/QuantBacktestResult';

/**
 * StrategyCopilotService — US-062 AI 人机协同（策略实验室 Copilot）。
 *
 * 在 `/workspace/lab` 右下角浮出聊天面板，用户可问：
 *   - **解释**：上一次回测 sharpe 这么低是为什么？
 *   - **调参**：把 multi_factor 的 topN 改成 30，预期会怎样？
 *   - **生成**：帮我写一个"周线 RSI 超卖反弹"的策略草案。
 *
 * 后端把 `(strategy_key, params, last 5 backtest summaries, history)` 拼成 prompt
 * 喂给 TradingAgents `/api/strategy-copilot`，远端返回结构化 reply。失败时降级
 * 启发式 fallback：基于参数 + 最近一次回测的 sharpe / max_dd / 胜率自动给改进建议。
 *
 * **6 项 AI feature checklist** (US-055 范式同款，第 7 个 AI service)：
 *   1. **DataSource DI** — `StrategyCopilotDataSource` 接口：5 方法
 *      (loadStrategy / loadRecentBacktests / callRemoteCopilot /
 *      saveConversation / streamRemoteCopilot)；`Default<X>DataSource` 走
 *      Sequelize + TradingAgents axios；生产 `PRODUCTION_STRATEGY_COPILOT_DATA_SOURCE`
 *      singleton；单测注入 fake 完全脱 DB / 网络。
 *   2. **pure helpers 全 export** — normalizeIntent / buildPromptContext /
 *      buildPromptText / parseStrategyDraft / buildResponseFromPayload /
 *      buildHeuristicFallback / formatBacktestSummary / extractKeyDelta /
 *      buildConversationId + (CO-002 / US-033) extractStocks / extractIndustries /
 *      extractIndicators / extractNumbers / extractDates / extractStrategyParams /
 *      extractEntities (聚合入口).
 *   3. **plain-object 返回类型** `CopilotResponse` 兼容 sync / dry_run / failed /
 *      heuristic_fallback / pending 5 种路径，让单测无须 boot Sequelize 即可断言。
 *   4. **status='failed' / 'partial' 仍正常返回** + 标记 `nlp_engine='heuristic_fallback'`
 *      让 UI 知道 "AI 远端失败但有兜底答案" 而非"卡住"。
 *   5. **fail-OPEN on saveConversation** — DB 写失败 warn + log 不阻塞 UI 拿到 reply。
 *   6. **双重防御 try/catch** — DataSource 内 callRemoteCopilot 失败转 FAILED payload；
 *      service.askCopilot 仍外层 try/catch 处理 unexpected throw（如 fake source 直接 throw）。
 *
 * **意图分类**（4 种）:
 *   - `explain_backtest`：解释最近一次或指定回测的指标 (sharpe / max_dd / 胜率)；
 *   - `suggest_params`：建议参数改动（基于当前 default_params + 最近 sharpe）；
 *   - `generate_draft`：生成新策略 TypeScript 代码草案（`parseStrategyDraft` 抓 \`\`\`ts 块）；
 *   - `general`：自由问答兜底（其他无法分类的问句）。
 *
 * **prompt 模板结构**（顺序固定，方便后续 prompt tuning 对比）:
 *   ```
 *   System: 你是一名 A 股量化策略顾问 ...
 *   Strategy: <strategy_key> (<name>, <category>, risk=<risk_level>)
 *   Default params: <JSON>
 *   Recent backtests (last 5):
 *     1. [2026-06-08 #123] return=12.3% sharpe=1.45 max_dd=-8.2% win=58%
 *     2. ...
 *   User question: <prompt>
 *   ```
 *   `buildPromptContext` 是 pure，单测可断言 prompt 拼接所有字段都到位。
 *
 * **24h 缓存暂不引入**：与 US-061 K 线解读（同 stock 24h 内重复请求很常见）不同，
 * Copilot 对话每条问句都是独立上下文，缓存反而误导用户；故不复用 US-061 TTL 模式。
 */

// audit L-19: 集中常量, 不再硬编码 IP.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TRADING_AGENTS_BASE_URL } = require('../config/externalServices');
const TRADING_AGENTS_URL = TRADING_AGENTS_BASE_URL;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * Copilot 意图常量。
 *
 * - v1 (US-062, dialog-style 4 个)：EXPLAIN_BACKTEST / SUGGEST_PARAMS / GENERATE_DRAFT / GENERAL，
 *   "问 → 答" 自由文本回复。
 * - v2 (US-032 / CO-001, task-style 7 个)：QUERY_STOCKS / RUN_BACKTEST / QUERY_POSITIONS /
 *   EXPLAIN_PICK / WHAT_IF / SET_ALERT / GET_DIAGNOSIS，"问 → 执行 → 拿结果" 路由到 service。
 *
 * 合计 11 个 intent。`TASK_INTENTS` 集合给 router 一眼判断是否走执行式分支
 * （CO-006 TaskRouter 落地时直接判一句 `TASK_INTENTS.includes(intent)`）；不在此 set 内的
 * 即为 v1 对话式 intent，仍走原 LLM reply 流程，保持 backward-compat。
 */
export const COPILOT_INTENTS = Object.freeze({
  // v1 dialog-style (US-062)
  EXPLAIN_BACKTEST: 'explain_backtest' as const,
  SUGGEST_PARAMS: 'suggest_params' as const,
  GENERATE_DRAFT: 'generate_draft' as const,
  GENERAL: 'general' as const,
  // v2 task-style (US-032 / CO-001) — 执行式; 由 TaskRouter (CO-006) 路由到对应 service
  QUERY_STOCKS: 'query_stocks' as const,
  RUN_BACKTEST: 'run_backtest' as const,
  QUERY_POSITIONS: 'query_positions' as const,
  EXPLAIN_PICK: 'explain_pick' as const,
  WHAT_IF: 'what_if' as const,
  SET_ALERT: 'set_alert' as const,
  GET_DIAGNOSIS: 'get_diagnosis' as const,
});

export type CopilotIntent =
  | typeof COPILOT_INTENTS.EXPLAIN_BACKTEST
  | typeof COPILOT_INTENTS.SUGGEST_PARAMS
  | typeof COPILOT_INTENTS.GENERATE_DRAFT
  | typeof COPILOT_INTENTS.GENERAL
  | typeof COPILOT_INTENTS.QUERY_STOCKS
  | typeof COPILOT_INTENTS.RUN_BACKTEST
  | typeof COPILOT_INTENTS.QUERY_POSITIONS
  | typeof COPILOT_INTENTS.EXPLAIN_PICK
  | typeof COPILOT_INTENTS.WHAT_IF
  | typeof COPILOT_INTENTS.SET_ALERT
  | typeof COPILOT_INTENTS.GET_DIAGNOSIS;

/**
 * v2 执行式 task intent 集合 — CO-006 TaskRouter 用 `TASK_INTENTS.has(intent)`
 * 判断是否要走 service 执行分支；不在内即为 v1 对话式（依旧丢给 LLM）。
 *
 * 用 Set 而非 array — O(1) lookup + 不变性更强（Set 没有 push API）；
 * 配合 Object.freeze(COPILOT_INTENTS) 防外部篡改 intent 字面量。
 */
export const TASK_INTENTS: ReadonlySet<CopilotIntent> = Object.freeze(
  new Set<CopilotIntent>([
    COPILOT_INTENTS.QUERY_STOCKS,
    COPILOT_INTENTS.RUN_BACKTEST,
    COPILOT_INTENTS.QUERY_POSITIONS,
    COPILOT_INTENTS.EXPLAIN_PICK,
    COPILOT_INTENTS.WHAT_IF,
    COPILOT_INTENTS.SET_ALERT,
    COPILOT_INTENTS.GET_DIAGNOSIS,
  ])
);

/**
 * 所有合法 intent 字面量集合 — `normalizeIntent` 校验 override / 远端返回的 intent
 * 用此一个白名单即可，不必硬编码 11 个 `||` 短路串（避免新增 intent 时漏改）。
 */
export const ALL_COPILOT_INTENTS: ReadonlySet<CopilotIntent> = Object.freeze(
  new Set<CopilotIntent>(Object.values(COPILOT_INTENTS) as CopilotIntent[])
);

/**
 * 判断一个 intent 是否为 v2 执行式 task intent.
 * （pure helper, 供 TaskRouter / 前端 / 单测共用）
 */
export function isTaskIntent(intent: any): intent is CopilotIntent {
  return typeof intent === 'string' && (TASK_INTENTS as Set<string>).has(intent);
}

/** NLP 引擎标签 (与 US-061 同款) */
export const NLP_ENGINES = Object.freeze({
  TRADING_AGENTS: 'trading_agents' as const,
  HEURISTIC: 'heuristic_fallback' as const,
});

/** 最多回看的回测数（AC 要求 "最近 5 次"） */
export const DEFAULT_BACKTEST_LOOKBACK = 5;
export const MAX_BACKTEST_LOOKBACK = 20;

/** 远端 axios timeout (Copilot 对话较 K 线解读略快) */
export const REMOTE_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单次回测摘要 (用于 prompt 拼接 + heuristic fallback) */
export interface BacktestSummary {
  task_id: number;
  task_name: string;
  status: string;
  start_date: string;
  end_date: string;
  created_at: string;
  total_return_pct: number | null;
  sharpe_ratio: number | null;
  max_drawdown_pct: number | null;
  win_rate: number | null;
  trade_count: number | null;
}

/** 策略元信息 (default_params 喂 prompt; loadStrategy 输出) */
export interface StrategyMeta {
  strategy_key: string;
  name: string;
  description: string | null;
  category: string | null;
  risk_level: string | null;
  tags: string[];
  default_params: Record<string, any>;
}

/** 远端 TradingAgents /api/strategy-copilot 的 payload */
export interface RemoteCopilotPayload {
  status?: string;
  task_id?: string;
  data?: {
    reply?: string;
    /** 远端识别的意图（若返回则覆盖本地 normalizeIntent） */
    intent?: string;
    /** 远端建议的下一步动作（"apply_params" / "run_backtest" 等） */
    next_action?: string;
    /** 建议的参数 diff（部分覆盖 default_params） */
    suggested_params?: Record<string, any>;
    /** 若 intent=generate_draft，远端把 TS 代码片段写到这里 */
    strategy_draft?: string;
    /** 失败时由 service 自身写入的错误描述（不是 TradingAgents 字段） */
    error?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** plain-object 返回类型 (与 US-055 / US-061 同款) */
export interface CopilotResponse {
  conversation_id: string;
  strategy_key: string | null;
  intent: CopilotIntent;
  prompt: string;
  reply: string;
  /** 建议的参数改动（intent='suggest_params' 时填; 其他场景为空对象） */
  suggested_params: Record<string, any>;
  /** intent='generate_draft' 时填; 其他场景为 null */
  strategy_draft: string | null;
  /** 远端识别的 next_action（如有），让 UI 渲染对应按钮 */
  next_action: string | null;
  status: 'completed' | 'partial' | 'failed';
  nlp_engine: string;
  error: string | null;
  generated_at: string;
  metadata: Record<string, unknown>;
  persisted: boolean;
}

export interface AskCopilotOptions {
  /** 用户当前选中的策略 key (前端 LabWorkspace 已知) */
  strategy_key?: string;
  /** 强制覆盖意图 (UI 主动选 "解释回测" / "生成草案" 时传) */
  intent_override?: CopilotIntent;
  /** dry_run=true 不写表 (前端预览用) */
  dry_run?: boolean;
  /** 触发用户 ID (cron / system 触发可省略) */
  user_id?: number;
  /** 任务来源标签 (写入 metadata.task_label, ops 区分入口) */
  task_label?: string;
  /** 显式指定生成时间 (单测稳定化用) */
  now?: Date;
  /** 显式指定 conversation_id (前端续接同一对话上下文) */
  conversation_id?: string;
}

// ---------------------------------------------------------------------------
// DataSource 注入接口
// ---------------------------------------------------------------------------

export interface StrategyCopilotDataSource {
  /** 加载策略元信息 (含 default_params) — null 表示策略不存在 */
  loadStrategy(strategyKey: string): Promise<StrategyMeta | null>;
  /** 加载某策略最近 N 次回测摘要 (按 created_at DESC) */
  loadRecentBacktests(strategyKey: string, limit: number): Promise<BacktestSummary[]>;
  /** 远端 TradingAgents 调用; 失败时返回 status=FAILED 不抛 */
  callRemoteCopilot(
    promptText: string,
    intent: CopilotIntent,
    metadata: Record<string, unknown>
  ): Promise<RemoteCopilotPayload>;
  /** 持久化对话 (dry_run / persist=false 时跳过); 失败 throw 让 service fail-OPEN */
  saveConversation(record: CopilotResponse): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default production DataSource
// ---------------------------------------------------------------------------

export class DefaultStrategyCopilotDataSource implements StrategyCopilotDataSource {
  async loadStrategy(strategyKey: string): Promise<StrategyMeta | null> {
    try {
      const row = await QuantStrategyModel.findOne({ where: { strategy_key: strategyKey } });
      if (!row) return null;
      return {
        strategy_key: row.strategy_key,
        name: row.name,
        description: row.description || null,
        category: row.category || null,
        risk_level: row.risk_level || null,
        tags: Array.isArray(row.tags) ? row.tags : [],
        default_params:
          row.default_params && typeof row.default_params === 'object' ? row.default_params : {},
      };
    } catch (err: any) {
      logger.warn(`StrategyCopilot.loadStrategy(${strategyKey}) failed: ${err.message}`);
      return null;
    }
  }

  async loadRecentBacktests(strategyKey: string, limit: number): Promise<BacktestSummary[]> {
    try {
      // 1) 先按 strategy_key 在 results 表里聚合 task_id（用 metrics 联表）
      const recentResults = await QuantBacktestResult.findAll({
        where: { strategy_key: strategyKey },
        order: [['created_at', 'DESC']],
        limit: Math.min(limit, MAX_BACKTEST_LOOKBACK),
      });
      const taskIds = Array.from(new Set(recentResults.map(r => r.task_id)));
      if (taskIds.length === 0) return [];
      const tasks = await QuantBacktestTask.findAll({
        where: { id: { [Op.in]: taskIds } },
      });
      const taskById = new Map<number, QuantBacktestTask>();
      for (const t of tasks) taskById.set(t.id, t);

      const out: BacktestSummary[] = [];
      for (const r of recentResults) {
        const task = taskById.get(r.task_id);
        if (!task) continue;
        out.push({
          task_id: r.task_id,
          task_name: task.task_name,
          status: task.status,
          start_date: task.start_date,
          end_date: task.end_date,
          created_at: (r.created_at || task.created_at).toISOString(),
          total_return_pct: nullableNumber(r.total_return_pct),
          sharpe_ratio: nullableNumber(r.sharpe_ratio),
          max_drawdown_pct: nullableNumber(r.max_drawdown_pct),
          win_rate: nullableNumber(r.win_rate),
          trade_count: Number.isFinite(Number(r.trade_count)) ? Number(r.trade_count) : null,
        });
      }
      return out;
    } catch (err: any) {
      logger.warn(`StrategyCopilot.loadRecentBacktests(${strategyKey}) failed: ${err.message}`);
      return [];
    }
  }

  async callRemoteCopilot(
    promptText: string,
    intent: CopilotIntent,
    metadata: Record<string, unknown>
  ): Promise<RemoteCopilotPayload> {
    try {
      const response = await axios.post(
        `${TRADING_AGENTS_URL}/api/strategy-copilot`,
        {
          prompt: promptText,
          intent,
          metadata,
        },
        { timeout: REMOTE_TIMEOUT_MS }
      );
      return response.data;
    } catch (error: any) {
      const message = error?.response?.data?.detail || error?.message || String(error);
      logger.warn(`StrategyCopilot.callRemoteCopilot failed: ${message}`);
      return { status: 'FAILED', data: { error: message } };
    }
  }

  async saveConversation(_record: CopilotResponse): Promise<void> {
    // Copilot 对话本身不强制落库（用户每次问话独立上下文，缓存反而误导）。
    // 暂走 noop；若未来引入会话历史表，在 DefaultStrategyCopilotDataSource 改为 INSERT 即可，
    // service 调用方与单测 fake 都不需要改。
    return;
  }
}

export const PRODUCTION_STRATEGY_COPILOT_DATA_SOURCE: StrategyCopilotDataSource =
  new DefaultStrategyCopilotDataSource();

// ---------------------------------------------------------------------------
// Pure helpers (export for unit tests — no DB / no axios)
// ---------------------------------------------------------------------------

/**
 * 从 raw value 安全转 number; null/NaN/无穷/空字符串 → null。
 * (Sequelize DECIMAL 列被 string 反序列化时常见的陷阱，US-031 Number(null)===0 教训。)
 * 空字符串显式排除，避免 `Number('') === 0` 把"未填"算成"0 收益"。
 */
export function nullableNumber(raw: any): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * 净化 lookback 入参；< 1 → DEFAULT_BACKTEST_LOOKBACK；> MAX → MAX_BACKTEST_LOOKBACK。
 * 与 normalizeXxxConfig (US-047..US-061) 同款"沉默退回默认不 4xx"。
 */
export function normalizeBacktestLookback(raw: any): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BACKTEST_LOOKBACK;
  const floored = Math.floor(n);
  if (floored > MAX_BACKTEST_LOOKBACK) return MAX_BACKTEST_LOOKBACK;
  return floored;
}

/**
 * 基于用户问句的简单意图识别（关键词 + 正则）；远端 AI 返回的 intent 优先于本地。
 *
 * 11 个 intent (4 v1 dialog + 7 v2 task)；优先级从高到低（"更具体的 task 在前"）：
 *   1.  RUN_BACKTEST        — "跑 MFA 策略 topN=50" / "回测 multi_factor"
 *   2.  SET_ALERT           — "如果 002230 跌破 50 提醒我" / "提醒我"
 *   3.  WHAT_IF             — "如果我现在全清 ZX 行业 pnl 会变多少"
 *   4.  EXPLAIN_PICK        — "为什么 600519 今天被推荐"
 *   5.  QUERY_POSITIONS     — "我现在哪些持仓 ..."
 *   6.  GET_DIAGNOSIS       — "我最近 30 天为什么 underperform 基准"
 *   7.  QUERY_STOCKS        — "找今天北向加仓 + RSI 超卖" / "筛选 ..."
 *   8.  GENERATE_DRAFT      — "帮我写一个 RSI 策略"
 *   9.  SUGGEST_PARAMS      — "把 topN 改成 30 会更好吗"
 *  10.  EXPLAIN_BACKTEST    — "为什么 sharpe 这么低"
 *  11.  GENERAL             — 兜底
 *
 * 顺序非常关键 —— task 类强模式在前，避免 "跑 MFA 回测看 sharpe" 误判成 EXPLAIN_BACKTEST.
 * 与 US-055 normalizeRecommendation "强类 > 普通类" 原则一致。空 / 无关键词 → 'general'.
 *
 * @param rawPrompt 用户原始问句（任意类型；非字符串 / 空 / 全空格 → general）
 * @param override  前端 UI 主动选 intent 时传; 必须是 11 个白名单之一，否则忽略
 */
export function normalizeIntent(rawPrompt: any, override?: any): CopilotIntent {
  // 显式 override 优先（前端 UI 主动选意图时）— 用 ALL_COPILOT_INTENTS 白名单一键校验
  // (新增 intent 时无需改这里, 与 COPILOT_INTENTS 保持单一事实源)
  if (typeof override === 'string') {
    const lower = override.trim().toLowerCase() as CopilotIntent;
    if ((ALL_COPILOT_INTENTS as Set<string>).has(lower)) {
      return lower;
    }
  }
  if (typeof rawPrompt !== 'string') return COPILOT_INTENTS.GENERAL;
  const text = rawPrompt.trim();
  if (!text) return COPILOT_INTENTS.GENERAL;

  // ===== v2 task-style intents (CO-001 / US-032) — 强模式在前 =====

  // 1) RUN_BACKTEST — "跑 [策略] 回测" / "回测 [策略] topN=50" / "run backtest"
  //    含 "跑" / "run" 等执行动词 + "回测/backtest" 关键词
  if (
    /(跑\s*(?:一次|个)?\s*(?:回测|backtest)|跑\s+[\w_]+\s*(?:策略)?\s*回测|回测\s+[\w_]+|backtest\s+[\w_]+|run\s+(?:a\s+)?backtest|跑\s+[\w_]+\s*(?:策略)?\s*(?:topN|lookback)|跑\s+[A-Za-z_]+\s*策略)/i.test(
      text
    )
  ) {
    return COPILOT_INTENTS.RUN_BACKTEST;
  }

  // 2) SET_ALERT — "如果 ... 提醒我 / alert / 报警 / 告警"
  //    "提醒我" / "提示我" / "alert me" / "告警" / "报警" 强信号
  if (
    /(提醒我|提示我|alert\s+me|set\s+alert|设(?:置|定)?\s*提醒|设(?:置|定)?\s*(?:告警|报警)|告警条件|添加\s*提醒)/i.test(
      text
    )
  ) {
    return COPILOT_INTENTS.SET_ALERT;
  }

  // 3) WHAT_IF — "如果 ... 会怎样" / "假如 ..." / "what if"
  //    "假如" / "如果...会" / "what if" 假设性问句; 不能与 SET_ALERT 冲突（已先判）
  if (
    /(假如|假设|what\s+if|如果.*(?:会|变|影响|pnl|净值|回报|收益)|如果.*全清|如果.*清仓|如果.*加仓)/i.test(
      text
    )
  ) {
    return COPILOT_INTENTS.WHAT_IF;
  }

  // 4) EXPLAIN_PICK — "为什么 600519 被推荐" / "为啥推荐 002230" / "解释 600519 推荐理由"
  //    含股票代码 (6 位数字) + "推荐 / 选 / 入选 / pick" 关键词
  if (
    /(为(?:什么|啥)\s*\d{6}.*?(?:被?推荐|入选|选中)|解释.*\d{6}.*?(?:推荐|入选)|\d{6}.*?为(?:什么|啥).*?(?:推荐|入选|选中)|why\s+(?:was\s+)?\d{6}.*?(?:picked|recommended|selected))/i.test(
      text
    )
  ) {
    return COPILOT_INTENTS.EXPLAIN_PICK;
  }

  // 5) QUERY_POSITIONS — "我(现在)?(的)?(哪些)?持仓 ..." / "我的仓位 ..." / "我持有 ..."
  //    "我...持仓 / 持有 / 仓位" 第一人称 + 持仓主题
  if (
    /((?:我|本人).*(?:持仓|仓位|持有|hold)|哪些\s*持仓|查看?\s*(?:我的)?\s*持仓|当前\s*持仓.*(?:行业|集中度|涨跌|盈亏))/i.test(
      text
    )
  ) {
    return COPILOT_INTENTS.QUERY_POSITIONS;
  }

  // 6) GET_DIAGNOSIS — "最近 N 天 为什么 underperform" / "为什么跑输基准" / "诊断我的策略"
  if (
    /(为(?:什么|啥).*(?:跑输|underperform|落后于?|输给|不如|低于)|诊断.*策略|诊断.*组合|策略\s*诊断|组合\s*诊断|为什么\s*我.*?(?:亏|跑输|表现))/i.test(
      text
    )
  ) {
    return COPILOT_INTENTS.GET_DIAGNOSIS;
  }

  // 7) QUERY_STOCKS — "找 [条件] 的票" / "筛选 / 选股" / "list stocks with"
  //    含 "找 / 查 / 筛选 / 选股 / list" + "票 / 股 / 标的" 主题, 或多个指标条件叠加
  if (
    /(找\s*(?:今天|当前)?.*?(?:的)?\s*(?:票|股|标的)|筛选\s*(?:出)?.*?(?:股|票|标的)|选股\s*(?:条件)?|哪些\s*(?:股票|票|标的).*?(?:符合|满足|RSI|MACD|涨|跌|北向)|list\s+stocks?\s+(?:with|where|having))/i.test(
      text
    )
  ) {
    return COPILOT_INTENTS.QUERY_STOCKS;
  }

  // ===== v1 dialog-style intents (US-062) — 弱模式兜底 =====

  // 8) GENERATE_DRAFT — "帮我写一个策略 / 生成策略 / 策略草案 / generate strategy"
  if (
    /(写\s*(?:一个|[一二三]?)?\s*[^。\n]*?策略|写\s*(?:一个|[一二三]?)?\s*(?:代码|草案)|生成\s*(?:一个)?\s*策略|策略草案|generate\s+(?:a\s+|the\s+)?strategy|新策略\s*(?:代码|草案)?|新建策略.*?(?:代码|草案))/i.test(
      text
    )
  ) {
    return COPILOT_INTENTS.GENERATE_DRAFT;
  }

  // 9) SUGGEST_PARAMS — "调整参数 / 参数优化 / 改 topN / 建议调"
  if (
    /(参数.*(?:改|调|优化|建议)|调[整一下]*\s*(?:参数|策略)|topN|改成\s*\d|建议(?:把|改|调整))/i.test(
      text
    )
  ) {
    return COPILOT_INTENTS.SUGGEST_PARAMS;
  }

  // 10) EXPLAIN_BACKTEST — "回测 / sharpe / 夏普 / 最大回撤 / 胜率 / 表现"
  if (
    /(回测|sharpe|夏普|最大回撤|max[_\s]*drawdown|胜率|win[_\s]*rate|表现|为什么.*(?:亏|低|高)|解释.*指标|结果)/i.test(
      text
    )
  ) {
    return COPILOT_INTENTS.EXPLAIN_BACKTEST;
  }

  // 11) 兜底
  return COPILOT_INTENTS.GENERAL;
}

/**
 * 单条回测的人类可读摘要，例如：
 *   `1. [2026-06-08 #123] return=12.3% sharpe=1.45 max_dd=-8.2% win=58% trades=42 (COMPLETED)`
 * - 数值缺失时省略对应 token（不要写 "null"）；
 * - 全部数值 ToFixed(2) 防 prompt 长度爆炸。
 */
export function formatBacktestSummary(idx: number, b: BacktestSummary): string {
  const datePart =
    typeof b.created_at === 'string' && b.created_at ? b.created_at.slice(0, 10) : '(no date)';
  const tokens: string[] = [];
  if (b.total_return_pct !== null) tokens.push(`return=${b.total_return_pct.toFixed(2)}%`);
  if (b.sharpe_ratio !== null) tokens.push(`sharpe=${b.sharpe_ratio.toFixed(2)}`);
  if (b.max_drawdown_pct !== null) tokens.push(`max_dd=${b.max_drawdown_pct.toFixed(2)}%`);
  if (b.win_rate !== null) {
    // win_rate 可能是 0.58 (比例) 或 58 (百分比)；统一显示百分比
    const wr = b.win_rate <= 1 ? b.win_rate * 100 : b.win_rate;
    tokens.push(`win=${wr.toFixed(0)}%`);
  }
  if (b.trade_count !== null) tokens.push(`trades=${b.trade_count}`);
  const tail = tokens.length > 0 ? ' ' + tokens.join(' ') : '';
  const statusPart = b.status ? ` (${b.status})` : '';
  return `${idx + 1}. [${datePart} #${b.task_id}]${tail}${statusPart}`;
}

/**
 * Prompt context 中间结构 — 用于 buildPromptText + heuristic fallback 共享。
 */
export interface PromptContext {
  strategy: StrategyMeta | null;
  backtests: BacktestSummary[];
  user_prompt: string;
  intent: CopilotIntent;
}

/**
 * 把 (strategy_meta, backtests, user_prompt, intent) 拼成 PromptContext。
 * 上层 askCopilot 已经 load 完所有数据，这里只做 pure 组合，方便单测。
 */
export function buildPromptContext(input: {
  strategy: StrategyMeta | null;
  backtests: BacktestSummary[];
  user_prompt: string;
  intent: CopilotIntent;
}): PromptContext {
  return {
    strategy: input.strategy,
    backtests: input.backtests,
    user_prompt: typeof input.user_prompt === 'string' ? input.user_prompt.trim() : '',
    intent: input.intent,
  };
}

/**
 * 按 AC 要求的 prompt 模板（顺序固定）：
 *   System: 你是一名 A 股量化策略顾问 ...
 *   Strategy: <key> (<name>, <category>, risk=<risk>)
 *   Default params: <JSON>
 *   Recent backtests (last N):
 *     1. ...
 *   User intent: <intent>
 *   User question: <prompt>
 *
 * - strategy=null 时 omit Strategy + Default params 行；
 * - backtests=[] 时只写 "Recent backtests: (none)"；
 * - 最后一行 User question 必须存在（哪怕空字符串也写 "User question: "）。
 */
export function buildPromptText(ctx: PromptContext): string {
  const lines: string[] = [];
  lines.push(
    'System: 你是一名 A 股量化策略顾问，擅长用通俗中文解释回测指标、建议参数调整、提供策略草案代码。回答简洁、有数字、可操作。'
  );
  if (ctx.strategy) {
    const parts = [ctx.strategy.strategy_key];
    const meta: string[] = [];
    if (ctx.strategy.name) meta.push(ctx.strategy.name);
    if (ctx.strategy.category) meta.push(ctx.strategy.category);
    if (ctx.strategy.risk_level) meta.push(`risk=${ctx.strategy.risk_level}`);
    if (meta.length > 0) parts.push(`(${meta.join(', ')})`);
    lines.push(`Strategy: ${parts.join(' ')}`);
    if (ctx.strategy.description) {
      lines.push(`Description: ${ctx.strategy.description}`);
    }
    lines.push(`Default params: ${safeJsonStringify(ctx.strategy.default_params)}`);
  }
  if (ctx.backtests.length === 0) {
    lines.push('Recent backtests: (none)');
  } else {
    lines.push(`Recent backtests (last ${ctx.backtests.length}):`);
    for (let i = 0; i < ctx.backtests.length; i += 1) {
      lines.push('  ' + formatBacktestSummary(i, ctx.backtests[i]));
    }
  }
  lines.push(`User intent: ${ctx.intent}`);
  lines.push(`User question: ${ctx.user_prompt}`);
  return lines.join('\n');
}

/**
 * 安全 JSON.stringify — 循环引用 / undefined / function 都不抛错。
 */
export function safeJsonStringify(obj: any): string {
  try {
    return JSON.stringify(obj, (_k, v) => (v === undefined ? null : v));
  } catch {
    return '(unserializable)';
  }
}

/**
 * 从远端 reply 文本中抽 TS 代码块 (\`\`\`ts ... \`\`\` 或 \`\`\`typescript ... \`\`\`)。
 *
 * - 多个代码块 → 拼接 (\\n\\n 分隔)；
 * - 无代码块 → null；
 * - 大小写不敏感 (ts / TS / TypeScript)；
 * - 仅当 intent=generate_draft 时调用（其他 intent 用户没要代码）。
 */
export function parseStrategyDraft(replyText: string): string | null {
  if (typeof replyText !== 'string' || replyText.length === 0) return null;
  const fenceRegex = /```(?:ts|typescript)\s*\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(replyText)) !== null) {
    const code = match[1].trim();
    if (code.length > 0) blocks.push(code);
  }
  if (blocks.length === 0) return null;
  return blocks.join('\n\n');
}

/**
 * 启发式 fallback — 远端不可用时基于 strategy meta + 最近一次回测的指标
 * 给出可读建议（保证 UI 始终有内容显示）。
 *
 * 4 种 intent 分别有不同的兜底文案：
 *   - explain_backtest: 总结最近一次回测 sharpe / max_dd / win_rate 字面意义；
 *   - suggest_params: 基于 sharpe 给 "调小 topN / 拉长 lookback / 收紧止损" 提示；
 *   - generate_draft: 提示用户提供更多需求（草案需要远端 AI，本地兜底说明）；
 *   - general: 简短欢迎语 + 列出可用能力。
 */
export function buildHeuristicFallback(ctx: PromptContext): {
  reply: string;
  suggested_params: Record<string, any>;
  strategy_draft: string | null;
} {
  const stratName = ctx.strategy?.name || ctx.strategy?.strategy_key || '(未指定策略)';

  if (ctx.intent === COPILOT_INTENTS.EXPLAIN_BACKTEST) {
    if (ctx.backtests.length === 0) {
      return {
        reply: `${stratName} 目前还没有跑过回测，建议先到 "新建回测" tab 跑一次以便 Copilot 解读指标。`,
        suggested_params: {},
        strategy_draft: null,
      };
    }
    const latest = ctx.backtests[0];
    const tokens: string[] = [];
    if (latest.total_return_pct !== null) {
      tokens.push(`收益 ${latest.total_return_pct.toFixed(2)}%`);
    }
    if (latest.sharpe_ratio !== null) {
      const label =
        latest.sharpe_ratio >= 1.5
          ? '优秀'
          : latest.sharpe_ratio >= 1.0
          ? '尚可'
          : latest.sharpe_ratio >= 0.5
          ? '一般'
          : '偏弱';
      tokens.push(`sharpe ${latest.sharpe_ratio.toFixed(2)}（${label}）`);
    }
    if (latest.max_drawdown_pct !== null) {
      tokens.push(`最大回撤 ${latest.max_drawdown_pct.toFixed(2)}%`);
    }
    if (latest.win_rate !== null) {
      const wr = latest.win_rate <= 1 ? latest.win_rate * 100 : latest.win_rate;
      tokens.push(`胜率 ${wr.toFixed(0)}%`);
    }
    return {
      reply: `${stratName} 最近一次回测 (${latest.start_date}~${latest.end_date}): ${tokens.join(
        '，'
      )}。\n（AI 远端暂时不可达，已用启发式总结。）`,
      suggested_params: {},
      strategy_draft: null,
    };
  }

  if (ctx.intent === COPILOT_INTENTS.SUGGEST_PARAMS) {
    const latest = ctx.backtests[0];
    const suggestions: Record<string, any> = {};
    let advice = '';
    if (latest && latest.sharpe_ratio !== null && latest.sharpe_ratio < 1.0) {
      advice = `最近一次回测 sharpe=${latest.sharpe_ratio.toFixed(
        2
      )} 偏弱：建议先收紧选股范围（topN -20%）或拉长持仓周期（rebalance freq +50%）观察是否改善。`;
      const dp = ctx.strategy?.default_params || {};
      if (Number.isFinite(Number(dp.topN))) {
        suggestions.topN = Math.max(5, Math.floor(Number(dp.topN) * 0.8));
      }
    } else if (latest && latest.max_drawdown_pct !== null && latest.max_drawdown_pct < -15) {
      advice = `最近一次回测最大回撤 ${latest.max_drawdown_pct.toFixed(
        2
      )}%，建议加 portfolio 层 stop loss 或提高 cash buffer。`;
    } else {
      advice = `当前 ${stratName} 指标表现尚可，可尝试小幅 grid search topN / lookback 验证 robust 性。`;
    }
    return {
      reply: `${advice}\n（AI 远端暂时不可达，已用启发式总结。）`,
      suggested_params: suggestions,
      strategy_draft: null,
    };
  }

  if (ctx.intent === COPILOT_INTENTS.GENERATE_DRAFT) {
    return {
      reply:
        '生成新策略草案需要 AI 远端能力，当前远端不可达。建议稍后重试，或在问题里描述：universe（市场范围）、entry signal（入场条件）、exit signal（出场条件）、持仓周期与最大持仓数，Copilot 才能给出 TypeScript 代码。',
      suggested_params: {},
      strategy_draft: null,
    };
  }

  // general
  return {
    reply: `你好！我是策略 Copilot。我可以帮你：\n  1. 解释最近回测的 sharpe / 回撤 / 胜率\n  2. 基于回测指标建议参数调整\n  3. 根据描述生成新策略 TypeScript 代码草案\n请在右下角输入框告诉我你想了解的内容。\n（AI 远端暂时不可达，正在使用启发式回答。）`,
    suggested_params: {},
    strategy_draft: null,
  };
}

/**
 * 把 remote AI payload 折叠成 CopilotResponse (pure transform)。
 *
 * - 失败 payload (status='FAILED' / 缺 data / reply 为空) → 走 heuristic fallback,
 *   nlp_engine='heuristic_fallback', status='partial' (不是 failed — 因为我们有兜底答案)
 *   除非 fallback 也 reply 为空才 status='failed';
 * - 远端 intent 覆盖本地 normalizeIntent;
 * - generate_draft + 远端 strategy_draft 字段直接取; 否则 parseStrategyDraft(reply);
 * - suggested_params 缺失或非 object → {};
 */
export function buildResponseFromPayload(
  payload: RemoteCopilotPayload,
  ctx: {
    conversation_id: string;
    strategy_key: string | null;
    intent: CopilotIntent;
    prompt: string;
    promptContext: PromptContext;
    metadata: Record<string, unknown>;
    now: Date;
  }
): CopilotResponse {
  const statusRaw = String(payload?.status || '').toUpperCase();
  const data = payload?.data;

  // 失败 / 空 payload → 启发式 fallback
  const remoteReplyText = typeof data?.reply === 'string' ? data.reply.trim() : '';
  if (statusRaw === 'FAILED' || !data || remoteReplyText.length === 0) {
    const fb = buildHeuristicFallback(ctx.promptContext);
    const errMsg =
      (typeof data?.error === 'string' && data.error) ||
      (statusRaw === 'FAILED' ? 'TradingAgents 返回 FAILED 状态' : null);
    const replyText = fb.reply;
    return {
      conversation_id: ctx.conversation_id,
      strategy_key: ctx.strategy_key,
      intent: ctx.intent,
      prompt: ctx.prompt,
      reply: replyText,
      suggested_params: fb.suggested_params,
      strategy_draft: fb.strategy_draft,
      next_action: null,
      status: replyText.length > 0 ? 'partial' : 'failed',
      nlp_engine: NLP_ENGINES.HEURISTIC,
      error: errMsg,
      generated_at: ctx.now.toISOString(),
      metadata: { ...ctx.metadata, raw_status: statusRaw || 'EMPTY' },
      persisted: false,
    };
  }

  // 成功 payload — 远端 intent 覆盖本地 (用白名单单一事实源, 与 normalizeIntent override 一致)
  const remoteIntent = typeof data.intent === 'string' ? data.intent.toLowerCase() : '';
  const finalIntent: CopilotIntent = (ALL_COPILOT_INTENTS as Set<string>).has(remoteIntent)
    ? (remoteIntent as CopilotIntent)
    : ctx.intent;

  const suggestedParams: Record<string, any> =
    data.suggested_params && typeof data.suggested_params === 'object'
      ? (data.suggested_params as Record<string, any>)
      : {};

  let strategyDraft: string | null = null;
  if (finalIntent === COPILOT_INTENTS.GENERATE_DRAFT) {
    if (typeof data.strategy_draft === 'string' && data.strategy_draft.trim().length > 0) {
      strategyDraft = data.strategy_draft.trim();
    } else {
      strategyDraft = parseStrategyDraft(remoteReplyText);
    }
  }

  const nextAction = typeof data.next_action === 'string' ? data.next_action : null;

  return {
    conversation_id: ctx.conversation_id,
    strategy_key: ctx.strategy_key,
    intent: finalIntent,
    prompt: ctx.prompt,
    reply: remoteReplyText,
    suggested_params: suggestedParams,
    strategy_draft: strategyDraft,
    next_action: nextAction,
    status: 'completed',
    nlp_engine: NLP_ENGINES.TRADING_AGENTS,
    error: null,
    generated_at: ctx.now.toISOString(),
    metadata: { ...ctx.metadata, raw_status: statusRaw || 'COMPLETED' },
    persisted: false,
  };
}

/**
 * 生成业务级唯一 conversation_id。
 *
 * 格式：`COP-{YYYYMMDDHHmmss}-{rand4}` （强制 UTC，与 US-055 buildReportId 一致）
 *   e.g. `COP-20260608101530-a3f9`
 *
 * - 不绑定 strategy_key（同一对话可能多策略问答）；
 * - 调用方可传入 `now` 让测试稳定化（不传则用 new Date()）；
 * - rand 用 Math.random()*0x10000 → hex padStart 4 防同秒冲突。
 */
export function buildConversationId(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `COP-${y}${m}${d}${hh}${mm}${ss}-${rand}`;
}

// ---------------------------------------------------------------------------
// US-033 CO-002: EntityExtractor pure functions
// ---------------------------------------------------------------------------

/**
 * US-033 / CO-002 — EntityExtractor pure helpers。
 *
 * 接续 US-032 (TASK_INTENTS) — task-style intent (QUERY_STOCKS / RUN_BACKTEST /
 * EXPLAIN_PICK / WHAT_IF / SET_ALERT / GET_DIAGNOSIS …) 需要从自然语言问句里
 * 提取「执行 slot」, 喂给后续 CO-006 TaskRouter 路由到 service。
 *
 * 6 个 pure helper (全 export, 单测覆盖):
 *   - extractStocks       — 6 位 A 股代码 + 市场推断 (sh/sz/bj);
 *   - extractIndustries   — 行业关键词命中 (光伏 / 新能源 / 半导体 / 医药 / 银行 …);
 *   - extractIndicators   — 技术指标 / 回测指标 (RSI / MACD / KDJ / sharpe / 回撤 / 胜率);
 *   - extractNumbers      — 数字 + 单位 (百分比 / 元 / 万 / 亿 / 倍 / 天 / 月) + raw;
 *   - extractDates        — 绝对日期 (YYYY-MM-DD / 6月19日) + 相对 (今天 / 昨天 / 最近 N 天);
 *   - extractStrategyParams — key=value 串 (topN=30 lookback=20) → object;
 *
 * 以及统一聚合入口 `extractEntities(text)` → 一次返回 6 类切片, 上游单次扫描即可拿全;
 * 与 AnnouncementNLPService 同名 `extractEntities` 不冲突 (那个属于公告角色实体, 不同 namespace,
 * Copilot 这边的 entity 关注「执行 slot」而非「股东角色」).
 *
 * pure, 无 I/O; 大小写不敏感; null / undefined / 非字符串 / 空 / 全空格 → 空切片。
 */

/** 单个股票切片 — code 始终 6 位; market 为 'sh'/'sz'/'bj' 之一; raw 是原始捕获 */
export interface ExtractedStock {
  code: string;
  market: 'sh' | 'sz' | 'bj';
  raw: string;
}

/** 数字切片 — value 已转 number; unit 标准化 ('pct' / 'yuan' / 'wan' / 'yi' / 'x' / 'day' / 'month' / null) */
export interface ExtractedNumber {
  value: number;
  unit: 'pct' | 'yuan' | 'wan' | 'yi' | 'x' | 'day' | 'month' | null;
  raw: string;
}

/** 日期切片 — kind=absolute/relative; iso 仅 absolute 形态; raw 原文 */
export interface ExtractedDate {
  kind: 'absolute' | 'relative';
  iso: string | null;
  raw: string;
  /** 相对日期的偏移天数 (相对 today); absolute → null */
  offset_days: number | null;
}

/** 6 类切片聚合 (extractEntities 出口) */
export interface ExtractedEntities {
  stocks: ExtractedStock[];
  industries: string[];
  indicators: string[];
  numbers: ExtractedNumber[];
  dates: ExtractedDate[];
  strategy_params: Record<string, number | string>;
}

/**
 * 标准化输入: null/undefined/非字符串/空/全空格 → ''。
 * 6 个 extractor 内部统一调一次, 避免每个都写一遍 null guard。
 */
function normalizeExtractorInput(raw: any): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

/**
 * 推断 6 位 A 股代码所属市场。
 * - sh: 600 / 601 / 603 / 605 / 688 / 689 (科创板) / 900 (B);
 * - sz: 000 / 001 / 002 / 003 / 300 / 301 / 200 (B);
 * - bj: 4 / 8 (北交所; 含 430/830/831/832/833/...);
 * - 其它 → 默认 sh (兜底, 不抛错)。
 */
export function inferStockMarket(code: string): 'sh' | 'sz' | 'bj' {
  if (typeof code !== 'string' || code.length !== 6) return 'sh';
  const c = code;
  if (/^(60|68|69|90)/.test(c)) return 'sh';
  if (/^(00|30|20)/.test(c)) return 'sz';
  if (/^(4|8)/.test(c)) return 'bj';
  return 'sh';
}

/**
 * 抽取 6 位 A 股代码。
 *
 * 规则:
 *   - 必须是恰好 6 位连续数字, 前后不能紧跟更多数字 (避免 "1234567" 误当 "123456");
 *   - 去重 (同代码多次出现只返一次);
 *   - 顺序按首次出现位置;
 *   - market 用 inferStockMarket 推断。
 *
 * 不抽: 5 位 / 7 位 / 含字母前缀 (sh600519 / sz000001) — 留给 downstream 真解析。
 */
export function extractStocks(text: any): ExtractedStock[] {
  const s = normalizeExtractorInput(text);
  if (!s) return [];
  const out: ExtractedStock[] = [];
  const seen = new Set<string>();
  // (?<!\d) (?!\d) 边界 — 避免 "1234567" 当成 "123456"; ES2018 lookbehind 在 Node 18+ 稳定。
  const re = /(?<!\d)(\d{6})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const code = m[1];
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, market: inferStockMarket(code), raw: code });
  }
  return out;
}

/**
 * 行业关键词表 — 仅常见 22 类 (A 股 GICS / 申万一级简化版),
 * 抽到一类立即记入 (不严格分类, 命中即取); 中英别名互通。
 * Frozen 防外部 push 污染。
 */
export const INDUSTRY_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  '光伏',
  '新能源',
  '锂电',
  '半导体',
  '芯片',
  '人工智能',
  'AI',
  '医药',
  '生物医药',
  '银行',
  '券商',
  '保险',
  '地产',
  '房地产',
  '白酒',
  '消费',
  '军工',
  '汽车',
  '钢铁',
  '煤炭',
  '有色',
  '化工',
  '电力',
  '5G',
  '通信',
  '机械',
  '建材',
  '农业',
  '食品',
  '传媒',
  '互联网',
  '云计算',
  '储能',
  '风电',
]);

/**
 * 抽取行业关键词 — 命中 INDUSTRY_KEYWORDS 即记入, 大小写不敏感, 去重, 按首次出现顺序。
 */
export function extractIndustries(text: any): string[] {
  const s = normalizeExtractorInput(text);
  if (!s) return [];
  const upper = s.toUpperCase();
  const hits: Array<{ kw: string; pos: number }> = [];
  const seen = new Set<string>();
  for (const kw of INDUSTRY_KEYWORDS) {
    const pos = upper.indexOf(kw.toUpperCase());
    if (pos < 0) continue;
    if (seen.has(kw)) continue;
    seen.add(kw);
    hits.push({ kw, pos });
  }
  hits.sort((a, b) => a.pos - b.pos);
  return hits.map(h => h.kw);
}

/**
 * 指标关键词表 — 14 个常见 (技术 + 回测), 中英别名互通。
 * '夏普' 与 'sharpe' 都标准化成 'sharpe' (canonical 形态), 减少 downstream 分支。
 */
export const INDICATOR_ALIASES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['RSI', 'rsi'],
  ['MACD', 'macd'],
  ['KDJ', 'kdj'],
  ['BOLL', 'boll'],
  ['MA', 'ma'],
  ['EMA', 'ema'],
  ['SHARPE', 'sharpe'],
  ['夏普', 'sharpe'],
  ['SORTINO', 'sortino'],
  ['最大回撤', 'max_drawdown'],
  ['MAX_DRAWDOWN', 'max_drawdown'],
  ['MAX DRAWDOWN', 'max_drawdown'],
  ['DRAWDOWN', 'max_drawdown'],
  ['回撤', 'max_drawdown'],
  ['胜率', 'win_rate'],
  ['WIN_RATE', 'win_rate'],
  ['WIN RATE', 'win_rate'],
  ['CALMAR', 'calmar'],
  ['ALPHA', 'alpha'],
  ['BETA', 'beta'],
  ['北向', 'northbound'],
  ['NORTHBOUND', 'northbound'],
  ['换手率', 'turnover'],
  ['TURNOVER', 'turnover'],
] as const);

/**
 * 抽取技术 / 回测指标 (canonical 形态)。
 * 多个别名命中同一 canonical 只取一次; 顺序按首次命中位置。
 */
export function extractIndicators(text: any): string[] {
  const s = normalizeExtractorInput(text);
  if (!s) return [];
  const upper = s.toUpperCase();
  const hits: Array<{ canonical: string; pos: number }> = [];
  const seenCanonical = new Set<string>();
  for (const [alias, canonical] of INDICATOR_ALIASES) {
    if (seenCanonical.has(canonical)) continue;
    const pos = upper.indexOf(alias.toUpperCase());
    if (pos < 0) continue;
    seenCanonical.add(canonical);
    hits.push({ canonical, pos });
  }
  hits.sort((a, b) => a.pos - b.pos);
  return hits.map(h => h.canonical);
}

/**
 * 数字单位归一化表 — 把后缀 token (% / 元 / 万 / 亿 / 倍 / 天 / 个月) 映射成 ExtractedNumber.unit。
 * 注意: "万" 表示 ×10000 但仅记 unit 不乘 value (downstream 自己换算; 否则会丢精度信息);
 * unit=null 表示纯数字, 无后缀。
 */
const NUMBER_UNIT_TOKENS: ReadonlyArray<readonly [string, ExtractedNumber['unit']]> = Object.freeze(
  [
    ['%', 'pct'],
    ['亿', 'yi'],
    ['万', 'wan'],
    ['元', 'yuan'],
    ['倍', 'x'],
    ['个月', 'month'],
    ['月', 'month'],
    ['天', 'day'],
  ] as const
);

/**
 * 抽取数字 (含可选单位)。
 *
 * 规则:
 *   - 支持整数 / 小数 / 负数;
 *   - 紧跟的单位 token 归一 (% → pct, 万 → wan, 亿 → yi, 元 → yuan, 倍 → x, 天 → day, 月/个月 → month);
 *   - 6 位连续数字若被 extractStocks 视为股票代码, 仍会被 extractNumbers 抽出 (上游可去重);
 *   - 顺序按出现位置, 不去重 (同一数字可能在不同场景出现, e.g. "topN=30 lookback=30")。
 *
 * Gotcha: "30.5%" 整体抽 (value=30.5, unit=pct, raw="30.5%"); "30%" → value=30, unit=pct。
 */
export function extractNumbers(text: any): ExtractedNumber[] {
  const s = normalizeExtractorInput(text);
  if (!s) return [];
  const out: ExtractedNumber[] = [];
  // (?<!\w) 前界 — 避免 "topN30" 把 N30 看成 30 (key=value 由 extractStrategyParams 处理);
  // 不过 "topN=30" 的 "30" 仍能抽 (= 不是 \w);
  // 后界由单位 token 匹配兜底; -? 允许负数; \d+ \.? \d* 是 0.5 / 5 / 5.0 等。
  const re = /(?<![\w.])(-?\d+(?:\.\d+)?)([%亿万元倍天]|个月|月)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const valueStr = m[1];
    const unitToken = m[2] || '';
    const value = Number(valueStr);
    if (!Number.isFinite(value)) continue;
    let unit: ExtractedNumber['unit'] = null;
    let raw = valueStr;
    if (unitToken) {
      for (const [token, u] of NUMBER_UNIT_TOKENS) {
        if (token === unitToken) {
          unit = u;
          raw = valueStr + unitToken;
          break;
        }
      }
    }
    out.push({ value, unit, raw });
  }
  return out;
}

/**
 * 抽取日期 (绝对 + 相对)。
 *
 * 支持形态:
 *   - 绝对: YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYY年M月D日 / M月D日 (年默认 null) → kind=absolute, iso 标准化 'YYYY-MM-DD' (年缺 → null);
 *   - 相对: 今天/今日 (offset_days=0), 昨天/昨日 (-1), 前天 (-2), 明天/明日 (+1), 后天 (+2),
 *     上周 (-7), 下周 (+7), 上月 (-30), 下月 (+30), 最近 N 天/N 日 (offset_days=-N);
 *   - kind=relative 时 iso=null, offset_days 填该相对偏移 (供 downstream 用 today + offset 还原日期).
 *
 * 顺序按出现位置; 不去重 (用户可能同一句话提多个日期).
 */
export function extractDates(text: any): ExtractedDate[] {
  const s = normalizeExtractorInput(text);
  if (!s) return [];
  const hits: Array<ExtractedDate & { _pos: number }> = [];

  // 1) 绝对: YYYY[-/.]MM[-/.]DD (年 4 位; 月 1-2; 日 1-2)
  const reAbs = /(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?/g;
  let m: RegExpExecArray | null;
  while ((m = reAbs.exec(s)) !== null) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    hits.push({ kind: 'absolute', iso, raw: m[0], offset_days: null, _pos: m.index });
  }

  // 2) 绝对(无年): M月D日 — 仅当前面不是 "X年" 时 (避免重复抽 "2026年6月19日" 的尾段)
  const reAbsNoYear = /(?<!\d)(\d{1,2})月(\d{1,2})日/g;
  while ((m = reAbsNoYear.exec(s)) !== null) {
    // 跳过已经被 reAbs 覆盖的位置
    const overlapped = hits.some(h => h._pos <= m!.index && m!.index < h._pos + h.raw.length);
    if (overlapped) continue;
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    hits.push({ kind: 'absolute', iso: null, raw: m[0], offset_days: null, _pos: m.index });
  }

  // 3) 相对 — 固定词表
  const relWords: Array<[string, number]> = [
    ['前天', -2],
    ['昨天', -1],
    ['昨日', -1],
    ['今天', 0],
    ['今日', 0],
    ['明天', 1],
    ['明日', 1],
    ['后天', 2],
    ['上周', -7],
    ['下周', 7],
    ['上月', -30],
    ['下月', 30],
  ];
  for (const [word, offset] of relWords) {
    let pos = -1;
    let from = 0;
    while ((pos = s.indexOf(word, from)) >= 0) {
      hits.push({ kind: 'relative', iso: null, raw: word, offset_days: offset, _pos: pos });
      from = pos + word.length;
    }
  }

  // 4) 相对: 最近 N 天/日/月
  const reRecent = /最近\s*(\d+)\s*(天|日|个月|月)/g;
  while ((m = reRecent.exec(s)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = m[2];
    const days = unit === '个月' || unit === '月' ? -n * 30 : -n;
    hits.push({
      kind: 'relative',
      iso: null,
      raw: m[0],
      offset_days: days,
      _pos: m.index,
    });
  }

  hits.sort((a, b) => a._pos - b._pos);
  return hits.map(({ _pos: _p, ...rest }) => rest);
}

/**
 * 抽取 key=value 形态的策略参数。
 *
 * 支持:
 *   - key=value  (e.g. topN=30 lookback=20);
 *   - key:value  (e.g. topN:30);
 *   - key 必须以字母 / 下划线开头 (避免抽中纯数字), 2-32 字符;
 *   - value 支持整数 / 小数 / 负数 / 单词 (引号可选, 暂不抽引号串避免歧义);
 *   - 数字 value 转 number, 否则保留 string;
 *   - 同 key 多次出现取最后一个 (后覆盖前, 与 shell 习惯一致)。
 *
 * Gotcha: 大小写敏感 (topN ≠ topn), 与 strategy default_params 的 JS 命名习惯一致。
 */
export function extractStrategyParams(text: any): Record<string, number | string> {
  const s = normalizeExtractorInput(text);
  if (!s) return {};
  const out: Record<string, number | string> = {};
  const re = /\b([A-Za-z_][A-Za-z0-9_]{1,31})\s*[=:]\s*(-?\d+(?:\.\d+)?|[A-Za-z][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1];
    const valRaw = m[2];
    const asNum = Number(valRaw);
    out[key] = Number.isFinite(asNum) && /^-?\d/.test(valRaw) ? asNum : valRaw;
  }
  return out;
}

/**
 * 统一聚合入口 — 一次扫 6 类切片, 上游 (TaskRouter / Copilot service) 单调即可拿全 slot。
 * 各子 extractor 已 normalize 输入, 这里直接转调; 无 I/O。
 */
export function extractEntities(text: any): ExtractedEntities {
  return {
    stocks: extractStocks(text),
    industries: extractIndustries(text),
    indicators: extractIndicators(text),
    numbers: extractNumbers(text),
    dates: extractDates(text),
    strategy_params: extractStrategyParams(text),
  };
}

/**
 * 把 suggested_params 与 default_params 比对，列出 (key, before, after) 三元组。
 * 前端把这个 delta 渲染成 "建议改动" 表，让用户 1 秒决定是否 apply。
 */
export function extractKeyDelta(
  defaultParams: Record<string, any> | null | undefined,
  suggested: Record<string, any> | null | undefined
): Array<{ key: string; before: any; after: any }> {
  if (!suggested || typeof suggested !== 'object') return [];
  const dp = defaultParams && typeof defaultParams === 'object' ? defaultParams : {};
  const out: Array<{ key: string; before: any; after: any }> = [];
  for (const [key, after] of Object.entries(suggested)) {
    const before = dp[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    out.push({ key, before: before === undefined ? null : before, after });
  }
  return out;
}

// ---------------------------------------------------------------------------
// StrategyCopilotService
// ---------------------------------------------------------------------------

export class StrategyCopilotService {
  private readonly dataSource: StrategyCopilotDataSource;

  constructor(dataSource: StrategyCopilotDataSource = PRODUCTION_STRATEGY_COPILOT_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 主入口 — 接收用户问句 + 上下文，返回 CopilotResponse。
   *
   * 流程:
   *   1) normalizeIntent → 推断意图;
   *   2) loadStrategy + loadRecentBacktests 并发 (空 strategy_key 跳过);
   *   3) buildPromptContext + buildPromptText 拼 prompt;
   *   4) callRemoteCopilot (双重防御 try/catch);
   *   5) buildResponseFromPayload 折叠回 CopilotResponse;
   *   6) dry_run=true 跳过 saveConversation, persist=false;
   *   7) saveConversation try/catch fail-OPEN 不阻塞返回.
   */
  async askCopilot(userPrompt: string, options: AskCopilotOptions = {}): Promise<CopilotResponse> {
    const now = options.now || new Date();
    const conversationId = options.conversation_id || buildConversationId(now);
    const strategyKey =
      typeof options.strategy_key === 'string' && options.strategy_key.trim().length > 0
        ? options.strategy_key.trim()
        : null;
    const intent = normalizeIntent(userPrompt, options.intent_override);
    const prompt = typeof userPrompt === 'string' ? userPrompt.trim() : '';

    const metadata: Record<string, unknown> = {
      user_id: options.user_id ?? null,
      task_label: options.task_label ?? null,
      requested_at: now.toISOString(),
    };

    // 并发加载策略 + 回测（strategy_key 缺失时跳过）
    let strategy: StrategyMeta | null = null;
    let backtests: BacktestSummary[] = [];
    if (strategyKey) {
      try {
        const [s, b] = await Promise.all([
          this.dataSource.loadStrategy(strategyKey),
          this.dataSource.loadRecentBacktests(strategyKey, DEFAULT_BACKTEST_LOOKBACK),
        ]);
        strategy = s;
        backtests = b;
      } catch (err: any) {
        // DataSource 实现层应已 catch，此处只是双重防御
        logger.warn(
          `StrategyCopilot.askCopilot context load failed (${strategyKey}): ${err.message}`
        );
      }
    }

    const promptContext = buildPromptContext({
      strategy,
      backtests,
      user_prompt: prompt,
      intent,
    });
    const promptText = buildPromptText(promptContext);

    // 调远端（双重防御）
    let payload: RemoteCopilotPayload;
    try {
      payload = await this.dataSource.callRemoteCopilot(promptText, intent, metadata);
    } catch (err: any) {
      payload = {
        status: 'FAILED',
        data: { error: err?.message || String(err) || 'unknown error' },
      };
    }

    const result = buildResponseFromPayload(payload, {
      conversation_id: conversationId,
      strategy_key: strategyKey,
      intent,
      prompt,
      promptContext,
      metadata,
      now,
    });

    if (options.dry_run === true) {
      return result;
    }

    try {
      await this.dataSource.saveConversation(result);
      result.persisted = true;
    } catch (err: any) {
      // fail-OPEN：DB 故障不阻塞 UI 拿到 reply；metadata 记 save_error 供事后调查
      logger.warn(
        `StrategyCopilot.saveConversation failed (conversation_id=${conversationId}): ${err.message}`
      );
      result.metadata = { ...result.metadata, save_error: err.message };
    }

    return result;
  }

  /**
   * 加载策略元 + 最近回测，组装 prompt 上下文返回（不调远端）。
   * 用于 UI debug "查看上次 prompt" 或前端 SSE 启动前先拿到上下文展示。
   */
  async loadContext(
    strategyKey: string | null,
    lookback?: number
  ): Promise<{
    strategy: StrategyMeta | null;
    backtests: BacktestSummary[];
  }> {
    if (!strategyKey) return { strategy: null, backtests: [] };
    const limit = normalizeBacktestLookback(lookback);
    const [strategy, backtests] = await Promise.all([
      this.dataSource.loadStrategy(strategyKey),
      this.dataSource.loadRecentBacktests(strategyKey, limit),
    ]);
    return { strategy, backtests };
  }
}

export const strategyCopilotService = new StrategyCopilotService();
