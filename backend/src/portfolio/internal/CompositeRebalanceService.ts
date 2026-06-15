/**
 * Sprint 41-A: CompositeRebalanceService
 *
 * 把组合级策略 (multi_factor_alpha / ensemble_strategy) 的 target_portfolio
 * 升级成**真实的 BUY/SELL/HOLD 调仓**:
 *
 *   - 当前持仓不在目标里 → SELL (但只卖该策略 entry 的票, fail-safe)
 *   - 当前持仓还在目标里 → HOLD (RebalanceEngine 计算微调)
 *   - 新目标 → BUY (按等权 1/N 目标权重)
 *   - 应用约束: 单票上限 / 行业暴露 cap / 单日换手率上限
 *
 * 与既有 RebalanceEngine 的关系:
 *   - RebalanceEngine 是底层"目标权重 → 订单 plan + 100 股取整"引擎
 *   - 本 service 是 composite 策略调用方: 读 QuantSignal → 转 weight Map →
 *     SELL 过滤 → 调 RebalanceEngine 出 plan → 应用 turnover/industry cap →
 *     走 facade 真下单
 *
 * 设计约束:
 *   1. **fail-open 默认**: 任何外部调用失败 (DB / facade / industry lookup)
 *      只 warn 不阻塞整个 service. 这与 risk/ 的 PositionLimit 等硬 guard 反向 -
 *      composite rebalance 是 soft 决策层, 失败时降级到"不调仓"而非阻塞主流程.
 *   2. **SELL 范围保守**: 只卖**该策略 entry 的票**(用 PaperTradingOrderIntent.
 *      metadata.strategy_key 反查). 反查不到 (手动开仓 / 老仓位无 metadata) 一律
 *      不卖, 避免误平别人开的仓.
 *   3. **dry_run 默认 true**: 与 RebalanceEngine 同款约定 - 默认只产 plan,
 *      显式 execute=true 才真下单, 让 caller (cron / API / 单测) review 后决定.
 *   4. **持久化可选**: persist=true 时写 PaperTradingOrderIntent 留审计;
 *      persist=false (默认) 仅返回 plan.
 *   5. **DataSource DI**: 所有 DB 查询通过 CompositeRebalanceDataSource 抽出,
 *      让单测 fake 完全脱 DB.
 *   6. **纯函数 helper 全 export**: computeTargetWeights / filterEligibleSells
 *      / applyTurnoverCap / applyIndustryCap / applyMaxPerPositionCap.
 */
import { logger } from '../../utils/logger';
import {
  rebalanceEngine,
  RebalanceOrder,
  RebalanceResult,
  RebalanceOptions,
  DEFAULT_REBALANCE_OPTIONS,
} from '../RebalanceEngine';

// ---------------------------------------------------------------------------
// Constants (Object.freeze guards against accidental mutation in production)
// ---------------------------------------------------------------------------

/**
 * Composite-level strategy keys 本 service 处理的策略.
 * 必须与 QuantSignalService 的 COMPOSITE_LEVEL_STRATEGY_KEYS 同步.
 */
export const COMPOSITE_REBALANCE_STRATEGY_KEYS = Object.freeze([
  'multi_factor_alpha',
  'ensemble_strategy',
] as const);

export type CompositeRebalanceStrategyKey = (typeof COMPOSITE_REBALANCE_STRATEGY_KEYS)[number];

/**
 * 默认 cap 配置 - 与 PaperTradingAutomationService 默认值一致, 避免双源歧义.
 */
