/**
 * EnhancedTradingJournalService — US-087 复盘日记 AI 自动生成升级
 *
 * 每个交易日 15:30 收盘后由 SchedulerService 触发，给所有 is_active=true 用户
 * 自动生成（或刷新）当日 TradingJournal 一行：
 *
 *   - market_summary      ：## 今日战报（PnL）+ ## 市场观察（指数 / 北向 / 涨停）
 *   - portfolio_analysis  ：## 操作复盘（trade list + 行业归因）
 *   - action_plan         ：## 明日策略 + ## 风险提醒
 *
 * **设计严格遵循 US-055 AI feature 6 项 checklist**（progress.txt US-055 一节）+
 * US-063 / US-073 已经验证的模板：
 *   (1) DataSource DI（EnhancedTradingJournalDataSource + Default + PRODUCTION + 测试 fake）
 *   (2) 8+ 个 export 纯函数（buildPrompt / buildMarkdown / formatPnLSection /
 *       formatTradeSection / formatMarketSection / formatActionSection /
 *       formatRiskSection / pickTopTrades / pickTopAlerts / buildJournalId /
 *       normalizeAIPayload / safeMoney / safePct）
 *   (3) plain-object 返回类型 `JournalForUserResult` 兼容 persist=true / dry_run=true 同形态
 *       （与 US-037 OptimizationResultRecord / US-055 AnalyzeSingleStockResult /
 *       US-063 DigestForUserResult 一致）
 *   (4) status='partial'/'failed'/'generated' 仍正常 persist 让 caller 看到曾尝试
 *   (5) fail-OPEN on remote AI (转 heuristic_fallback) + fail-OPEN on saveJournal
 *       (DB 故障转 warning + persisted=false)
 *   (6) 双重防御 try/catch：DataSource 层 catch + service 顶层再 catch
 *
 * 与既有 JournalController.createJournal 的关系：
 *   - createJournal 是 user 手动建立（覆盖式），本 service 自动生成（cron upsert）。
 *   - 本 service 写入时**保留** user_notes (US-017) — 不清空用户已追加的手记；
 *     只替换 market_summary / portfolio_analysis / action_plan / mood / tags 主字段。
 *   - 若用户已手动编辑过同日 journal（mood != '未生成' 且 mood != 'AI'），
 *     overwriteHandEdited=false 时 service 跳过该用户避免覆盖，标 status='skipped'；
 *     overwriteHandEdited=true 时仍覆盖（admin force-regen 路径）。
 */

import { Op } from 'sequelize';
import moment from 'moment-timezone';

import { logger } from '../utils/logger';
import { randHex4 } from '../utils/randomHex';
import { User } from '../models/User';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';
import { TradingJournal } from '../models/TradingJournal';
import { RiskAlert } from '../models/RiskAlert';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const JOURNAL_STATUS = Object.freeze({
  GENERATED: 'generated',
  PARTIAL: 'partial',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const);

export type JournalStatus = (typeof JOURNAL_STATUS)[keyof typeof JOURNAL_STATUS];

export const NLP_ENGINES = Object.freeze({
  TRADING_AGENTS: 'trading_agents' as const,
  HEURISTIC: 'heuristic_fallback' as const,
});

export type NlpEngine = (typeof NLP_ENGINES)[keyof typeof NLP_ENGINES];

/** 每张卡片展示的 trade 上限 */
export const DEFAULT_TOP_TRADES_PER_DIRECTION = 5;
export const MAX_TOP_TRADES_PER_DIRECTION = 20;

/** 风险提醒展示上限 */
export const DEFAULT_TOP_ALERTS = 5;
export const MAX_TOP_ALERTS = 20;

/** AI 一句话 mood / tag 默认值 — 失败 / 未生成时仍能落 mood 字段 */
export const DEFAULT_MOOD_GENERATED = 'AI';
export const DEFAULT_MOOD_FAILED = '未生成';

// ---------------------------------------------------------------------------
// 数据形状
// ---------------------------------------------------------------------------

export interface JournalTradeRow {
  symbol: string;
  name: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  execute_price: number;
  amount: number;
  realized_pnl?: number | null;
  industry?: string | null;
}

export interface JournalPnLSummary {
  total_value: number;
  prev_total_value: number;
  pnl_today: number;
  pnl_today_pct: number | null;
  position_value: number;
  current_cash: number;
}

export interface JournalMarketSummary {
  benchmark_symbol: string;
  prev_close: number | null;
  today_close: number | null;
  change_pct: number | null;
  northbound_net_yi: number | null;
  limit_up_count: number | null;
  ai_view: string | null;
  ai_view_engine: NlpEngine | null;
}

export interface JournalIndustryAttributionRow {
  industry: string;
  pnl: number;
  trade_count: number;
}

export interface JournalRiskAlertRow {
  level: string; // 'LOW' | 'MEDIUM' | 'HIGH'
  rule_id: string;
  symbol: string;
  message: string;
}

export interface JournalGenerationInput {
  user_id: number;
  username: string;
  trade_date: string;
  pnl: JournalPnLSummary;
  trades_buy: JournalTradeRow[];
  trades_sell: JournalTradeRow[];
  buy_count: number;
  sell_count: number;
  market: JournalMarketSummary;
  industry_attribution: JournalIndustryAttributionRow[];
  risk_alerts: JournalRiskAlertRow[];
  tomorrow_candidates: string[];
}

export interface JournalGenerationOutput {
  /** ## 今日战报 + ## 操作复盘 拼接 — 落 TradingJournal.market_summary */
  market_summary: string;
  /** ## 操作复盘 + 行业归因 — 落 TradingJournal.portfolio_analysis */
  portfolio_analysis: string;
  /** ## 明日策略 + ## 风险提醒 — 落 TradingJournal.action_plan */
  action_plan: string;
  tags: string[];
  mood: string;
  /** AI 引擎来源 — trading_agents / heuristic_fallback */
  nlp_engine: NlpEngine;
}

export interface JournalForUserResult {
  journal_id: string;
  status: JournalStatus;
  /** 实际是否真的写表（dry_run / overwriteHandEdited=false 命中 false） */
  persisted: boolean;
  user_id: number;
  username: string;
  trade_date: string;
  output?: JournalGenerationOutput;
  /** 失败原因；status='generated' 时为 undefined */
  error?: string;
  /** 跳过原因 */
  skip_reason?: string;
  /** TradingJournal.id — persisted=true 时填 */
  saved_row_id?: number;
}

export interface GenerateForAllResult {
  trade_date: string;
  scanned_users: number;
  generated_count: number;
  skipped_count: number;
  failed_count: number;
  partial_count: number;
  /** dry_run=true 时不写表，但仍计算 output */
  dry_run: boolean;
  per_user: JournalForUserResult[];
}

export interface GenerateOptions {
  /** 仅评估单个 user，缺省扫所有 is_active 用户 */
  user_id?: number;
  /** 覆盖 trade_date，缺省 = 上海时区当前日期 */
  trade_date?: string;
  /** 不实际写表，只返回 output；用于预演 */
  dry_run?: boolean;
  /**
   * 是否覆盖用户已手动编辑的 journal（mood != 'AI' 且 != '未生成'）。
   * 默认 false 保守，admin force-regen 走 true。
   */
  overwrite_hand_edited?: boolean;
  /** 远端 AI 跳过（dry-run / 单测加速）；默认 false */
  skip_ai?: boolean;
}

// ---------------------------------------------------------------------------
// DataSource 接口
// ---------------------------------------------------------------------------

export interface EnhancedTradingJournalDataSource {
  listEligibleUsers(opts: { user_id?: number }): Promise<
    Array<{
      user_id: number;
      username: string;
    }>
  >;
  loadPortfolioSummary(
    user_id: number
  ): Promise<{ portfolio: PaperTradingPortfolio; positions: PaperTradingPosition[] } | null>;
  loadTodayTrades(portfolio_id: number, trade_date: string): Promise<PaperTradingTrade[]>;
  loadRecentSnapshots(
    portfolio_id: number,
    limit: number
  ): Promise<Array<{ date: string; total_value: number }>>;
  /** 取当日大盘速读 — 含 prev_close / today_close / 北向 / 涨停 / AI view */
  loadMarketSummary(trade_date: string): Promise<JournalMarketSummary>;
  /** 取该 user 当日 风控告警（HIGH / MEDIUM） */
  loadRiskAlerts(
    user_id: number,
    trade_date: string,
    limit: number
  ): Promise<JournalRiskAlertRow[]>;
  /** 取明日候选 top-N（symbol[]）— 复用 TodaySignalsService */
  loadTomorrowCandidates(trade_date: string, limit: number): Promise<string[]>;
  /** 调远端 AI 生成 (markdown / 一句话)。失败时返回 status='FAILED' */
  callRemoteAI(prompt: string): Promise<{
    status: 'OK' | 'FAILED';
    markdown?: string;
    mood?: string;
    tags?: string[];
    error?: string;
  }>;
  /** UPSERT TradingJournal 一行。返回 row id 给上层填 saved_row_id */
  saveJournal(record: {
    user_id: number;
    trade_date: string;
    market_summary: string;
    portfolio_analysis: string;
    action_plan: string;
    tags: string[];
    mood: string;
    /** 是否覆盖用户手编（控制是否替换非 AI mood 的 journal） */
    overwrite_hand_edited: boolean;
  }): Promise<{ id: number; persisted: boolean; skip_reason?: string }>;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing
// ---------------------------------------------------------------------------

/** "1,234.56" 千分位 + 2 位 */
export function safeMoney(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00';
  const abs = Math.abs(n);
  const intPart = Math.floor(abs).toString();
  const intWithCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decPart = (abs - Math.floor(abs)).toFixed(2).slice(1);
  return `${n < 0 ? '-' : ''}${intWithCommas}${decPart}`;
}

/** "+0.62%" / "-1.23%" / "0.00%" */
export function safePct(v: any, withSign = false): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00%';
  if (withSign && n > 0) return `+${n.toFixed(2)}%`;
  return `${n.toFixed(2)}%`;
}

/** 抽取 top-N trades（按 amount 降序 stable tie-break by symbol asc） */
export function pickTopTrades(
  rows: JournalTradeRow[],
  direction: 'BUY' | 'SELL',
  limit: number
): JournalTradeRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const filtered = rows.filter(r => r.direction === direction);
  filtered.sort((a, b) => {
    const da = Number(a.amount) || 0;
    const db = Number(b.amount) || 0;
    if (db !== da) return db - da;
    return (a.symbol || '').localeCompare(b.symbol || '');
  });
  const cap = clampInt(limit, DEFAULT_TOP_TRADES_PER_DIRECTION, 1, MAX_TOP_TRADES_PER_DIRECTION);
  return filtered.slice(0, cap);
}

