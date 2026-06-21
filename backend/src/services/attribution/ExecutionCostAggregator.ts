/**
 * ExecutionCostAggregator — L8-Postmortem / US-081 [PM-004]
 *
 * 把"执行成本"这一维度从 PM-001 的 `Σ commission` 一行 placeholder 扩到真三件套:
 *   commission_total + stamp_duty_total + transfer_fee_total + slippage_total
 *
 * 同时与实盘 LiveTrade fill 对账 (AC: 总额匹配率 ≥ 99%), 暴露差异比例让上游
 * (cron / 风控) 在系统漂移时即时告警.
 *
 * ─── 设计 ─────────────────────────────────────────────────────────────
 *
 * 本 module **纯函数 + DataSource DI seam, 不直接 require model**:
 *   - aggregateExecutionCost(input)            — 主入口, 决算单
 *   - computeStampDutyFromTrade(trade)         — A 股 SELL 千 1
 *   - computeTransferFeeFromTrade(trade)       — A 股 双边 万 0.1
 *   - computeSlippageFromTrade(trade, ref?)    — |execute - ref| × qty
 *   - reconcileWithLiveFills({paper, live})    — 比对总额, 返 match_ratio
 *   - sumLiveFixedCosts(fills)                 — Σ aShareFixedCosts 当 live 端总成本
 *   - buildBreakdownExecutionCost(...)         — 给 sixDimBreakdown 用的 single number
 *
 * ─── 与 PaperTradingFacade 合谋之处 ─────────────────────────────────────
 *
 * PaperTradingFacade._placeOrderInner(SELL) 已经把 broker_commission + stamp_tax +
 * transfer_fee 三者 sum 进 trade.commission 一列 (见 PaperTradingFacade.ts:1322
 *   `const commission = brokerCommission + stampTax + transferFee;`).
 * 也就是: paper 端 `commission` 列 = 三件套之和; 想"显示三个分项"必须按
 * amount × 标准费率反推 (aShareFixedCosts), 与历史 commission 总额对账即可.
 *
 * 这条 *bundle 在 commission* 的事实写到 jsdoc 防后续 reader 误以为
 * commission_total + stamp_duty_total 是重复加.
 *
 * ─── AC §E.1 与 LiveTrade 对账 ≥ 99% ──────────────────────────────────
 *
 * `reconcileWithLiveFills({paper, live})` 算的是 *总执行成本对账率*:
 *
 *   paper_total = Σ paper_trade.commission         (已含 stamp + transfer + broker)
 *   live_total  = Σ aShareFixedCosts(amount, side).total
 *                                                  (LiveTrade 没有 commission 列,
 *                                                   按标准费率反推)
 *   diff_abs    = |paper_total - live_total|
 *   match_ratio = paper==live==0 ? 1
 *               : 1 - diff_abs / max(paper, live)
 *   is_match    = match_ratio >= 0.99
 *
 * paper==0 且 live==0 视作 trivially 匹配 (没交易就没成本, 对账自然过).
 * 99% 阈值由 AC 定; 想调严走 export 常量 MATCH_RATIO_THRESHOLD.
 *
 * ─── fail-OPEN ────────────────────────────────────────────────────────
 *
 * - 任何 NaN/Infinity/字符串 → 0
 * - rows 空 → 全 0 (不 throw)
 * - ref_prices 缺某 symbol → 该 trade slippage = 0
 * - LiveTrade 没传 → reconcile 跳过, paper_total 仍可算
 *
 * 与 PM-001 / PM-002 同款"算不出就 0", 不阻塞主链路.
 *
 * ─── 主要消费方 ───────────────────────────────────────────────────────
 *
 * - PM-001 sixDimBreakdown — 可选传入 `execution_cost_input` 让 execution_cost 走 aggregator
 * - PM-006 cron — 准备好 LiveTrade fills 后传入做对账, match_ratio < 99% 写 RiskAlert
 * - PM-007 route — 把 breakdown.execution_cost_breakdown 暴露给前端 ReviewTab
 */

import { aShareFixedCosts } from '../execution/tca';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** AC §E.1: 总执行成本与 LiveTrade 对账匹配率 ≥ 99%. */
export const MATCH_RATIO_THRESHOLD = 0.99;

/** A 股印花税 (单边 SELL). 与 PaperTradingFacade / tca.ts 同步. */
export const STAMP_DUTY_RATE = 0.001;

/** A 股过户费 (双边). 与 PaperTradingFacade / tca.ts 同步. */
export const TRANSFER_FEE_RATE = 0.00001;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 主入口接受的 trade 行 (与 DailyAttributionTradeRow 字段子集兼容). */
export interface ExecutionTradeRow {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  execute_price: number;
  /** 成交金额 (不含费), e.g. PaperTradingTrade.amount */
  amount: number;
  /** PaperTradingTrade.commission = broker_commission + stamp_tax + transfer_fee 总和.
   *  独立 LiveTrade 没此列, 传 0 让 sumLiveFixedCosts 走反推. */
  commission?: number;
}