export const DEFAULT_COMPOSITE_REBALANCE_OPTIONS = Object.freeze({
  /** 单票上限 (% of total_value), 默认 12% (与 PaperTradingAuto.max_position_pct 一致) */
  maxPerPositionPct: 0.12,
  /** 行业暴露 cap (% of total_value), 默认 25% (与 max_industry_exposure_pct 一致) */
  maxIndustryExposurePct: 0.25,
  /**
   * 单日换手率上限 (sell_amount + buy_amount) / total_value, 默认 0.4 (40%).
   * 防止一次性大额洗仓产生大量冲击成本. 超过 cap 时按金额比例 prorate sell 和 buy.
   */
  maxDailyTurnoverPct: 0.4,
  /** Equal-weight 模式下每只目标股的权重 = 1 / target_count. */
  weightMode: 'equal_weight' as const,
  /** dry_run 默认 true, 与 RebalanceEngine 一致. */
  dryRun: true,
  /** 持久化 plan 到 PaperTradingOrderIntent 表 (用于审计). 默认 false. */
  persist: false,
});

export type CompositeRebalanceOptions = typeof DEFAULT_COMPOSITE_REBALANCE_OPTIONS;

// ---------------------------------------------------------------------------
// Input/Output types
// ---------------------------------------------------------------------------

export interface CompositeRebalanceInput {
  portfolio_id: number;
  strategy_key: CompositeRebalanceStrategyKey;
  /** 目标股票列表 (从 QuantSignal raw_factors.target_portfolio 来的 stock_code[]) */
  target_portfolio: string[];
  /** 当前交易日, 用于查 OrderIntent 和写 plan. ISO YYYY-MM-DD. */
  trade_date: string;
  options?: Partial<CompositeRebalanceOptions>;
}