/** 抽取 top-N 风险告警（HIGH 优先，按 level 后按时间） */
export function pickTopAlerts(rows: JournalRiskAlertRow[], limit: number): JournalRiskAlertRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const levelRank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const sorted = [...rows].sort((a, b) => {
    const ra = levelRank[String(a.level || '').toUpperCase()] ?? 99;
    const rb = levelRank[String(b.level || '').toUpperCase()] ?? 99;
    if (ra !== rb) return ra - rb;
    return (a.rule_id || '').localeCompare(b.rule_id || '');
  });
  const cap = clampInt(limit, DEFAULT_TOP_ALERTS, 1, MAX_TOP_ALERTS);
  return sorted.slice(0, cap);
}

/**
 * 计算 PnL summary — 输入 portfolio + recent snapshot，返回标准 5 字段 + 百分比。
 * prev_snapshot 缺失时 fallback initial_capital；prev <= 0 时 pnl_today_pct = null。
 */
export function computeJournalPnLSummary(input: {
  total_value: number;
  current_cash: number;
  initial_capital: number;
  positions_market_value: number;
  prev_snapshot_total_value: number | null;
}): JournalPnLSummary {
  const total = safeNumber(input.total_value);
  const cash = safeNumber(input.current_cash);
  const posVal = safeNumber(input.positions_market_value);
  const prev =
    input.prev_snapshot_total_value !== null && Number.isFinite(input.prev_snapshot_total_value)
      ? Number(input.prev_snapshot_total_value)
      : safeNumber(input.initial_capital);
  const pnl = round2(total - prev);
  const pnlPct = prev > 0 ? round2(((total - prev) / prev) * 100) : null;
  return {
    total_value: round2(total),
    prev_total_value: round2(prev),
    pnl_today: pnl,
    pnl_today_pct: pnlPct,
    position_value: round2(posVal),
    current_cash: round2(cash),
  };
}

/**
 * 按 industry 聚合 sell-side realized_pnl + trade_count。
 *
 * 设计：只聚合 SELL（realized_pnl 在 SELL 时才确定），BUY 不计入归因。
 * 若 trade.industry 缺失，归到 '其他' bucket。
 */
export function computeIndustryAttribution(
  trades: JournalTradeRow[]
): JournalIndustryAttributionRow[] {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  const map = new Map<string, { pnl: number; count: number }>();
  for (const t of trades) {
    if (t.direction !== 'SELL') continue;
    const ind = (t.industry || '其他').trim() || '其他';
    const pnl = Number(t.realized_pnl);
    if (!Number.isFinite(pnl)) continue;
    const entry = map.get(ind) || { pnl: 0, count: 0 };
    entry.pnl += pnl;
    entry.count += 1;
    map.set(ind, entry);
  }
  const out: JournalIndustryAttributionRow[] = [];
  for (const [ind, v] of map) {
    out.push({ industry: ind, pnl: round2(v.pnl), trade_count: v.count });
  }
  // 按 |pnl| 降序（贡献最大的行业排前）
  out.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  return out;
}