/** LiveTrade fill 行 (LiveTrade 模型字段子集). */
export interface LiveFillRow {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  trade_price: number;
  trade_amount: number;
}

/** 主入口输入. */
export interface ExecutionCostInput {
  trades: ExecutionTradeRow[];
  /** symbol → 参考价 (arrival_price / 当日 VWAP / signal_price); 缺失则该 trade slippage=0. */
  ref_prices?: Record<string, number>;
}

/** 主入口输出 — 4 件套 + 合计. */
export interface ExecutionCostBreakdown {
  /** Σ commission 列 (paper 端已含 broker + stamp + transfer 三者). */
  commission_total: number;
  /** Σ amount(SELL) × STAMP_DUTY_RATE — 反推分项, 不与 commission_total 相加. */
  stamp_duty_total: number;
  /** Σ amount × TRANSFER_FEE_RATE — 反推分项, 不与 commission_total 相加. */
  transfer_fee_total: number;
  /** Σ |execute_price - ref_price| × quantity — 滑点成本; ref 缺失则 0. */
  slippage_total: number;
  /** 入 DailyAttributionBreakdown.execution_cost: commission_total + slippage_total */
  total_cost: number;
  trade_count: number;
  /** 显式列出 ref_prices 命中数, 让上游观察"slippage 覆盖率". */
  slippage_coverage_count: number;
}

/** Reconciliation 结果. */
export interface ReconciliationResult {
  paper_total: number;
  live_total: number;
  diff_abs: number;
  /** 1 - diff/max(paper, live); paper==live==0 → 1. clamp [0, 1]. */
  match_ratio: number;
  /** match_ratio >= MATCH_RATIO_THRESHOLD */
  is_match: boolean;
  trade_count_paper: number;
  trade_count_live: number;
}

// ---------------------------------------------------------------------------
// pure helpers — 单分项
// ---------------------------------------------------------------------------

