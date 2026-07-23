/**
 * DailyAttributionService — L8-Postmortem / US-078 [PM-001] 每日归因主入口
 *
 * 17:00 cron 触发, 对单个 portfolio + 指定 date 输出 6 维归因 (factor / industry /
 * timing / selection / sizing / execution_cost) + best/worst 3 + 静态 AI summary.
 *
 * 本 story (PM-001) 是 L8 链路的"主入口 + 6 维框架 + DataSource DI seam", 真
 * Brinson-Fachler 拆解 (PM-002 / US-079 — 已接入, 见 AttributionEngine.ts) /
 * Model 持久化 (PM-003) / Execution cost aggregator (PM-004) / AIAttributionSummary
 * (PM-005) / cron (PM-006) / route (PM-007) / bias (PM-008) / 飞书 push (PM-009)
 * 由后续 story 各自填充对应 DataSource method 即可, 主入口契约不变.
 *
 * 设计遵循 services/CLAUDE.md 的 DataSource DI 模式 + fail-open 默认:
 *   (1) DailyAttributionDataSource interface 把所有 I/O 抽干净
 *   (2) PRODUCTION_DAILY_ATTRIBUTION_DATA_SOURCE singleton lazy-require
 *       PaperTradingTrade / PaperTradingPosition / PaperTradingSnapshot / Stock
 *   (3) 单测注入 fake DataSource 完整覆盖 happy + 边界 + fail-OPEN 不需起 DB
 *   (4) 主入口 try/catch 顶层兜底 — 归因失败永不阻塞 cron 调度
 *
 * pure helpers (全 export, 独立单测):
 *   - normalizeAttributionDate(d)        — 'YYYY-MM-DD' 规范化 + 默认今日
 *   - normalizeIndustryName(s)           — 与 IndustryAttributionService 同款
 *   - bucketByIndustry(trades, map)      — symbol→industry → 行业聚合 pnl
 *   - topPnL(items, key, n, desc)        — 通用 top-N 选择
 *   - computeExecutionCost(trades)       — 当前 = Σ commission (PM-004 会扩到滑点+印花税)
 *   - computeRealizedPnL(trades)         — 仅 SELL 的 realized_pnl 求和
 *   - computeUnrealizedDelta(snaps, real) — daily_pnl - realized_pnl
 *   - sixDimBreakdown(...)               — 6 维框架, factor/timing/selection/sizing
 *                                          / residual 暂为 placeholder, industry +
 *                                          execution_cost 已可算
 *   - heuristicSummary(report)           — ≤ 200 字静态摘要 (PM-005 替换成 LLM)
 *   - buildDailyAttributionReport(...)   — 主入口纯函数, 接 4 路输入返完整 report
 *
 * 与既有 service 边界:
 *   - PaperTradingAttributionService — 历史每笔聚合 (open/closed); 本 service
 *     是"今日整 portfolio 6 维拆解", 同一份 trade 数据不同视角.
 *   - TradePostmortemService — 单笔 outcome 关闭后 5-bullet; 本 service 是
 *     当日全 portfolio 汇总, 两者互补.
 *   - DailyTradingDigestService — 飞书推送的"账户 + 候选" 简报; 本 service
 *     输出"归因专卡", PM-009 会把本 service 输出挂到飞书 push.
 *
 * 关键不变量 (供 PM-002~009 接入时遵守):
 *   - sum(breakdown.industry_contrib.pnl) + breakdown.selection_contrib +
 *     breakdown.timing_contrib + breakdown.sizing_contrib +
 *     breakdown.factor_contrib_total + breakdown.execution_cost +
 *     breakdown.residual ≈ total_pnl  (容差 ±5%, AC §E.2)
 *   - best_trades / worst_trades 取 top 3, BUY direction 不入 (无 realized pnl)
 *   - ai_summary ≤ 200 字 (heuristic 当前 ~140 字以内)
 */