/** 业务 ID：JRN-{YYYYMMDD}-{user_id}-{rand4} (与 US-055 命名范式一致) */
export function buildJournalId(user_id: number, trade_date: string, rand4: string): string {
  const ymd = String(trade_date).replace(/-/g, '');
  const rand = String(rand4 || '')
    .slice(0, 4)
    .padStart(4, '0');
  return `JRN-${ymd}-${user_id}-${rand}`;
}

/**
 * 构造喂给 TradingAgents 的 markdown prompt（中文）。
 *
 * **prompt 模板顺序固定**（与 US-062 StrategyCopilot 同款，方便 prompt tuning 对比）：
 *   1. System role / 输出要求
 *   2. 用户与日期
 *   3. PnL 数据
 *   4. trade 明细
 *   5. 市场观察（指数 / 北向 / 涨停 / AI view）
 *   6. 行业归因
 *   7. 风控告警
 *   8. 明日候选
 *   9. 输出格式要求（5 section markdown）
 *
 * **关键约束 — markdown 5 section 顺序 + level-2 标题 ##** —— 让前端
 * `markdown_split('## ')` 能稳定切分; 不要省略任何 section（即使数据为空也输出 _暂无数据_）。
 *
 * 单测覆盖：
 *   - 必含 5 个 ## 段标题（'今日战报' '操作复盘' '市场观察' '明日策略' '风险提醒'）
 *   - 包含 trade_date / username
 *   - 缺数据时使用 — 占位
 */
export function buildAIPrompt(input: JournalGenerationInput): string {
  const lines: string[] = [];
  lines.push('你是一名 A 股个人投资助理，请基于以下数据为用户生成一篇当日复盘日记 markdown。');
  lines.push('严格按 5 段输出，每段以 "## " 开头，结构如下：');
  lines.push('## 今日战报');
  lines.push('## 操作复盘');
  lines.push('## 市场观察');
  lines.push('## 明日策略');
  lines.push('## 风险提醒');
  lines.push('');
  lines.push(`用户：${input.username}`);
  lines.push(`日期：${input.trade_date}`);
  lines.push('');
  lines.push('## 数据 - 账户当日盈亏');
  lines.push(
    `总资产：${safeMoney(input.pnl.total_value)} 元（昨收 ${safeMoney(
      input.pnl.prev_total_value
    )}）`
  );
  lines.push(
    `当日盈亏：${input.pnl.pnl_today >= 0 ? '+' : ''}${safeMoney(input.pnl.pnl_today)} 元${
      input.pnl.pnl_today_pct !== null
        ? `（${input.pnl.pnl_today_pct >= 0 ? '+' : ''}${safePct(input.pnl.pnl_today_pct)}）`
        : ''
    }`
  );
  lines.push(
    `持仓市值：${safeMoney(input.pnl.position_value)} 元 · 可用现金 ${safeMoney(
      input.pnl.current_cash
    )} 元`
  );
  lines.push('');

  lines.push('## 数据 - 交易明细');
  lines.push(`今日买入 ${input.buy_count} 笔，卖出 ${input.sell_count} 笔。`);
  if (input.trades_buy.length > 0) {
    lines.push('买入 top:');
    for (const t of input.trades_buy) {
      lines.push(`- ${t.symbol} ${t.name} ${t.quantity} 股 @${safeMoney(t.execute_price)}`);
    }
  }
  if (input.trades_sell.length > 0) {
    lines.push('卖出 top:');
    for (const t of input.trades_sell) {
      const pnl =
        t.realized_pnl !== undefined && t.realized_pnl !== null
          ? `（盈亏 ${t.realized_pnl >= 0 ? '+' : ''}${safeMoney(t.realized_pnl)}）`
          : '';
      lines.push(`- ${t.symbol} ${t.name} ${t.quantity} 股 @${safeMoney(t.execute_price)}${pnl}`);
    }
  }
  if (input.trades_buy.length === 0 && input.trades_sell.length === 0) {
    lines.push('（今日无成交）');
  }
  lines.push('');

  lines.push('## 数据 - 市场观察');
  lines.push(`沪深300：${input.market.prev_close ?? '—'} → ${input.market.today_close ?? '—'}`);
  lines.push(
    `涨跌幅：${input.market.change_pct === null ? '—' : safePct(input.market.change_pct, true)}`
  );
  lines.push(
    `北向资金：${
      input.market.northbound_net_yi === null
        ? '—'
        : (input.market.northbound_net_yi >= 0 ? '+' : '') +
          input.market.northbound_net_yi.toFixed(2) +
          ' 亿元'
    }`
  );
  lines.push(`涨停数：${input.market.limit_up_count ?? '—'}`);
  if (input.market.ai_view) {
    lines.push(`AI 大盘观点：${input.market.ai_view}`);
  }
  lines.push('');

  lines.push('## 数据 - 行业归因（按已实现盈亏）');
  if (input.industry_attribution.length > 0) {
    for (const r of input.industry_attribution.slice(0, 5)) {
      lines.push(
        `- ${r.industry}：${r.pnl >= 0 ? '+' : ''}${safeMoney(r.pnl)} 元（${r.trade_count} 笔）`
      );
    }
  } else {
    lines.push('（今日无平仓单 — 暂无行业归因）');
  }
  lines.push('');

  lines.push('## 数据 - 风控告警');
  if (input.risk_alerts.length > 0) {
    for (const a of input.risk_alerts) {
      lines.push(`- [${a.level}] ${a.symbol} ${a.rule_id}：${a.message}`);
    }
  } else {
    lines.push('（无）');
  }
  lines.push('');

  lines.push('## 数据 - 明日候选 (策略生成)');
  if (input.tomorrow_candidates.length > 0) {
    lines.push(input.tomorrow_candidates.join('、'));
  } else {
    lines.push('（暂无策略候选）');
  }
  lines.push('');

  lines.push(
    '请基于上述数据写一篇约 400-700 字、5 段 ## 子标题的复盘日记，重点：'
  );
  lines.push('1. 今日战报：盈亏概况与市场环境关联；');
  lines.push('2. 操作复盘：每笔买卖逻辑是否成立，是否存在追高/止损迟滞等失误，用 OK 或 WARN 明确标注；');
  lines.push('3. 明日策略：给出 2-5 只候选标的（从明日候选名单中选，无则说无），附简要理由；');
  lines.push('4. 市场观察：简洁背景；');
  lines.push('5. 风险提醒：指向今日仓位的具体风险点。只输出 markdown，不要代码块前缀。'
  );
  return lines.join('\n');
}

/**
 * 启发式 fallback — TradingAgents 远端不可用时生成基础版 5 段 markdown。
 *
 * 不依赖任何远端调用 / 概率模型；纯从 input 数据机械拼装。
 *
 * **设计原则**：fallback 内容**仍可读** + **不撒谎** —— 没有数据时显式写 "无 / 暂无"。
 */