function safeNumber(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return n;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

/** A 股印花税: SELL 端 amount × 千 1. BUY 返 0. */
export function computeStampDutyFromTrade(trade: ExecutionTradeRow): number {
  if (!trade || trade.side !== 'SELL') return 0;
  const amount = safeNumber(trade.amount);
  if (amount <= 0) return 0;
  return round2(amount * STAMP_DUTY_RATE);
}

/** A 股过户费: 双边 amount × 万 0.1. */
export function computeTransferFeeFromTrade(trade: ExecutionTradeRow): number {
  if (!trade) return 0;
  const amount = safeNumber(trade.amount);
  if (amount <= 0) return 0;
  return round2(amount * TRANSFER_FEE_RATE);
}

/**
 * Slippage = |execute_price - ref_price| × quantity.
 *
 * caller 应传"决策时的参考价" (arrival_price / signal_price / 当日 VWAP),
 * 无参考时返 0 (不强行用 0 当参考会让 slippage = revenue, 完全错).
 */
export function computeSlippageFromTrade(trade: ExecutionTradeRow, ref_price?: number): number {
  if (!trade) return 0;
  if (ref_price == null || !Number.isFinite(ref_price) || ref_price <= 0) return 0;
  const exec = safeNumber(trade.execute_price);
  const qty = safeNumber(trade.quantity);
  if (exec <= 0 || qty <= 0) return 0;
  return round2(Math.abs(exec - ref_price) * qty);
}

// ---------------------------------------------------------------------------
// 主入口 — aggregateExecutionCost
// ---------------------------------------------------------------------------

/**
 * 把一组 trade 聚合成 4 分项 + 合计的 ExecutionCostBreakdown.
 *
 * caller (PM-006 cron / PM-001 buildDailyAttributionReport):
 *   - trades = 当日已成交的 paper trade (包含 BUY + SELL)
 *   - ref_prices = symbol → 决策时参考价; 缺失 symbol 对应 trade.slippage = 0
 *
 * 返回:
 *   - commission_total  → 直接 sum trade.commission (paper 端已合 stamp + transfer)
 *   - stamp_duty_total  → 按 amount × 千 1 (仅 SELL) **独立反推** (展示分项, 不重复加)
 *   - transfer_fee_total→ 按 amount × 万 0.1 (双边) **独立反推**
 *   - slippage_total    → Σ |execute - ref| × qty (ref 缺失则 0)
 *   - total_cost        → commission_total + slippage_total (不重复加 stamp/transfer)
 */
export function aggregateExecutionCost(input: ExecutionCostInput): ExecutionCostBreakdown {
  const trades = Array.isArray(input?.trades) ? input.trades : [];
  const refMap = input?.ref_prices || {};
  let commission_total = 0;
  let stamp_duty_total = 0;
  let transfer_fee_total = 0;
  let slippage_total = 0;
  let slippage_coverage_count = 0;
  let trade_count = 0;
  for (const t of trades) {
    if (!t || typeof t !== 'object') continue;
    trade_count += 1;
    commission_total += safeNumber(t.commission);
    stamp_duty_total += computeStampDutyFromTrade(t);
    transfer_fee_total += computeTransferFeeFromTrade(t);
    const ref = typeof t.symbol === 'string' ? refMap[t.symbol] : undefined;
    if (ref != null && Number.isFinite(ref) && ref > 0) {
      slippage_total += computeSlippageFromTrade(t, ref);
      slippage_coverage_count += 1;
    }
  }
  const commission_round = round2(commission_total);
  const slippage_round = round2(slippage_total);
  return {
    commission_total: commission_round,
    stamp_duty_total: round2(stamp_duty_total),
    transfer_fee_total: round2(transfer_fee_total),
    slippage_total: slippage_round,
    total_cost: round2(commission_round + slippage_round),
    trade_count,
    slippage_coverage_count,
  };
}

/** sixDimBreakdown 用 — 仅返 single number 总成本, 兼容 PM-001 老签名. */
export function buildBreakdownExecutionCost(input: ExecutionCostInput): number {
  return aggregateExecutionCost(input).total_cost;
}

// ---------------------------------------------------------------------------
// LiveTrade 对账
// ---------------------------------------------------------------------------

/**
 * Σ LiveTrade fills 的标准 fixed cost (commission + stamp + transfer).
 *
 * LiveTrade 模型本身没 commission 列 (broker 回报里也常缺), 按 A 股标准费率
 * 反推作为 *理论应付成本*. 实盘真实 commission 由 LiveBrokerAccount.daily_fee
 * 维护 (本 module 不依赖, 留 PM-006 reconcile 时按需对比).
 */
export function sumLiveFixedCosts(fills: LiveFillRow[]): number {
  if (!Array.isArray(fills) || fills.length === 0) return 0;
  let total = 0;
  for (const f of fills) {
    if (!f || typeof f !== 'object') continue;
    const amount = safeNumber(f.trade_amount);
    if (amount <= 0) continue;
    const side: 'BUY' | 'SELL' = f.side === 'BUY' ? 'BUY' : 'SELL';
    const fixed = aShareFixedCosts({ amount, side });
    total += safeNumber(fixed.total);
  }
  return round2(total);
}

/**
 * Paper vs Live 执行成本对账.
 *
 * AC §E.1: 总额匹配率 ≥ 99% → is_match=true.
 *
 * 计算:
 *   paper_total = Σ paper_trade.commission (PaperTradingFacade 已合 broker+stamp+transfer)
 *   live_total  = sumLiveFixedCosts(live_fills) (按标准费率反推)
 *   diff_abs    = |paper - live|
 *   match_ratio = paper==live==0 ? 1 : 1 - diff_abs / max(paper, live)
 *   is_match    = match_ratio >= MATCH_RATIO_THRESHOLD
 *
 * caller 可在 is_match=false 时写 RiskAlert (mid/high), 提示 paper engine
 * 与实盘 fee 模型已漂移 (e.g. broker 改费率 / paper 端漏算某品种印花税).
 */
export function reconcileWithLiveFills(input: {
  paper_trades: ExecutionTradeRow[];
  live_fills: LiveFillRow[];
}): ReconciliationResult {
  const paperTrades = Array.isArray(input?.paper_trades) ? input.paper_trades : [];
  const liveFills = Array.isArray(input?.live_fills) ? input.live_fills : [];
  let paper_total = 0;
  for (const t of paperTrades) {
    if (!t || typeof t !== 'object') continue;
    paper_total += safeNumber(t.commission);
  }
  paper_total = round2(paper_total);
  const live_total = sumLiveFixedCosts(liveFills);
  const diff_abs = round2(Math.abs(paper_total - live_total));
  let match_ratio: number;
  if (paper_total === 0 && live_total === 0) {
    match_ratio = 1;
  } else {
    const denom = Math.max(paper_total, live_total);
    if (denom <= 0) {
      match_ratio = 0;
    } else {
      const raw = 1 - diff_abs / denom;
      match_ratio = round4(Math.max(0, Math.min(1, raw)));
    }
  }
  return {
    paper_total,
    live_total,
    diff_abs,
    match_ratio,
    is_match: match_ratio >= MATCH_RATIO_THRESHOLD,
    trade_count_paper: paperTrades.length,
    trade_count_live: liveFills.length,
  };
}