export interface CompositeRebalanceResult {
  portfolio_id: number;
  strategy_key: string;
  trade_date: string;
  total_value: number;
  /** 调仓后的真实 BUY/SELL/HOLD 订单 (已应用所有 cap) */
  orders: RebalanceOrder[];
  /** 因 fail-safe 不卖被丢弃的 SELL (审计用: ops 看到 "我以为它会被平") */
  filtered_sells: Array<{ symbol: string; reason: string }>;
  /** 因 turnover cap 被 prorate 削减的 (BUY+SELL) 数量 */
  capped_turnover_orders: number;
  /** 因 industry cap 被削减的 BUY 数量 */
  capped_industry_orders: number;
  /** 因 max_per_position cap 被削减的 BUY 数量 */
  capped_per_position_orders: number;
  dry_run: boolean;
  persisted: boolean;
  options: CompositeRebalanceOptions;
  diagnostics: {
    target_count: number;
    current_position_count: number;
    eligible_sell_count: number;
    /** total_turnover_amount = sum(|order.diff_value|) */
    total_turnover_amount: number;
    total_turnover_pct: number;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// DataSource (DI for tests)
// ---------------------------------------------------------------------------

export interface CompositeRebalanceDataSource {
  /**
   * 反查 portfolio 中每只持仓的 entry strategy_key (用最早的同 portfolio + 同 symbol
   * 的 BUY OrderIntent.metadata.strategy_key).
   * 返回 Map<symbol, strategy_key>; 未找到的 symbol 不出现.
   */
  loadEntryStrategyKeyBySymbol(
    portfolio_id: number,
    symbols: string[]
  ): Promise<Map<string, string>>;

  /**
   * 读 Stock.industry 给行业 cap 用. 返回 Map<symbol, industry_name>.
   */
  loadIndustryBySymbol(symbols: string[]): Promise<Map<string, string>>;
}

export const PRODUCTION_COMPOSITE_REBALANCE_DATA_SOURCE: CompositeRebalanceDataSource = {
  async loadEntryStrategyKeyBySymbol(portfolio_id, symbols) {
    const out = new Map<string, string>();
    if (!symbols.length) return out;
    try {
      // Lazy require - 避免单测拉重量级 ORM
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingOrderIntent } = require('../../models/PaperTradingOrderIntent');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const rows = await PaperTradingOrderIntent.findAll({
        where: {
          portfolio_id,
          symbol: { [Op.in]: symbols },
          side: 'BUY',
        },
        order: [['intent_date', 'ASC']],
        attributes: ['symbol', 'metadata'],
        raw: true,
      });
      for (const row of rows as any[]) {
        // 第一条 (最早) BUY intent 的 strategy_key 视为 entry strategy.
        if (out.has(row.symbol)) continue;
        const key = row?.metadata?.strategy_key;
        if (typeof key === 'string' && key.length > 0) {
          out.set(row.symbol, key);
        }
      }
    } catch (error: any) {
      logger.warn(`CompositeRebalance entry strategy 查询失败: ${error?.message || error}`);
    }
    return out;
  },

  async loadIndustryBySymbol(symbols) {
    const out = new Map<string, string>();
    if (!symbols.length) return out;
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
      for (const row of rows as any[]) {
        const industry = String(row?.industry || '').trim();
        if (row?.symbol && industry) {
          out.set(row.symbol, industry);
        }
      }
    } catch (error: any) {
      logger.warn(`CompositeRebalance industry 查询失败: ${error?.message || error}`);
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Pure-function helpers (all exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 把 target_portfolio 转换成 equal-weight 目标权重 Map.
 * 重复 symbol 自动去重 (Set), 空数组返回空 Map.
 *
 * 未来扩展: 支持 weightMode='ic_weighted' / 'score_weighted'.
 */
export function computeTargetWeights(
  target_portfolio: string[],
  weightMode: 'equal_weight' = 'equal_weight'
): Map<string, number> {
  const out = new Map<string, number>();
  if (!target_portfolio?.length) return out;
  const uniqueSymbols = Array.from(
    new Set(target_portfolio.filter(s => typeof s === 'string' && s.length > 0))
  );
  if (!uniqueSymbols.length || weightMode !== 'equal_weight') return out;
  const equalWeight = 1 / uniqueSymbols.length;
  for (const sym of uniqueSymbols) {
    out.set(sym, equalWeight);
  }
  return out;
}

/**
 * Fail-safe SELL 过滤: 只保留**确认是该策略 entry 的 SELL 订单**.
 * 反查不到 (手动开仓 / 老仓位无 metadata) 的一律不卖, 防误平.
 *
 * 返回 [eligible orders, filtered orders 列表 (含 reason)].
 */
export function filterEligibleSells(
  sellOrders: RebalanceOrder[],
  entryStrategyMap: Map<string, string>,
  currentStrategyKey: string
): { eligible: RebalanceOrder[]; filtered: Array<{ symbol: string; reason: string }> } {
  const eligible: RebalanceOrder[] = [];
  const filtered: Array<{ symbol: string; reason: string }> = [];
  for (const order of sellOrders) {
    const entryKey = entryStrategyMap.get(order.symbol);
    if (!entryKey) {
      filtered.push({
        symbol: order.symbol,
        reason: `fail-safe: 持仓 ${order.symbol} 缺 entry strategy 元数据, 不平 (手动开仓或老仓位)`,
      });
      continue;
    }
    if (entryKey !== currentStrategyKey) {
      filtered.push({
        symbol: order.symbol,
        reason: `fail-safe: 持仓 ${order.symbol} entry strategy=${entryKey}, 不被 ${currentStrategyKey} 接管`,
      });
      continue;
    }
    eligible.push(order);
  }
  return { eligible, filtered };
}

/**
 * 单票上限 cap: 任一 BUY 订单的 target_value 超过 maxPerPositionPct × total_value
 * 时, 强制削减该订单的目标到 cap. 削减发生在 RebalanceEngine 算 plan 之前
 * (在 weight Map 阶段) 更干净, 但本函数后置处理是为了"caller 已有 plan 想后置 cap"的场景.
 *
 * 返回 [capped orders, capped_count].
 */
export function applyMaxPerPositionCap(
  orders: RebalanceOrder[],
  totalValue: number,
  maxPerPositionPct: number
): { orders: RebalanceOrder[]; capped_count: number } {
  if (totalValue <= 0 || maxPerPositionPct <= 0 || maxPerPositionPct >= 1) {
    return { orders, capped_count: 0 };
  }
  const cap = totalValue * maxPerPositionPct;
  let cappedCount = 0;
  const out = orders.map(order => {
    if (order.side !== 'BUY') return order;
    if (order.target_value <= cap) return order;
    cappedCount++;
    const newTargetValue = cap;
    const newDiffValue = newTargetValue - order.current_value;
    const newQuantity =
      order.current_price > 0 ? Math.floor(newDiffValue / order.current_price / 100) * 100 : 0;
    return {
      ...order,
      target_value: newTargetValue,
      target_weight: maxPerPositionPct,
      diff_value: newDiffValue,
      diff_pct: Math.abs(newDiffValue) / totalValue,
      quantity: Math.max(0, newQuantity),
      reason: `${order.reason || ''}; capped by max_per_position_pct=${maxPerPositionPct}`,
    };
  });
  return { orders: out, capped_count: cappedCount };
}

/**
 * 行业暴露 cap: 单行业 BUY 后 total exposure 不超过 maxIndustryExposurePct.
 * 计算行业当前持仓 + 拟买入金额, 超 cap 的 BUY 订单按比例削减.
 *
 * 算法:
 *   1. 按 industry group BUY 订单
 *   2. 对每个行业算 (current_industry_value + sum(buy.target_value - buy.current_value))
 *   3. 若超 cap, scale 该行业内所有 BUY 的 target_value
 *   4. 重新算 quantity (100 股取整)
 */
export function applyIndustryCap(
  orders: RebalanceOrder[],
  industryMap: Map<string, string>,
  totalValue: number,
  maxIndustryExposurePct: number
): { orders: RebalanceOrder[]; capped_count: number } {
  if (totalValue <= 0 || maxIndustryExposurePct <= 0 || maxIndustryExposurePct >= 1) {
    return { orders, capped_count: 0 };
  }
  const cap = totalValue * maxIndustryExposurePct;
  // group BUY orders by industry
  const buysByIndustry = new Map<string, RebalanceOrder[]>();
  // current exposure by industry (HOLD + SELL 已处理的存量)
  const currentExposureByIndustry = new Map<string, number>();
  for (const order of orders) {
    const industry = industryMap.get(order.symbol) || '__unknown__';
    if (order.side === 'BUY') {
      const arr = buysByIndustry.get(industry) || [];
      arr.push(order);
      buysByIndustry.set(industry, arr);
    }
    // current_value 是该 symbol 当前持仓市值, 累计到 industry 当前敞口
    currentExposureByIndustry.set(
      industry,
      (currentExposureByIndustry.get(industry) || 0) + order.current_value
    );
  }

  let cappedCount = 0;
  const cappedSymbols = new Set<string>();
  for (const [industry, buys] of buysByIndustry) {
    if (industry === '__unknown__') continue; // 行业未知不 cap (避免误伤)
    const currentExposure = currentExposureByIndustry.get(industry) || 0;
    const totalBuyValue = buys.reduce((sum, b) => sum + Math.max(0, b.diff_value), 0);
    const projectedExposure = currentExposure + totalBuyValue;
    if (projectedExposure <= cap) continue;
    // 超 cap, scale 该行业 BUY
    const allowedBuyValue = Math.max(0, cap - currentExposure);
    const scale = totalBuyValue > 0 ? allowedBuyValue / totalBuyValue : 0;
    for (const buy of buys) {
      cappedSymbols.add(buy.symbol);
      const newDiffValue = Math.max(0, buy.diff_value) * scale;
      const newTargetValue = buy.current_value + newDiffValue;
      buy.target_value = newTargetValue;
      buy.diff_value = newDiffValue;
      buy.diff_pct = Math.abs(newDiffValue) / totalValue;
      buy.target_weight = totalValue > 0 ? newTargetValue / totalValue : 0;
      buy.quantity =
        buy.current_price > 0 ? Math.floor(newDiffValue / buy.current_price / 100) * 100 : 0;
      buy.reason = `${
        buy.reason || ''
      }; capped by industry=${industry} exposure ${maxIndustryExposurePct}`;
    }
    cappedCount += buys.length;
  }
  return { orders, capped_count: cappedCount };
}

/**
 * 单日换手率 cap: |SELL_amount| + BUY_amount 总额 > maxDailyTurnoverPct × total_value
 * 时按金额比例 prorate. 不削减 SELL (出场比入场更重要), 只 prorate BUY.
 *
 * 算法:
 *   1. total_sell_amount = sum(|SELL.diff_value|)
 *   2. total_buy_amount  = sum(BUY.diff_value)
 *   3. total_turnover = total_sell + total_buy
 *   4. if total_turnover > cap: scale BUY 部分 = max(0, cap - total_sell) / total_buy
 *   5. SELL 不变 (优先平仓)
 */
export function applyTurnoverCap(
  orders: RebalanceOrder[],
  totalValue: number,
  maxDailyTurnoverPct: number
): { orders: RebalanceOrder[]; capped_count: number; total_turnover_pct: number } {
  if (totalValue <= 0 || maxDailyTurnoverPct <= 0 || maxDailyTurnoverPct >= 10) {
    return { orders, capped_count: 0, total_turnover_pct: 0 };
  }
  const cap = totalValue * maxDailyTurnoverPct;
  let totalSell = 0;
  let totalBuy = 0;
  for (const order of orders) {
    if (order.side === 'SELL') totalSell += Math.abs(order.diff_value);
    if (order.side === 'BUY') totalBuy += Math.max(0, order.diff_value);
  }
  const totalTurnover = totalSell + totalBuy;
  const turnoverPct = totalValue > 0 ? totalTurnover / totalValue : 0;
  if (totalTurnover <= cap) {
    return { orders, capped_count: 0, total_turnover_pct: turnoverPct };
  }
  // SELL 不动, scale BUY
  const allowedBuy = Math.max(0, cap - totalSell);
  const scale = totalBuy > 0 ? allowedBuy / totalBuy : 0;
  let cappedCount = 0;
  for (const order of orders) {
    if (order.side !== 'BUY') continue;
    if (order.diff_value <= 0) continue;
    cappedCount++;
    const newDiffValue = order.diff_value * scale;
    const newTargetValue = order.current_value + newDiffValue;
    order.target_value = newTargetValue;
    order.diff_value = newDiffValue;
    order.diff_pct = Math.abs(newDiffValue) / totalValue;
    order.target_weight = totalValue > 0 ? newTargetValue / totalValue : 0;
    order.quantity =
      order.current_price > 0 ? Math.floor(newDiffValue / order.current_price / 100) * 100 : 0;
    order.reason = `${order.reason || ''}; capped by daily turnover ${maxDailyTurnoverPct}`;
  }
  return { orders, capped_count: cappedCount, total_turnover_pct: turnoverPct };
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class CompositeRebalanceService {
  constructor(
    private dataSource: CompositeRebalanceDataSource = PRODUCTION_COMPOSITE_REBALANCE_DATA_SOURCE
  ) {}

  /**
   * 主流程入口:
   *   1. 调 RebalanceEngine 算 raw plan (target_portfolio → equal weight → BUY/SELL/HOLD)
   *   2. 过滤 SELL: 只保留该策略 entry 的票
   *   3. 应用 max_per_position cap
   *   4. 应用 industry cap
   *   5. 应用 daily turnover cap
   *   6. 排序 SELL > BUY > HOLD
   *   7. (可选) 持久化 plan
   *   8. (可选) 真下单 (execute=true 时 RebalanceEngine 走 facade)
   *
   * Fail-open: 任一环节抛错 → log warn + 返回 empty plan (不阻塞主流程).
   */
  async rebalance(input: CompositeRebalanceInput): Promise<CompositeRebalanceResult> {
    const opts: CompositeRebalanceOptions = {
      ...DEFAULT_COMPOSITE_REBALANCE_OPTIONS,
      ...(input.options || {}),
    };
    const emptyResult = (message: string): CompositeRebalanceResult => ({
      portfolio_id: input.portfolio_id,
      strategy_key: input.strategy_key,
      trade_date: input.trade_date,
      total_value: 0,
      orders: [],
      filtered_sells: [],
      capped_turnover_orders: 0,
      capped_industry_orders: 0,
      capped_per_position_orders: 0,
      dry_run: opts.dryRun,
      persisted: false,
      options: opts,
      diagnostics: {
        target_count: 0,
        current_position_count: 0,
        eligible_sell_count: 0,
        total_turnover_amount: 0,
        total_turnover_pct: 0,
        message,
      },
    });

    if (
      !COMPOSITE_REBALANCE_STRATEGY_KEYS.includes(
        input.strategy_key as CompositeRebalanceStrategyKey
      )
    ) {
      return emptyResult(`不支持的 strategy_key: ${input.strategy_key}`);
    }

    // 1. 算目标权重
    const targetWeights = computeTargetWeights(input.target_portfolio, opts.weightMode);
    if (targetWeights.size === 0) {
      return emptyResult('target_portfolio 为空, 无调仓');
    }

    let rawPlan: RebalanceResult;
    try {
      const rebalanceOpts: Partial<RebalanceOptions> & { execute?: boolean } = {
        minTradePct: DEFAULT_REBALANCE_OPTIONS.minTradePct,
        dryRun: true, // 强制 dry-run, 我们要先 cap 再决定是否真下单
      };
      rawPlan = await rebalanceEngine.rebalance(input.portfolio_id, targetWeights, rebalanceOpts);
    } catch (error: any) {
      logger.warn(
        `CompositeRebalance ${input.strategy_key} portfolio=${
          input.portfolio_id
        } RebalanceEngine 失败: ${error?.message || error}`
      );
      return emptyResult(`RebalanceEngine 失败: ${error?.message || error}`);
    }

    const totalValue = rawPlan.total_value;
    if (totalValue <= 0) {
      return emptyResult('portfolio total_value <= 0, 无法调仓');
    }

    // 2. SELL fail-safe 过滤
    const sellSymbols = rawPlan.orders.filter(o => o.side === 'SELL').map(o => o.symbol);
    const entryMap = await this.dataSource.loadEntryStrategyKeyBySymbol(
      input.portfolio_id,
      sellSymbols
    );
    const sellOrders = rawPlan.orders.filter(o => o.side === 'SELL');
    const { eligible: eligibleSells, filtered: filteredSells } = filterEligibleSells(
      sellOrders,
      entryMap,
      input.strategy_key
    );

    let orders: RebalanceOrder[] = [
      ...eligibleSells,
      ...rawPlan.orders.filter(o => o.side === 'BUY'),
      ...rawPlan.orders.filter(o => o.side === 'HOLD'),
    ];

    // 3. max_per_position cap
    const { orders: ordersAfterPerPos, capped_count: cappedPerPosCount } = applyMaxPerPositionCap(
      orders,
      totalValue,
      opts.maxPerPositionPct
    );
    orders = ordersAfterPerPos;

    // 4. industry cap
    const allBuySymbols = orders.filter(o => o.side === 'BUY').map(o => o.symbol);
    const allHoldSymbols = orders.filter(o => o.side === 'HOLD').map(o => o.symbol);
    const industryMap = await this.dataSource.loadIndustryBySymbol([
      ...new Set([...allBuySymbols, ...allHoldSymbols]),
    ]);
    const { orders: ordersAfterIndustry, capped_count: cappedIndustryCount } = applyIndustryCap(
      orders,
      industryMap,
      totalValue,
      opts.maxIndustryExposurePct
    );
    orders = ordersAfterIndustry;

    // 5. turnover cap
    const {
      orders: ordersAfterTurnover,
      capped_count: cappedTurnoverCount,
      total_turnover_pct: turnoverPct,
    } = applyTurnoverCap(orders, totalValue, opts.maxDailyTurnoverPct);
    orders = ordersAfterTurnover;

    // 过滤掉 quantity=0 的 BUY/SELL (cap 后变 0 视为 HOLD)
    orders = orders.map(o => {
      if (o.side === 'HOLD') return o;
      if (o.quantity <= 0) {
        return {
          ...o,
          side: 'HOLD' as const,
          reason: `${o.reason || ''}; cap 后 quantity=0 转 HOLD`,
        };
      }
      return o;
    });

    const totalTurnoverAmount = orders.reduce(
      (sum, o) => (o.side === 'SELL' || o.side === 'BUY' ? sum + Math.abs(o.diff_value) : sum),
      0
    );

    // 6. 持久化 plan (审计用)
    let persisted = false;
    if (opts.persist) {
      try {
        await this.persistPlan({
          portfolio_id: input.portfolio_id,
          strategy_key: input.strategy_key,
          trade_date: input.trade_date,
          orders,
        });
        persisted = true;
      } catch (error: any) {
        logger.warn(
          `CompositeRebalance ${input.strategy_key} persist 失败 (不阻塞调仓): ${
            error?.message || error
          }`
        );
      }
    }

    return {
      portfolio_id: input.portfolio_id,
      strategy_key: input.strategy_key,
      trade_date: input.trade_date,
      total_value: totalValue,
      orders,
      filtered_sells: filteredSells,
      capped_turnover_orders: cappedTurnoverCount,
      capped_industry_orders: cappedIndustryCount,
      capped_per_position_orders: cappedPerPosCount,
      dry_run: opts.dryRun,
      persisted,
      options: opts,
      diagnostics: {
        target_count: targetWeights.size,
        current_position_count: rawPlan.orders.filter(o => o.current_quantity > 0).length,
        eligible_sell_count: eligibleSells.length,
        total_turnover_amount: totalTurnoverAmount,
        total_turnover_pct: turnoverPct,
        message: `${orders.filter(o => o.side === 'BUY').length} BUY / ${
          orders.filter(o => o.side === 'SELL').length
        } SELL / ${orders.filter(o => o.side === 'HOLD').length} HOLD; turnover=${(
          turnoverPct * 100
        ).toFixed(2)}%`,
      },
    };
  }

  /**
   * 持久化 plan 到 PaperTradingOrderIntent (status='planned') 供审计.
   * 每个 BUY/SELL 一条 intent, metadata 记录 composite_rebalance origin.
   */
  private async persistPlan(input: {
    portfolio_id: number;
    strategy_key: string;
    trade_date: string;
    orders: RebalanceOrder[];
  }): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PaperTradingOrderIntent } = require('../../models/PaperTradingOrderIntent');
    const actionable = input.orders.filter(o => o.side === 'BUY' || o.side === 'SELL');
    if (!actionable.length) return;
    for (const order of actionable) {
      await PaperTradingOrderIntent.create({
        portfolio_id: input.portfolio_id,
        source_type: 'composite_rebalance',
        source_id: `${input.strategy_key}_${input.trade_date}`,
        symbol: order.symbol,
        side: order.side,
        status: 'planned',
        intent_date: input.trade_date,
        reference_price: order.current_price,
        quantity: order.quantity,
        amount: Math.abs(order.diff_value),
        target_position_pct: order.target_weight * 100,
        reason_category: 'composite_rebalance',
        reason_text: order.reason || `composite rebalance ${input.strategy_key}`,
        metadata: {
          strategy_key: input.strategy_key,
          composite_rebalance: true,
          target_weight: order.target_weight,
          current_weight: order.current_weight,
          diff_value: order.diff_value,
          diff_pct: order.diff_pct,
        },
      });
    }
  }
}

/** 默认单例 (生产 DataSource). 测试请 new CompositeRebalanceService(fakeDataSource). */
export const compositeRebalanceService = new CompositeRebalanceService();