export function buildHeuristicMarkdown(input: JournalGenerationInput): JournalGenerationOutput {
  const pnlSign = input.pnl.pnl_today > 0 ? '+' : input.pnl.pnl_today < 0 ? '' : '';
  const pctText =
    input.pnl.pnl_today_pct !== null
      ? ` (${input.pnl.pnl_today_pct >= 0 ? '+' : ''}${safePct(input.pnl.pnl_today_pct)})`
      : '';
  const sentiment = input.pnl.pnl_today > 0 ? '盈利' : input.pnl.pnl_today < 0 ? '回撤' : '持平';

  const todayBattle = [
    '## 今日战报',
    `${input.trade_date} 持仓与现金合计 ${safeMoney(
      input.pnl.total_value
    )} 元，相比昨收 ${safeMoney(input.pnl.prev_total_value)} 元，` +
      `${sentiment} ${pnlSign}${safeMoney(input.pnl.pnl_today)} 元${pctText}。`,
    `持仓市值 ${safeMoney(input.pnl.position_value)} 元，可用现金 ${safeMoney(
      input.pnl.current_cash
    )} 元。`,
    `今日成交 ${input.buy_count} 笔买入 / ${input.sell_count} 笔卖出。`,
  ];

  const operationLines: string[] = ['## 操作复盘'];
  if (input.trades_buy.length === 0 && input.trades_sell.length === 0) {
    operationLines.push('今日无交易，处于观望状态。');
  } else {
    if (input.trades_buy.length > 0) {
      operationLines.push('**买入明细：**');
      for (const t of input.trades_buy) {
        operationLines.push(
          `- ${t.symbol} ${t.name} ${t.quantity} 股 @ ${safeMoney(
            t.execute_price
          )} 元（小计 ${safeMoney(t.amount)} 元）`
        );
      }
    }
    if (input.trades_sell.length > 0) {
      operationLines.push('**卖出明细：**');
      for (const t of input.trades_sell) {
        const pnl =
          t.realized_pnl !== undefined && t.realized_pnl !== null
            ? `（实现盈亏 ${t.realized_pnl >= 0 ? '+' : ''}${safeMoney(t.realized_pnl)} 元）`
            : '';
        operationLines.push(
          `- ${t.symbol} ${t.name} ${t.quantity} 股 @ ${safeMoney(t.execute_price)} 元${pnl}`
        );
      }
    }
    if (input.industry_attribution.length > 0) {
      operationLines.push('**行业归因 (已平仓)：**');
      for (const r of input.industry_attribution.slice(0, 5)) {
        operationLines.push(
          `- ${r.industry}：${r.pnl >= 0 ? '+' : ''}${safeMoney(r.pnl)} 元（${r.trade_count} 笔）`
        );
      }
    }

    // 失误判断 — 基于已实现盈亏自动分析操作质量
    const lossSells = input.trades_sell.filter(
      t => t.realized_pnl !== undefined && t.realized_pnl !== null && t.realized_pnl < 0
    );
    const profitSells = input.trades_sell.filter(
      t => t.realized_pnl !== undefined && t.realized_pnl !== null && t.realized_pnl > 0
    );
    operationLines.push('');
    operationLines.push('**操作质量评估：**');
    if (input.trades_buy.length === 0 && input.trades_sell.length === 0) {
      // handled above
    } else if (lossSells.length === 0 && input.trades_sell.length > 0) {
      operationLines.push('✅ 今日所有平仓均盈利，无明显操作失误。');
    } else if (lossSells.length > 0) {
      operationLines.push(`⚠️ 今日出现 ${lossSells.length} 笔亏损平仓：`);
      for (const t of lossSells) {
        const lossAmt = safeMoney(Math.abs(t.realized_pnl as number));
        operationLines.push(`- ${t.symbol} ${t.name} 亏损 ${lossAmt} 元 — 需复盘是否存在追高买入或止损迟滞。`);
      }
      if (lossSells.length >= 2) {
        operationLines.push('建议：多笔亏损可能反映仓位管理或行情判断存在系统性偏差，注意控制下次单笔仓位。');
      }
    } else if (input.trades_buy.length > 0 && input.trades_sell.length === 0) {
      // 只有买入无卖出，当日 PnL 来自浮亏/浮盈
      if (input.pnl.pnl_today < 0) {
        operationLines.push('⚠️ 今日浮亏，买入标的出现回撤，需评估买点是否选在相对高位。');
      } else if (input.pnl.pnl_today > 0) {
        operationLines.push('✅ 今日买入后浮盈，买入时机较好。');
      } else {
        operationLines.push('今日新建仓位，暂无平仓参考，持续观察中。');
      }
    } else if (profitSells.length > 0 && lossSells.length === 0) {
      operationLines.push('✅ 所有卖出操作均实现盈利，操作执行较为准确。');
    }
  }

  const marketLines: string[] = ['## 市场观察'];
  if (input.market.today_close !== null && input.market.prev_close !== null) {
    marketLines.push(
      `沪深300 指数 ${input.market.prev_close} → ${input.market.today_close}（${
        input.market.change_pct === null
          ? '—'
          : (input.market.change_pct >= 0 ? '+' : '') + safePct(input.market.change_pct)
      }）。`
    );
  } else {
    marketLines.push('沪深300 指数数据暂缺。');
  }
  if (input.market.northbound_net_yi !== null) {
    marketLines.push(
      `北向资金 ${
        input.market.northbound_net_yi >= 0
          ? '净流入 ' + input.market.northbound_net_yi.toFixed(2)
          : '净流出 ' + Math.abs(input.market.northbound_net_yi).toFixed(2)
      } 亿元。`
    );
  }
  if (input.market.limit_up_count !== null) {
    marketLines.push(`昨日全市场涨停 ${input.market.limit_up_count} 家。`);
  }
  if (input.market.ai_view) {
    marketLines.push(`AI 大盘观点：${input.market.ai_view}`);
  }

  const actionLines: string[] = ['## 明日策略'];
  if (input.tomorrow_candidates.length > 0) {
    actionLines.push(`策略生成关注名单：${input.tomorrow_candidates.slice(0, 10).join('、')}`);
    actionLines.push('建议根据上述名单结合个人风险偏好分批建仓，控制单股不超过总仓位 20%。');
  } else {
    actionLines.push('今日策略未给出明确候选，建议保持观望或维持既有持仓。');
  }
  if (input.pnl.pnl_today_pct !== null && input.pnl.pnl_today_pct < -2) {
    actionLines.push('当日回撤超过 2%，明日可减仓 1-2 只表现最弱的持仓以控风险。');
  }

  const riskLines: string[] = ['## 风险提醒'];
  if (input.risk_alerts.length > 0) {
    for (const a of input.risk_alerts) {
      riskLines.push(`- **[${a.level}]** ${a.symbol} ${a.rule_id}：${a.message}`);
    }
  } else {
    riskLines.push('当前无活跃风控告警，但仍需关注：');
    riskLines.push('- 持仓集中度是否过 35%（行业 / 个股）');
    riskLines.push('- 是否设置止损止盈线');
    riskLines.push('- 留意明日开盘前重要公告 / 业绩预告');
  }

  const sections = [
    todayBattle.join('\n'),
    operationLines.join('\n'),
    marketLines.join('\n'),
    actionLines.join('\n'),
    riskLines.join('\n'),
  ];

  const markdown = sections.join('\n\n');

  // 拆分用作 3 字段 — market_summary = 战报 + 市场观察，
  // portfolio_analysis = 操作复盘，action_plan = 明日策略 + 风险提醒
  const marketSummary = `${todayBattle.join('\n')}\n\n${marketLines.join('\n')}`;
  const portfolioAnalysis = operationLines.join('\n');
  const actionPlan = `${actionLines.join('\n')}\n\n${riskLines.join('\n')}`;

  return {
    market_summary: marketSummary,
    portfolio_analysis: portfolioAnalysis,
    action_plan: actionPlan,
    tags: buildHeuristicTags(input),
    mood: pickHeuristicMood(input.pnl),
    nlp_engine: NLP_ENGINES.HEURISTIC,
    ...({ _full_markdown: markdown } as any),
  };
}