import { logger } from '../../utils/logger';
import {
  AttributionEngineInput,
  AttributionEngineResult,
  computeBrinsonFachler,
} from './AttributionEngine';
import {
  ExecutionCostBreakdown,
  ExecutionCostInput,
  aggregateExecutionCost,
} from './ExecutionCostAggregator';
import {
  AIAttributionSummaryDataSource,
  generateAIAttributionSummary,
} from './AIAttributionSummary';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS = 200;
export const DAILY_ATTRIBUTION_TOP_TRADE_LIMIT = 3;
export const DAILY_ATTRIBUTION_TOP_INDUSTRY_LIMIT = 5;
export const DAILY_ATTRIBUTION_TOP_FACTOR_LIMIT = 5;

/** 归因失败时的统一 status 枚举, 供 caller 按状态分流. */
export const DAILY_ATTRIBUTION_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const);

export type DailyAttributionStatus =
  (typeof DAILY_ATTRIBUTION_STATUS)[keyof typeof DAILY_ATTRIBUTION_STATUS];

// ---------------------------------------------------------------------------
// 类型 — 与 docs/trader-system/71_attribution_daily.md §B.2 对齐
// ---------------------------------------------------------------------------

export interface DailyAttributionTradeRow {
  id: number;
  portfolio_id: number;
  symbol: string;
  name?: string | null;
  direction: 'BUY' | 'SELL';
  execute_price: number;
  quantity: number;
  amount: number;
  commission: number;
  realized_pnl: number | null;
  /** ISO 字符串 / 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DD' 全兼容 */
  created_at: string;
}

export interface DailyAttributionSnapshotRow {
  date: string; // 'YYYY-MM-DD'
  total_value: number;
  current_cash: number;
  position_value: number;
}

export interface DailyAttributionPositionRow {
  symbol: string;
  name?: string | null;
  quantity: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
}

export interface FactorContribItem {
  factor_key: string;
  pnl: number;
  pct: number;
}

export interface IndustryContribItem {
  industry: string;
  pnl: number;
  pct: number;
  trade_count: number;
}

export interface DailyAttributionBreakdown {
  /** 因子暴露贡献 top N (PM-002 真接入因子模型残差; 当前 placeholder=[]) */
  factor_contrib: FactorContribItem[];
  /** 因子总贡献 (Σ factor_contrib.pnl); 本 story 为 0 占位 */
  factor_contrib_total: number;
  /** 行业 β 贡献 top N (本 story 已可按 symbol→industry 聚合) */
  industry_contrib: IndustryContribItem[];
  /** 时机贡献 (入场/出场相对均价, PM-002) */
  timing_contrib: number;
  /** 行业内 alpha (PM-002) */
  selection_contrib: number;
  /** 权重选择 (PM-002) */
  sizing_contrib: number;
  /** 滑点 + 手续费 + 印花税 (PM-004 真接入; 当前 = Σ commission) */
  execution_cost: number;
  /** PM-004 ExecutionCostAggregator 输出 4 件套 (commission/stamp/transfer/slippage);
   *  caller 未传 execution_cost_input 时为 null, 保持 PM-001 老 caller 全兼容. */
  execution_cost_breakdown: ExecutionCostBreakdown | null;
  /** 残差 (运气) = total_pnl - sum(其它维度) */
  residual: number;
}

export interface BestWorstTradeSummary {
  id: number;
  symbol: string;
  name?: string | null;
  realized_pnl: number;
  realized_pnl_pct?: number | null;
  amount: number;
  quantity: number;
}

export interface DailyAttributionReport {
  date: string;
  portfolio_id: number;
  total_pnl: number;
  total_pnl_pct: number | null;
  realized_pnl: number;
  unrealized_delta: number;
  trade_count: number;
  buy_count: number;
  sell_count: number;
  breakdown: DailyAttributionBreakdown;
  best_trades: BestWorstTradeSummary[];
  worst_trades: BestWorstTradeSummary[];
  ai_summary: string;
  bias_findings: unknown[]; // PM-008 BehaviorBiasDetector.detectIncremental 填
  recommendations: string[]; // PM-005/008 填
  generated_at: string;
}