/**
 * 启发式心情判断 — 基于当日盈亏百分比。
 * AC 要求 mood 字段，便于前端 Calendar badge 区分。
 */
export function pickHeuristicMood(pnl: JournalPnLSummary): string {
  if (pnl.pnl_today_pct === null) return DEFAULT_MOOD_GENERATED;
  const pct = pnl.pnl_today_pct;
  if (pct >= 3) return '兴奋';
  if (pct >= 1) return '开心';
  if (pct > -1) return '平静';
  if (pct > -3) return '焦虑';
  return '低落';
}

/**
 * 启发式 tag 抽取 — 按交易行为打标签便于回查。
 */
export function buildHeuristicTags(input: JournalGenerationInput): string[] {
  const tags: string[] = [];
  if (input.buy_count > 0) tags.push('买入');
  if (input.sell_count > 0) tags.push('卖出');
  if (input.pnl.pnl_today_pct !== null) {
    if (input.pnl.pnl_today_pct >= 2) tags.push('盈利');
    else if (input.pnl.pnl_today_pct <= -2) tags.push('回撤');
  }
  if (input.risk_alerts.some(a => String(a.level).toUpperCase() === 'HIGH')) tags.push('高风险');
  if (input.tomorrow_candidates.length === 0 && input.buy_count === 0) tags.push('观望');
  if (tags.length === 0) tags.push('日常');
  return tags;
}

/**
 * 解析远端 AI 返回（markdown / mood / tags）；status='FAILED' 时返回 null 让 caller fallback。
 *
 * **4 条防御 (US-060 范式)**：
 *   1. status='FAILED' → null
 *   2. !markdown → null
 *   3. markdown 不含 5 个 ## 段标题 → null（结构不完整 fallback 更安全）
 *   4. tags 非 array → 空数组兜底；mood 非 string → null
 */
export function normalizeAIPayload(
  payload:
    | {
        status?: string;
        markdown?: string;
        mood?: string;
        tags?: string[];
        error?: string;
      }
    | null
    | undefined
): {
  markdown: string;
  mood: string | null;
  tags: string[];
} | null {
  if (!payload) return null;
  const status = String(payload.status || '').toUpperCase();
  if (status === 'FAILED') return null;
  const md = String(payload.markdown || '').trim();
  if (!md) return null;
  // 检查 5 段是否齐全
  const requiredSections = [
    '## 今日战报',
    '## 操作复盘',
    '## 市场观察',
    '## 明日策略',
    '## 风险提醒',
  ];
  const missing = requiredSections.filter(s => !md.includes(s));
  if (missing.length > 0) return null;
  const mood = typeof payload.mood === 'string' && payload.mood.trim() ? payload.mood.trim() : null;
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((t: any) => typeof t === 'string' && t.trim().length > 0)
    : [];
  return { markdown: md, mood, tags };
}

/**
 * 把 AI markdown 拆分成 3 个字段 — market_summary / portfolio_analysis / action_plan。
 *
 * 切分逻辑：
 *   - market_summary    = 今日战报 + 市场观察
 *   - portfolio_analysis = 操作复盘
 *   - action_plan        = 明日策略 + 风险提醒
 *
 * **缺段时返回原 markdown 作为 market_summary 兜底**（不让前端 3 字段全空）。
 */
export function splitMarkdownToFields(markdown: string): {
  market_summary: string;
  portfolio_analysis: string;
  action_plan: string;
} {
  const sections = parseMarkdownSections(markdown);
  if (sections.size === 0) {
    return {
      market_summary: markdown.trim() || '（AI 输出为空）',
      portfolio_analysis: '',
      action_plan: '',
    };
  }
  const todayBattle = sections.get('今日战报') || '';
  const operation = sections.get('操作复盘') || '';
  const market = sections.get('市场观察') || '';
  const action = sections.get('明日策略') || '';
  const risk = sections.get('风险提醒') || '';

  return {
    market_summary: joinSections(
      todayBattle ? `## 今日战报\n${todayBattle}` : '',
      market ? `## 市场观察\n${market}` : ''
    ),
    portfolio_analysis: operation ? `## 操作复盘\n${operation}` : '',
    action_plan: joinSections(
      action ? `## 明日策略\n${action}` : '',
      risk ? `## 风险提醒\n${risk}` : ''
    ),
  };
}

/**
 * 把 markdown 按 '## ' 切段返回 Map<标题, body>，标题 trim 去 prefix。
 *
 * 单独 export 便于单测验证。
 */
export function parseMarkdownSections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!markdown || typeof markdown !== 'string') return out;
  const lines = markdown.split('\n');
  let curTitle: string | null = null;
  let curBody: string[] = [];
  for (const raw of lines) {
    const line = raw;
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (curTitle !== null) {
        out.set(curTitle, curBody.join('\n').trim());
      }
      curTitle = m[1].trim();
      curBody = [];
    } else if (curTitle !== null) {
      curBody.push(line);
    }
  }
  if (curTitle !== null) {
    out.set(curTitle, curBody.join('\n').trim());
  }
  return out;
}