export interface DailyAttributionRunResult {
  status: DailyAttributionStatus;
  /** ok: 完整 report; skipped/failed: null */
  report: DailyAttributionReport | null;
  /** skipped / failed 时的原因 (e.g. 'no_snapshot' / 'db_error') */
  reason?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// DataSource DI seam — PM-002~009 各自填充对应方法
// ---------------------------------------------------------------------------

export interface DailyAttributionDataSource {
  /** 当日所有 trade (anchor date + previous 1 day, 为 prev_close 计算预留) */
  loadTrades(portfolio_id: number, date: string): Promise<DailyAttributionTradeRow[]>;
  /** anchor date 当日 + 前一最近一日的 snapshot, 用于算 daily_pnl */
  loadSnapshots(portfolio_id: number, date: string): Promise<DailyAttributionSnapshotRow[]>;
  /** anchor date 收盘 EOD positions */
  loadPositions(portfolio_id: number, date: string): Promise<DailyAttributionPositionRow[]>;
  /** symbol → industry name 映射; 未知归 '其它' */
  loadSymbolIndustryMap(symbols: string[]): Promise<Record<string, string>>;
}

// 默认 PRODUCTION DataSource — lazy require 让单测进程不需要 sequelize 起 DB
// 即可加载本 service 文件; 真在 prod 环境跑时由 caller 调 createProductionDataSource().
export function createProductionDailyAttributionDataSource(): DailyAttributionDataSource {
  return {
    async loadTrades(portfolio_id, date) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingTrade } = require('../../models/PaperTradingTrade');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const prev = previousDayString(date);
        const rows = await PaperTradingTrade.findAll({
          where: {
            portfolio_id,
            created_at: {
              [Op.gte]: `${prev} 00:00:00`,
              [Op.lt]: nextDayString(date) + ' 00:00:00',
            },
          },
          raw: true,
        });
        return (rows as DailyAttributionTradeRow[]).map(r => ({
          id: r.id,
          portfolio_id: r.portfolio_id,
          symbol: String(r.symbol),
          name: r.name ?? null,
          direction: r.direction,
          execute_price: Number(r.execute_price ?? 0),
          quantity: Number(r.quantity ?? 0),
          amount: Number(r.amount ?? 0),
          commission: Number(r.commission ?? 0),
          realized_pnl: r.realized_pnl == null ? null : Number(r.realized_pnl),
          created_at: String(r.created_at),
        }));
      } catch (err) {
        logger.warn(
          `[daily-attribution] loadTrades portfolio=${portfolio_id} date=${date} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
    async loadSnapshots(portfolio_id, date) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingSnapshot } = require('../../models/PaperTradingSnapshot');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const rows = await PaperTradingSnapshot.findAll({
          where: {
            portfolio_id,
            date: { [Op.lte]: date },
          },
          order: [['date', 'DESC']],
          limit: 2,
          raw: true,
        });
        return (rows as DailyAttributionSnapshotRow[]).map(r => ({
          date: String(r.date),
          total_value: Number(r.total_value ?? 0),
          current_cash: Number(r.current_cash ?? 0),
          position_value: Number(r.position_value ?? 0),
        }));
      } catch (err) {
        logger.warn(
          `[daily-attribution] loadSnapshots portfolio=${portfolio_id} date=${date} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
    async loadPositions(portfolio_id, _date) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingPosition } = require('../../models/PaperTradingPosition');
        const rows = await PaperTradingPosition.findAll({
          where: { portfolio_id },
          raw: true,
        });
        return (rows as DailyAttributionPositionRow[]).map(r => ({
          symbol: String(r.symbol),
          name: r.name ?? null,
          quantity: Number(r.quantity ?? 0),
          avg_cost: Number(r.avg_cost ?? 0),
          current_price: Number(r.current_price ?? 0),
          market_value: Number(r.market_value ?? 0),
          unrealized_pnl: Number(r.unrealized_pnl ?? 0),
        }));
      } catch (err) {
        logger.warn(
          `[daily-attribution] loadPositions portfolio=${portfolio_id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
    async loadSymbolIndustryMap(symbols) {
      const map: Record<string, string> = {};
      if (!Array.isArray(symbols) || symbols.length === 0) return map;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Stock } = require('../../models/Stock');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const rows = await Stock.findAll({
          where: { symbol: { [Op.in]: symbols } },
          attributes: ['symbol', 'industry'],
          raw: true,
        });
        for (const s of rows as Array<{ symbol: string; industry?: string | null }>) {
          if (typeof s.symbol === 'string') {
            map[s.symbol] = normalizeIndustryName(s.industry);
          }
        }
      } catch (err) {
        logger.warn(
          `[daily-attribution] loadSymbolIndustryMap failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      return map;
    },
  };
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 归一化日期到 'YYYY-MM-DD'; 非法返今日 (Asia/Shanghai). */
export function normalizeAttributionDate(d: unknown): string {
  if (typeof d === 'string' && DATE_RE.test(d)) return d;
  if (typeof d === 'string' && d.length >= 10 && DATE_RE.test(d.slice(0, 10))) {
    return d.slice(0, 10);
  }
  // 手动补跑可能发生在上海凌晨，此时 UTC 仍是前一日；统一按业务时区取日界线。
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 与 IndustryAttributionService 同款 — 空/null 归 '其它'. */
export function normalizeIndustryName(s: unknown): string {
  if (typeof s !== 'string') return '其它';
  const t = s.trim();
  return t.length > 0 ? t : '其它';
}

/** 从 'YYYY-MM-DD HH:mm:ss' / ISO / 'YYYY-MM-DD' 抽日期部分; 非法返空串. */
export function extractTradeDate(value: unknown): string {
  if (typeof value !== 'string' || value.length < 10) return '';
  const head = value.slice(0, 10);
  return DATE_RE.test(head) ? head : '';
}

function previousDayString(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextDayString(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 按 symbol→industry 映射把 trades 聚合到行业桶, 返桶数组 (未排序). */
export function bucketByIndustry(
  trades: DailyAttributionTradeRow[],
  symbolToIndustry: Record<string, string>
): IndustryContribItem[] {
  const buckets = new Map<string, { pnl: number; count: number }>();
  for (const t of trades) {
    if (t.direction !== 'SELL') continue;
    if (t.realized_pnl == null) continue;
    const pnl = Number(t.realized_pnl);
    if (!Number.isFinite(pnl)) continue;
    const ind = normalizeIndustryName(symbolToIndustry[t.symbol]);
    const cur = buckets.get(ind) || { pnl: 0, count: 0 };
    cur.pnl += pnl;
    cur.count += 1;
    buckets.set(ind, cur);
  }
  const out: IndustryContribItem[] = [];
  for (const [industry, v] of buckets.entries()) {
    out.push({ industry, pnl: v.pnl, pct: 0, trade_count: v.count });
  }
  return out;
}

/** 在 buckets 上填 pct 字段 (相对 base, base<=0 时 pct=0). 返新数组按 |pnl| 降序. */
export function rankIndustryContrib(
  buckets: IndustryContribItem[],
  base: number,
  limit = DAILY_ATTRIBUTION_TOP_INDUSTRY_LIMIT
): IndustryContribItem[] {
  const safeBase = Number.isFinite(base) && base !== 0 ? base : 0;
  const enriched = buckets.map(b => ({
    industry: b.industry,
    pnl: round2(b.pnl),
    pct: safeBase !== 0 ? round4((b.pnl / Math.abs(safeBase)) * 100) : 0,
    trade_count: b.trade_count,
  }));
  enriched.sort(
    (a, b) => Math.abs(b.pnl) - Math.abs(a.pnl) || a.industry.localeCompare(b.industry)
  );
  return enriched.slice(0, Math.max(1, limit));
}

/** 当前 PM-001 = Σ commission. PM-004 ExecutionCostAggregator 会扩到滑点 + 印花税. */
export function computeExecutionCost(trades: DailyAttributionTradeRow[]): number {
  let total = 0;
  for (const t of trades) {
    const c = Number(t.commission);
    if (Number.isFinite(c) && c > 0) total += c;
  }
  return round2(total);
}

/** 仅 SELL 的 realized_pnl 求和; null/NaN 跳过. */
export function computeRealizedPnL(trades: DailyAttributionTradeRow[]): number {
  let total = 0;
  for (const t of trades) {
    if (t.direction !== 'SELL') continue;
    if (t.realized_pnl == null) continue;
    const pnl = Number(t.realized_pnl);
    if (!Number.isFinite(pnl)) continue;
    total += pnl;
  }
  return round2(total);
}

/** snapshots[0] (anchor) - snapshots[1] (prev). 不足 2 条返 NaN. */
export function computeDailyPnL(snapshots: DailyAttributionSnapshotRow[]): {
  pnl: number;
  pct: number | null;
  anchor?: DailyAttributionSnapshotRow;
  prev?: DailyAttributionSnapshotRow;
} {
  if (!Array.isArray(snapshots) || snapshots.length < 2) {
    return { pnl: NaN, pct: null };
  }
  // 来源 DESC 排序; 防 caller 没排, 这里再排一次
  const sorted = [...snapshots].sort((a, b) => (a.date < b.date ? 1 : -1));
  const anchor = sorted[0];
  const prev = sorted[1];
  const pnl = Number(anchor.total_value) - Number(prev.total_value);
  const pct = Number(prev.total_value) > 0 ? round4((pnl / Number(prev.total_value)) * 100) : null;
  return { pnl: round2(pnl), pct, anchor, prev };
}

/** 通用 top-N (按 realized_pnl 排) — desc=true → best, false → worst. */
export function topPnL(
  trades: DailyAttributionTradeRow[],
  desc: boolean,
  limit = DAILY_ATTRIBUTION_TOP_TRADE_LIMIT
): BestWorstTradeSummary[] {
  const filtered: BestWorstTradeSummary[] = [];
  for (const t of trades) {
    if (t.direction !== 'SELL') continue;
    if (t.realized_pnl == null) continue;
    const pnl = Number(t.realized_pnl);
    if (!Number.isFinite(pnl) || pnl === 0) continue;
    if (desc && pnl <= 0) continue;
    if (!desc && pnl >= 0) continue;
    filtered.push({
      id: t.id,
      symbol: t.symbol,
      name: t.name ?? null,
      realized_pnl: round2(pnl),
      realized_pnl_pct: t.amount > 0 ? round4((pnl / Number(t.amount)) * 100) : null,
      amount: Number(t.amount ?? 0),
      quantity: Number(t.quantity ?? 0),
    });
  }
  filtered.sort((a, b) =>
    desc ? b.realized_pnl - a.realized_pnl : a.realized_pnl - b.realized_pnl
  );
  return filtered.slice(0, Math.max(1, limit));
}

/**
 * 6 维框架. 当前 PM-001:
 *   - industry_contrib / industry_total — 已按行业聚合
 *   - execution_cost — Σ commission
 *   - residual — total_pnl - industry_total - execution_cost (其它 4 维占位)
 *   - factor_contrib / timing / selection / sizing — 全 0 placeholder
 * PM-002 (AttributionEngine) 真接入 Brinson-Fachler 后改 residual 公式即可.
 *
 * PM-002 接入 (US-079): 当 caller 传入 attribution_engine_result 时,
 *   - sizing_contrib    ← allocation_contrib  (行业 β over/underweight)
 *   - selection_contrib ← selection_contrib   (行业内 α)
 *   - timing_contrib    ← interaction_contrib (交叉项)
 *   - residual 重算 = total - industry - allocation - selection - interaction + execution_cost
 *   让 AC §E.2 ±5% 不变量 trivially 成立.
 *
 * PM-004 接入 (US-081): 当 caller 传入 execution_cost_input 时, execution_cost 走
 * ExecutionCostAggregator 输出 total_cost (commission_total + slippage_total),
 * 同时把分项 ExecutionCostBreakdown 挂在 breakdown.execution_cost_breakdown 上.
 * caller 不传则保持 PM-001 老逻辑 = Σ commission, breakdown=null.
 */
export function sixDimBreakdown(input: {
  trades: DailyAttributionTradeRow[];
  symbolToIndustry: Record<string, string>;
  totalPnL: number;
  attribution_engine_result?: AttributionEngineResult | null;
  execution_cost_input?: ExecutionCostInput | null;
}): DailyAttributionBreakdown {
  const { trades, symbolToIndustry, totalPnL, attribution_engine_result, execution_cost_input } =
    input;
  const buckets = bucketByIndustry(trades, symbolToIndustry);
  const industry_contrib = rankIndustryContrib(buckets, totalPnL);
  const industry_total = buckets.reduce((s, b) => s + b.pnl, 0);
  // PM-004 — caller 传 execution_cost_input 时用 aggregator (含 slippage), 否则
  // 保持 PM-001 老逻辑 = Σ commission. breakdown 字段在前者下挂分项, 否则 null.
  const execution_cost_breakdown: ExecutionCostBreakdown | null = execution_cost_input
    ? aggregateExecutionCost(execution_cost_input)
    : null;
  const execution_cost = execution_cost_breakdown
    ? execution_cost_breakdown.total_cost
    : computeExecutionCost(trades);
  const safeTotal = Number.isFinite(totalPnL) ? totalPnL : 0;
  // PM-002 4 维 — caller 传 engine_result 时填真值, 否则 placeholder=0 兼容 PM-001
  const allocation = attribution_engine_result
    ? safeNumber(attribution_engine_result.allocation_contrib)
    : 0;
  const selection = attribution_engine_result
    ? safeNumber(attribution_engine_result.selection_contrib)
    : 0;
  const interaction = attribution_engine_result
    ? safeNumber(attribution_engine_result.interaction_contrib)
    : 0;
  // residual = total - industry - 4 维 - execution_cost; execution_cost 是支出 (正值列存),
  // 物理上拉低 total 故 residual 公式 += execution_cost 抵消.
  const residual = round2(
    safeTotal - industry_total - allocation - selection - interaction + execution_cost
  );
  return {
    factor_contrib: [],
    factor_contrib_total: 0,
    industry_contrib,
    timing_contrib: round2(interaction),
    selection_contrib: round2(selection),
    sizing_contrib: round2(allocation),
    execution_cost,
    execution_cost_breakdown,
    residual,
  };
}

/**
 * ≤ 200 字静态摘要. PM-005 (AIAttributionSummary) 替换成 LLM 生成. 当前
 * 包含 3 条具体数字 (AC §E.3) — total_pnl + top 行业 + execution_cost.
 */
export function heuristicSummary(report: DailyAttributionReport): string {
  const lines: string[] = [];
  const sign = report.total_pnl > 0 ? '+' : '';
  const pctStr = report.total_pnl_pct == null ? '—' : `${report.total_pnl_pct.toFixed(2)}%`;
  lines.push(`${report.date} 总盈亏 ${sign}${report.total_pnl.toFixed(2)} 元 (${pctStr})`);
  const topIndustry = report.breakdown.industry_contrib[0];
  if (topIndustry) {
    const indSign = topIndustry.pnl >= 0 ? '+' : '';
    lines.push(`主贡献行业 ${topIndustry.industry} ${indSign}${topIndustry.pnl.toFixed(2)} 元`);
  }
  if (report.breakdown.execution_cost > 0) {
    lines.push(`执行成本 ${report.breakdown.execution_cost.toFixed(2)} 元`);
  }
  lines.push(`成交 ${report.trade_count} 笔 (买${report.buy_count}/卖${report.sell_count})`);
  let out = lines.join('; ');
  if (out.length > DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS) {
    out = out.slice(0, DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS - 1) + '…';
  }
  return out;
}

/**
 * 主入口纯函数. 接 4 路输入 (trades / snapshots / positions / industry map) +
 * portfolio_id + date → 完整 6 维 report.
 *
 * PM-002 接入 (US-079): 可选传 `attribution_engine_input` (含 industry-level
 * portfolio/benchmark weight + return). 传了就调 Brinson-Fachler engine 把
 * sizing/selection/timing 4 维填真值; 不传保持 PM-001 placeholder=0 行为.
 *
 * PM-004 接入 (US-081): 可选传 `execution_cost_input` (含 trades + ref_prices),
 * 让 execution_cost 走 ExecutionCostAggregator (含 slippage + 分项 breakdown);
 * 不传则 execution_cost 走 PM-001 老逻辑 = Σ commission.
 *
 * 默认 (caller 未显式 opt-out) 用当日 tradesToday 自动构 ExecutionCostInput
 * 让 breakdown 4 件套始终可见; ref_prices 没传 slippage_total=0 (覆盖率 0) —
 * caller 视为"暂无滑点数据"渲染即可, 仍优于 PM-001 完全没分项.
 */
export function buildDailyAttributionReport(input: {
  portfolio_id: number;
  date: string;
  trades: DailyAttributionTradeRow[];
  snapshots: DailyAttributionSnapshotRow[];
  positions: DailyAttributionPositionRow[];
  symbolToIndustry: Record<string, string>;
  generated_at?: string;
  attribution_engine_input?: AttributionEngineInput | null;
  execution_cost_input?: ExecutionCostInput | null;
}): DailyAttributionReport {
  const anchorDate = normalizeAttributionDate(input.date);
  // 仅保留 anchor date 当日的 trade
  const tradesToday = (input.trades || []).filter(
    t => extractTradeDate(t.created_at) === anchorDate
  );
  const { pnl, pct } = computeDailyPnL(input.snapshots || []);
  const totalPnL = Number.isFinite(pnl) ? pnl : 0;
  const realized = computeRealizedPnL(tradesToday);
  const engineResult = input.attribution_engine_input
    ? computeBrinsonFachler(input.attribution_engine_input)
    : null;
  // PM-004 — caller 显式传 input.execution_cost_input 时尊重 (含可能的 ref_prices);
  //          caller 未传 (undefined) 时默认用 tradesToday 构最小 input, 让 breakdown
  //          4 件套始终可见 (slippage_total=0 当 ref_prices 缺失, 仍优于 PM-001 完全无分项);
  //          caller 显式传 null 时关闭 aggregator → 退到 PM-001 老逻辑 (breakdown=null).
  const executionCostInput: ExecutionCostInput | null =
    input.execution_cost_input === undefined
      ? {
          trades: tradesToday.map(t => ({
            symbol: t.symbol,
            side: t.direction,
            quantity: Number(t.quantity ?? 0),
            execute_price: Number(t.execute_price ?? 0),
            amount: Number(t.amount ?? 0),
            commission: Number(t.commission ?? 0),
          })),
        }
      : input.execution_cost_input;
  const breakdown = sixDimBreakdown({
    trades: tradesToday,
    symbolToIndustry: input.symbolToIndustry || {},
    totalPnL,
    attribution_engine_result: engineResult,
    execution_cost_input: executionCostInput,
  });
  const buyCount = tradesToday.filter(t => t.direction === 'BUY').length;
  const sellCount = tradesToday.filter(t => t.direction === 'SELL').length;
  const report: DailyAttributionReport = {
    date: anchorDate,
    portfolio_id: input.portfolio_id,
    total_pnl: round2(totalPnL),
    total_pnl_pct: pct,
    realized_pnl: realized,
    unrealized_delta: round2(totalPnL - realized),
    trade_count: tradesToday.length,
    buy_count: buyCount,
    sell_count: sellCount,
    breakdown,
    best_trades: topPnL(tradesToday, true),
    worst_trades: topPnL(tradesToday, false),
    ai_summary: '',
    bias_findings: [],
    recommendations: [],
    generated_at: input.generated_at || new Date().toISOString(),
  };
  report.ai_summary = heuristicSummary(report);
  return report;
}

// ---------------------------------------------------------------------------
// service 主入口 — caller 走这里
// ---------------------------------------------------------------------------

export interface GenerateDailyReportOptions {
  data_source?: DailyAttributionDataSource;
  /** 'YYYY-MM-DD'; 默认今日 (Asia/Shanghai) */
  date?: string;
  /** override generated_at (单测用) */
  generated_at?: string;
  /**
   * PM-002 接入: caller (e.g. cron) 准备好 industry-level benchmark + return 后
   * 传入, 让 Brinson-Fachler engine 填 sizing/selection/timing 真值.
   * 不传保持 PM-001 placeholder=0 行为.
   */
  attribution_engine_input?: AttributionEngineInput | null;
  /**
   * PM-004 接入: caller 准备好 symbol→arrival/VWAP 参考价 map 后传入完整
   * ExecutionCostInput, 让 execution_cost 含滑点 + 输出分项 breakdown. 不传
   * 时 buildDailyAttributionReport 用当日 trades 构最小 input (slippage_total=0).
   * 显式传 null 则关闭 aggregator (退到 PM-001 老 Σ commission 路径).
   */
  execution_cost_input?: ExecutionCostInput | null;
  /**
   * PM-005 接入 (US-082): caller 传入 LLM DataSource 后,
   * ai_summary 走 generateAIAttributionSummary (LLM → 校验 → 不达标 fallback
   * 到 PM-001 heuristicSummary). 不传或 null → ai_summary 仍走 heuristic.
   *
   * 显式 'off' 字符串可强制关闭 (caller 想跑零 AI 链路时用).
   */
  ai_summary_source?: AIAttributionSummaryDataSource | null | 'off';
}

export class DailyAttributionService {
  private readonly defaultSource: DailyAttributionDataSource;

  constructor(defaultSource?: DailyAttributionDataSource) {
    this.defaultSource = defaultSource || createProductionDailyAttributionDataSource();
  }

  /**
   * 对单个 portfolio + date 生成 6 维归因报告.
   *
   * fail-OPEN 契约: 任何异常 (DB / network / programmer error) → 返
   * status='failed' + reason='db_error', 永不 throw.
   */
  async generateDailyReport(
    portfolio_id: number,
    options: GenerateDailyReportOptions = {}
  ): Promise<DailyAttributionRunResult> {
    const source = options.data_source || this.defaultSource;
    const date = normalizeAttributionDate(options.date);
    try {
      const [trades, snapshots, positions] = await Promise.all([
        source.loadTrades(portfolio_id, date),
        source.loadSnapshots(portfolio_id, date),
        source.loadPositions(portfolio_id, date),
      ]);
      if (!Array.isArray(snapshots) || snapshots.length < 2) {
        return {
          status: DAILY_ATTRIBUTION_STATUS.SKIPPED,
          report: null,
          reason: 'no_prev_snapshot',
        };
      }
      const symbols = Array.from(
        new Set(
          (trades || [])
            .map(t => t.symbol)
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
            .concat(
              (positions || [])
                .map(p => p.symbol)
                .filter((s): s is string => typeof s === 'string' && s.length > 0)
            )
        )
      );
      const symbolToIndustry =
        symbols.length > 0 ? await source.loadSymbolIndustryMap(symbols) : {};
      const report = buildDailyAttributionReport({
        portfolio_id,
        date,
        trades: trades || [],
        snapshots: snapshots || [],
        positions: positions || [],
        symbolToIndustry: symbolToIndustry || {},
        generated_at: options.generated_at,
        attribution_engine_input: options.attribution_engine_input ?? null,
        // PM-004 — 显式传 null/value 时透传; undefined 时不进 key 让 builder 走
        // 默认行为 (auto-build from trades, slippage_total=0).
        ...(Object.prototype.hasOwnProperty.call(options, 'execution_cost_input')
          ? { execution_cost_input: options.execution_cost_input }
          : {}),
      });
      // PM-005 (US-082) — caller 传 ai_summary_source 时调 LLM 替换 heuristic
      // ai_summary; 永不 throw, 失败自动 fallback (heuristic 在 build 内已填).
      if (options.ai_summary_source && options.ai_summary_source !== 'off') {
        try {
          const aiResult = await generateAIAttributionSummary(report, options.ai_summary_source);
          report.ai_summary = aiResult.text;
        } catch (err) {
          logger.warn(
            `[daily-attribution] generateAIAttributionSummary failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          // ai_summary 已是 heuristic, 不动
        }
      }
      return { status: DAILY_ATTRIBUTION_STATUS.OK, report };
    } catch (err) {
      logger.warn(
        `[daily-attribution] generateDailyReport portfolio=${portfolio_id} date=${date} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return {
        status: DAILY_ATTRIBUTION_STATUS.FAILED,
        report: null,
        reason: 'db_error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const dailyAttributionService = new DailyAttributionService();

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function safeNumber(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return n;
}