function joinSections(...sections: string[]): string {
  return sections.filter(s => s && s.trim().length > 0).join('\n\n');
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

function safeNumber(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v: number): number {
  return Math.round(safeNumber(v) * 100) / 100;
}

function clampInt(v: any, fallback: number, lo: number, hi: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isInteger(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function nowShanghaiDate(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

// ---------------------------------------------------------------------------
// Default DataSource — Sequelize + axios
// ---------------------------------------------------------------------------

export class DefaultEnhancedTradingJournalDataSource implements EnhancedTradingJournalDataSource {
  async listEligibleUsers(opts: { user_id?: number }) {
    const where: any = { is_active: true };
    if (opts.user_id !== undefined) {
      where.id = Number(opts.user_id);
    }
    const users = await User.findAll({
      where,
      attributes: ['id', 'username'],
      raw: true,
    });
    return users.map(u => ({ user_id: (u as any).id, username: (u as any).username }));
  }

  async loadPortfolioSummary(user_id: number) {
    const portfolio = await PaperTradingPortfolio.findOne({ where: { user_id } });
    if (!portfolio) return null;
    const positions = await PaperTradingPosition.findAll({
      where: { portfolio_id: portfolio.id },
    });
    return { portfolio, positions };
  }

  async loadTodayTrades(portfolio_id: number, trade_date: string) {
    const dayStart = moment.tz(trade_date, 'Asia/Shanghai').startOf('day').toDate();
    const dayEnd = moment.tz(trade_date, 'Asia/Shanghai').endOf('day').toDate();
    return PaperTradingTrade.findAll({
      where: {
        portfolio_id,
        created_at: { [Op.gte]: dayStart, [Op.lte]: dayEnd },
      },
      order: [['created_at', 'ASC']],
    });
  }

  async loadRecentSnapshots(portfolio_id: number, limit: number) {
    const rows = (await PaperTradingSnapshot.findAll({
      attributes: ['date', 'total_value'],
      where: { portfolio_id },
      order: [['date', 'DESC']],
      limit,
      raw: true,
    })) as unknown as Array<{ date: string; total_value: number | string }>;
    return rows.map(r => ({ date: r.date, total_value: Number(r.total_value) }));
  }

  async loadMarketSummary(trade_date: string): Promise<JournalMarketSummary> {
    // Lazy require — 避免 cycle 与冷启动加载 MarketBriefService 整个子系统。
    // 失败 fallback to placeholders 让 journal 不被卡在 market summary 故障。
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { marketBriefService } = require('./MarketBriefService');
      const brief = await marketBriefService.computeAndPersist({
        trade_date,
        dry_run: true,
        skip_ai: true,
      });
      const c = brief?.components || {};
      return {
        benchmark_symbol: c.benchmark?.symbol || 'sh.000300',
        prev_close: typeof c.benchmark?.prev_close === 'number' ? c.benchmark.prev_close : null,
        today_close: typeof c.benchmark?.today_open === 'number' ? c.benchmark.today_open : null,
        change_pct:
          typeof c.benchmark?.open_change_pct === 'number' ? c.benchmark.open_change_pct : null,
        northbound_net_yi:
          typeof c.northbound?.net_amount_yi === 'number' ? c.northbound.net_amount_yi : null,
        limit_up_count: typeof c.limit_up?.count === 'number' ? c.limit_up.count : null,
        ai_view: typeof brief?.ai_view === 'string' ? brief.ai_view : null,
        ai_view_engine:
          brief?.nlp_engine === 'trading_agents'
            ? NLP_ENGINES.TRADING_AGENTS
            : brief?.nlp_engine === 'heuristic_fallback'
            ? NLP_ENGINES.HEURISTIC
            : null,
      };
    } catch (err: any) {
      logger.warn(
        `[EnhancedTradingJournal] loadMarketSummary trade_date=${trade_date} 失败: ${
          err?.message || err
        }`
      );
      return {
        benchmark_symbol: 'sh.000300',
        prev_close: null,
        today_close: null,
        change_pct: null,
        northbound_net_yi: null,
        limit_up_count: null,
        ai_view: null,
        ai_view_engine: null,
      };
    }
  }

  async loadRiskAlerts(
    user_id: number,
    trade_date: string,
    limit: number
  ): Promise<JournalRiskAlertRow[]> {
    const dayStart = moment.tz(trade_date, 'Asia/Shanghai').startOf('day').toDate();
    const dayEnd = moment.tz(trade_date, 'Asia/Shanghai').endOf('day').toDate();
    const alerts = await RiskAlert.findAll({
      where: {
        user_id,
        created_at: { [Op.gte]: dayStart, [Op.lte]: dayEnd },
      },
      order: [['created_at', 'DESC']],
      limit: Math.max(limit, 1),
    });
    return alerts.map(a => ({
      level: String((a as any).level || 'LOW').toUpperCase(),
      rule_id: String((a as any).rule_id || 'unknown'),
      symbol: String((a as any).symbol || '—'),
      message: String((a as any).message || '').slice(0, 200),
    }));
  }

  async loadTomorrowCandidates(trade_date: string, limit: number): Promise<string[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { todaySignalsService } = require('./TodaySignalsService');
      const signals = await todaySignalsService.getTodaySignals({
        trade_date,
      });
      const out: string[] = [];
      // 信号优先重构 批5: 明日候选取 ETF 因子轮动 BUY/HOLD (target_weight > 0)
      const etf: any[] = Array.isArray(signals?.etf_rotation?.signals)
        ? signals.etf_rotation.signals
        : [];
      const picks = etf
        .filter(x => x?.action === 'buy' || x?.action === 'hold' || Number(x?.target_weight) > 0)
        .sort((a, b) => Number(b?.score ?? 0) - Number(a?.score ?? 0));
      for (const s of picks) {
        const sym = String(s.etf_code || s.symbol || '').trim();
        if (sym && !out.includes(sym)) out.push(sym);
        if (out.length >= limit) break;
      }
      return out;
    } catch (err: any) {
      logger.warn(
        `[EnhancedTradingJournal] loadTomorrowCandidates trade_date=${trade_date} 失败: ${
          err?.message || err
        }`
      );
      return [];
    }
  }

  async callRemoteAI(prompt: string): Promise<{
    status: 'OK' | 'FAILED';
    markdown?: string;
    mood?: string;
    tags?: string[];
    error?: string;
  }> {
    // audit L-19: 集中常量, 不再硬编码 IP.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TRADING_AGENTS_BASE_URL } = require('../config/externalServices');
    const TRADING_AGENTS_URL = TRADING_AGENTS_BASE_URL;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const axios = require('axios');
      const response = await axios.post(
        `${TRADING_AGENTS_URL}/api/trading-journal`,
        { prompt, target: 'trading_journal_v2' },
        { timeout: 60_000 }
      );
      const data = response?.data || {};
      const status = String(data.status || 'FAILED').toUpperCase();
      if (status !== 'OK' && status !== 'COMPLETED' && status !== 'SUCCESS') {
        return { status: 'FAILED', error: String(data.error || 'remote status non-OK') };
      }
      const payload = data.data || data;
      return {
        status: 'OK',
        markdown: String(payload.markdown || payload.content || '').trim(),
        mood: typeof payload.mood === 'string' ? payload.mood.trim() : undefined,
        tags: Array.isArray(payload.tags) ? payload.tags : undefined,
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      logger.warn(`[EnhancedTradingJournal] callRemoteAI failed: ${msg} — fallback to heuristic`);
      return { status: 'FAILED', error: msg };
    }
  }

  async saveJournal(record: {
    user_id: number;
    trade_date: string;
    market_summary: string;
    portfolio_analysis: string;
    action_plan: string;
    tags: string[];
    mood: string;
    overwrite_hand_edited: boolean;
  }): Promise<{ id: number; persisted: boolean; skip_reason?: string }> {
    const existing = await TradingJournal.findOne({
      where: { user_id: record.user_id, date: record.trade_date },
    });
    if (existing) {
      const existingMood = String((existing as any).mood || '').trim();
      const isHandEdited =
        existingMood &&
        existingMood !== DEFAULT_MOOD_GENERATED &&
        existingMood !== DEFAULT_MOOD_FAILED;
      if (isHandEdited && !record.overwrite_hand_edited) {
        return {
          id: (existing as any).id,
          persisted: false,
          skip_reason: '用户已手动编辑该日记，未覆盖',
        };
      }
      (existing as any).market_summary = record.market_summary;
      (existing as any).portfolio_analysis = record.portfolio_analysis;
      (existing as any).action_plan = record.action_plan;
      (existing as any).tags = record.tags;
      (existing as any).mood = record.mood;
      // 不动 user_notes — 保留用户已追加手记
      await existing.save();
      return { id: (existing as any).id, persisted: true };
    }
    const created = await TradingJournal.create({
      user_id: record.user_id,
      date: record.trade_date,
      market_summary: record.market_summary,
      portfolio_analysis: record.portfolio_analysis,
      action_plan: record.action_plan,
      tags: record.tags,
      mood: record.mood,
      user_notes: [],
    });
    return { id: (created as any).id, persisted: true };
  }
}

export const PRODUCTION_ENHANCED_TRADING_JOURNAL_DATA_SOURCE: EnhancedTradingJournalDataSource =
  new DefaultEnhancedTradingJournalDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EnhancedTradingJournalService {
  private readonly dataSource: EnhancedTradingJournalDataSource;

  constructor(
    dataSource: EnhancedTradingJournalDataSource = PRODUCTION_ENHANCED_TRADING_JOURNAL_DATA_SOURCE
  ) {
    this.dataSource = dataSource;
  }

  /**
   * 主入口 — 批量为所有 is_active 用户生成当日 journal。
   * 任一 user 失败不阻塞其他 user (fail-OPEN per-user try/catch)。
   *
   * 默认 overwrite_hand_edited=false 保守不动用户手编；admin force regen 走 true。
   * 默认 dry_run=false 真写表；UI 预演 / 测试走 true。
   */
  async generateForAll(options: GenerateOptions = {}): Promise<GenerateForAllResult> {
    const tradeDate = options.trade_date || nowShanghaiDate();
    const dryRun = options.dry_run === true;
    const overwriteHandEdited = options.overwrite_hand_edited === true;
    const skipAI = options.skip_ai === true;

    let users: Array<{ user_id: number; username: string }> = [];
    try {
      users = await this.dataSource.listEligibleUsers({ user_id: options.user_id });
    } catch (err: any) {
      logger.error(`[EnhancedTradingJournal] listEligibleUsers 失败: ${err?.message || err}`);
      return {
        trade_date: tradeDate,
        scanned_users: 0,
        generated_count: 0,
        skipped_count: 0,
        failed_count: 0,
        partial_count: 0,
        dry_run: dryRun,
        per_user: [],
      };
    }

    // 市场维度只算一次，全用户共享（指数 / 北向 / 涨停 / AI view 不因 user 而异）
    let market: JournalMarketSummary;
    try {
      market = await this.dataSource.loadMarketSummary(tradeDate);
    } catch (err: any) {
      logger.warn(
        `[EnhancedTradingJournal] loadMarketSummary trade_date=${tradeDate} 失败: ${
          err?.message || err
        }`
      );
      market = {
        benchmark_symbol: 'sh.000300',
        prev_close: null,
        today_close: null,
        change_pct: null,
        northbound_net_yi: null,
        limit_up_count: null,
        ai_view: null,
        ai_view_engine: null,
      };
    }

    // 明日候选也是全用户共享
    let tomorrowCandidates: string[] = [];
    try {
      tomorrowCandidates = await this.dataSource.loadTomorrowCandidates(tradeDate, 10);
    } catch (err: any) {
      logger.warn(
        `[EnhancedTradingJournal] loadTomorrowCandidates trade_date=${tradeDate} 失败: ${
          err?.message || err
        }`
      );
    }

    let generatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let partialCount = 0;
    const perUser: JournalForUserResult[] = [];

    for (const u of users) {
      try {
        const result = await this.generateForUser({
          user_id: u.user_id,
          username: u.username,
          trade_date: tradeDate,
          dry_run: dryRun,
          overwrite_hand_edited: overwriteHandEdited,
          skip_ai: skipAI,
          shared_market: market,
          shared_candidates: tomorrowCandidates,
        });
        perUser.push(result);
        if (result.status === JOURNAL_STATUS.GENERATED) generatedCount += 1;
        else if (result.status === JOURNAL_STATUS.SKIPPED) skippedCount += 1;
        else if (result.status === JOURNAL_STATUS.PARTIAL) partialCount += 1;
        else failedCount += 1;
      } catch (err: any) {
        logger.error(
          `[EnhancedTradingJournal] generateForUser user=${u.user_id} 二重 throw: ${
            err?.message || err
          }`
        );
        failedCount += 1;
        perUser.push({
          journal_id: buildJournalId(u.user_id, tradeDate, randHex4()),
          status: JOURNAL_STATUS.FAILED,
          persisted: false,
          user_id: u.user_id,
          username: u.username,
          trade_date: tradeDate,
          error: String(err?.message || err),
        });
      }
    }

    return {
      trade_date: tradeDate,
      scanned_users: users.length,
      generated_count: generatedCount,
      skipped_count: skippedCount,
      failed_count: failedCount,
      partial_count: partialCount,
      dry_run: dryRun,
      per_user: perUser,
    };
  }

  /**
   * 单用户 journal 生成 + 落库（如未 skip）。
   *
   * 失败不 throw，转 JournalForUserResult.error 返回（fail-OPEN）。
   * 远端 AI 失败自动 fallback 启发式 → status='partial'。
   */
  async generateForUser(options: {
    user_id: number;
    username: string;
    trade_date: string;
    dry_run: boolean;
    overwrite_hand_edited: boolean;
    skip_ai: boolean;
    shared_market?: JournalMarketSummary;
    shared_candidates?: string[];
  }): Promise<JournalForUserResult> {
    const {
      user_id,
      username,
      trade_date,
      dry_run,
      overwrite_hand_edited,
      skip_ai,
      shared_market,
      shared_candidates,
    } = options;
    const journalId = buildJournalId(user_id, trade_date, randHex4());

    // ---- 取 portfolio + positions + trades + snapshots ----
    let summary: { portfolio: PaperTradingPortfolio; positions: PaperTradingPosition[] } | null;
    try {
      summary = await this.dataSource.loadPortfolioSummary(user_id);
    } catch (err: any) {
      logger.warn(
        `[EnhancedTradingJournal] loadPortfolioSummary user=${user_id} 失败: ${err?.message || err}`
      );
      return {
        journal_id: journalId,
        status: JOURNAL_STATUS.FAILED,
        persisted: false,
        user_id,
        username,
        trade_date,
        error: `加载模拟盘失败：${err?.message || err}`,
      };
    }
    if (!summary || !summary.portfolio) {
      return {
        journal_id: journalId,
        status: JOURNAL_STATUS.SKIPPED,
        persisted: false,
        user_id,
        username,
        trade_date,
        skip_reason: '用户尚未建立模拟盘',
      };
    }

    let trades: PaperTradingTrade[] = [];
    try {
      trades = await this.dataSource.loadTodayTrades(summary.portfolio.id, trade_date);
    } catch (err: any) {
      logger.warn(
        `[EnhancedTradingJournal] loadTodayTrades user=${user_id} 失败: ${err?.message || err}`
      );
    }
    const tradeRows: JournalTradeRow[] = trades.map(t => ({
      symbol: (t as any).symbol,
      name: (t as any).name,
      direction: (t as any).direction,
      quantity: Number((t as any).quantity),
      execute_price: Number((t as any).execute_price),
      amount: Number((t as any).amount),
      realized_pnl:
        (t as any).realized_pnl !== null && (t as any).realized_pnl !== undefined
          ? Number((t as any).realized_pnl)
          : null,
      industry: (t as any).industry || null,
    }));

    let snapshots: Array<{ date: string; total_value: number }> = [];
    try {
      snapshots = await this.dataSource.loadRecentSnapshots(summary.portfolio.id, 30);
    } catch (err: any) {
      logger.warn(
        `[EnhancedTradingJournal] loadRecentSnapshots user=${user_id} 失败: ${err?.message || err}`
      );
    }
    const prevSnap = snapshots
      .filter(s => s && s.date && s.date < trade_date)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const prevTotal = prevSnap ? prevSnap.total_value : null;

    const positionsMarketValue = summary.positions.reduce(
      (sum, p) => sum + safeNumber((p as any).market_value),
      0
    );
    const pnl = computeJournalPnLSummary({
      total_value: Number(summary.portfolio.total_value),
      current_cash: Number(summary.portfolio.current_cash),
      initial_capital: Number(summary.portfolio.initial_capital),
      positions_market_value: positionsMarketValue,
      prev_snapshot_total_value: prevTotal,
    });

    const buys = pickTopTrades(tradeRows, 'BUY', DEFAULT_TOP_TRADES_PER_DIRECTION);
    const sells = pickTopTrades(tradeRows, 'SELL', DEFAULT_TOP_TRADES_PER_DIRECTION);
    const buyCount = tradeRows.filter(t => t.direction === 'BUY').length;
    const sellCount = tradeRows.filter(t => t.direction === 'SELL').length;

    let alerts: JournalRiskAlertRow[] = [];
    try {
      const rawAlerts = await this.dataSource.loadRiskAlerts(
        user_id,
        trade_date,
        DEFAULT_TOP_ALERTS
      );
      alerts = pickTopAlerts(rawAlerts, DEFAULT_TOP_ALERTS);
    } catch (err: any) {
      logger.warn(
        `[EnhancedTradingJournal] loadRiskAlerts user=${user_id} 失败: ${err?.message || err}`
      );
    }

    const market =
      shared_market ??
      (await safeAwait(() => this.dataSource.loadMarketSummary(trade_date), {
        benchmark_symbol: 'sh.000300',
        prev_close: null,
        today_close: null,
        change_pct: null,
        northbound_net_yi: null,
        limit_up_count: null,
        ai_view: null,
        ai_view_engine: null,
      }));

    const tomorrowCandidates =
      shared_candidates ??
      (await safeAwait(() => this.dataSource.loadTomorrowCandidates(trade_date, 10), []));

    const input: JournalGenerationInput = {
      user_id,
      username,
      trade_date,
      pnl,
      trades_buy: buys,
      trades_sell: sells,
      buy_count: buyCount,
      sell_count: sellCount,
      market,
      industry_attribution: computeIndustryAttribution(tradeRows),
      risk_alerts: alerts,
      tomorrow_candidates: tomorrowCandidates,
    };

    // ---- 调远端 AI（或 skip） ----
    let output: JournalGenerationOutput;
    let isPartial = false;
    if (skip_ai) {
      output = buildHeuristicMarkdown(input);
      isPartial = true; // skip_ai 视为 partial (启发式 fallback)
    } else {
      const prompt = buildAIPrompt(input);
      let remote: {
        status: 'OK' | 'FAILED';
        markdown?: string;
        mood?: string;
        tags?: string[];
        error?: string;
      };
      try {
        remote = await this.dataSource.callRemoteAI(prompt);
      } catch (err: any) {
        logger.warn(
          `[EnhancedTradingJournal] callRemoteAI user=${user_id} throw: ${err?.message || err}`
        );
        remote = { status: 'FAILED', error: String(err?.message || err) };
      }
      const parsed = remote.status === 'OK' ? normalizeAIPayload(remote) : null;
      if (parsed) {
        const split = splitMarkdownToFields(parsed.markdown);
        output = {
          market_summary: split.market_summary || buildHeuristicMarkdown(input).market_summary,
          portfolio_analysis:
            split.portfolio_analysis || buildHeuristicMarkdown(input).portfolio_analysis,
          action_plan: split.action_plan || buildHeuristicMarkdown(input).action_plan,
          tags: parsed.tags.length > 0 ? parsed.tags : buildHeuristicTags(input),
          mood: parsed.mood || DEFAULT_MOOD_GENERATED,
          nlp_engine: NLP_ENGINES.TRADING_AGENTS,
        };
      } else {
        output = buildHeuristicMarkdown(input);
        isPartial = true;
      }
    }

    if (dry_run) {
      return {
        journal_id: journalId,
        status: isPartial ? JOURNAL_STATUS.PARTIAL : JOURNAL_STATUS.GENERATED,
        persisted: false,
        user_id,
        username,
        trade_date,
        output,
        skip_reason: 'dry_run',
      };
    }

    // ---- 写表 (fail-OPEN) ----
    try {
      const saveRes = await this.dataSource.saveJournal({
        user_id,
        trade_date,
        market_summary: output.market_summary,
        portfolio_analysis: output.portfolio_analysis,
        action_plan: output.action_plan,
        tags: output.tags,
        mood: output.mood,
        overwrite_hand_edited,
      });
      if (!saveRes.persisted) {
        return {
          journal_id: journalId,
          status: JOURNAL_STATUS.SKIPPED,
          persisted: false,
          user_id,
          username,
          trade_date,
          output,
          skip_reason: saveRes.skip_reason || '已存在 hand-edited 版本，未覆盖',
          saved_row_id: saveRes.id,
        };
      }
      return {
        journal_id: journalId,
        status: isPartial ? JOURNAL_STATUS.PARTIAL : JOURNAL_STATUS.GENERATED,
        persisted: true,
        user_id,
        username,
        trade_date,
        output,
        saved_row_id: saveRes.id,
      };
    } catch (err: any) {
      logger.warn(
        `[EnhancedTradingJournal] saveJournal user=${user_id} 失败: ${err?.message || err}`
      );
      return {
        journal_id: journalId,
        status: JOURNAL_STATUS.FAILED,
        persisted: false,
        user_id,
        username,
        trade_date,
        output,
        error: `写入 DB 失败：${err?.message || err}`,
      };
    }
  }
}

async function safeAwait<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export const enhancedTradingJournalService = new EnhancedTradingJournalService();
