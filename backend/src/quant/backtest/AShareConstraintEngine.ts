/**
 * AShareConstraintEngine — A 股回测真实约束引擎（US-014）。
 *
 * 把 A 股特有的"能不能成交 / 几钱成交 / 成交要交多少钱"全部封装在一个纯模块里,
 * 让 QuantBacktestEngine 只负责高层撮合调度。引擎本身**无状态、无 DB 依赖**,
 * 易于单元测试且可在策略层独立调用做"假设成交分析"。
 *
 * 包含的规则族：
 *   1. T+1 当日买入不可卖（A 股核心铁律）
 *   2. 涨停日不可买入（板上不能开仓）
 *   3. 跌停日不可卖出（封死跌停 sell 不到货）
 *   4. 停牌日跳过（成交量 0 + 成交额 0 视为停牌）
 *   5. ST / *ST 股按 settings 过滤
 *
 * 费率模型（默认值匹配主流互联网券商）：
 *   - 佣金（commission）：双边万 2.5，最低 5 元
 *   - 印花税（stamp tax）：卖出单边千 1
 *   - 过户费（transfer fee）：双边万 0.1（沪深两市统一收取）
 *
 * 执行价模型：
 *   - 'next_open'：默认。次日开盘价 + 0.2% 滑点（买高卖低）
 *   - 'same_close'：当日收盘价 + 0.2% 滑点（同收回测常用）
 *   - 'twap_proxy'：当日均价（high+low+close+open）/4 + 0.2% 滑点
 *                  （龙头/短线策略常用——日内 VWAP 的代理）
 *
 * 设计约束（US-014 落地，未来扩展前请阅读）：
 *   - **纯函数**：所有方法都是无状态/无 DB 访问/无副作用的同步函数。
 *     这样回测引擎并发跑多策略时不会有状态污染，单测也零依赖。
 *   - **错误类型固化为 enum 字符串**（RejectionReason）：所有拒单原因必须是
 *     这个 enum 里的字面量，否则下游聚合统计 / UI 展示会零散。新增原因
 *     必须先扩 enum 再用。
 *   - **不修改输入**：bar 等参数一律视为 immutable；返回新对象。这条对
 *     QuantBacktestEngine 的执行路径很重要——同 bar 可能被多个策略评估,
 *     任何 mutate 都会跨策略串味。
 *   - **不假定调用顺序**：上游何时调 evaluateOrder / 何时调 computeFees 引擎
 *     都不关心，没有"必须先 evaluate"之类的隐性合约。
 */

import type { QuantBar } from '../types/QuantTypes';
import { isSTName } from '../../utils/stNameUtils';
import {
  inferMarketSegment,
  getLimitPrices,
  isAtLimitUp as marketIsAtLimitUp,
  isAtLimitDown as marketIsAtLimitDown,
  roundToTick,
  MarketSegment,
} from '../marketLimits';

// ---------------------------------------------------------------- 类型与常量

export type TradeSide = 'buy' | 'sell';
export type ExecutionTiming = 'next_open' | 'same_close' | 'twap_proxy';

/**
 * 拒单原因枚举。所有原因码集中在此 — 下游聚合 / UI 直接对照该 enum。
 * 务必保持小写蛇形格式，便于 grep。
 */
export const RejectionReason = {
  T_PLUS_ONE: 't_plus_one_block',
  LIMIT_UP_BLOCK_BUY: 'limit_up_block_buy',
  LIMIT_DOWN_BLOCK_SELL: 'limit_down_block_sell',
  SUSPENDED_OR_ZERO_VOLUME: 'suspended_or_zero_volume',
  ST_FILTERED: 'st_filtered',
  TURNOVER_BELOW_THRESHOLD: 'turnover_below_threshold',
  NEXT_BAR_MISSING: 'next_bar_missing',
  NEXT_EXIT_BAR_MISSING: 'next_exit_bar_missing',
  MAX_POSITIONS: 'max_positions',
  ALREADY_HOLDING: 'already_holding',
  LOT_OR_CASH_TOO_SMALL: 'lot_or_cash_too_small',
  CASH_NOT_ENOUGH: 'cash_not_enough',
} as const;
export type RejectionReasonValue = (typeof RejectionReason)[keyof typeof RejectionReason];

export interface ConstraintSettings {
  /** T+1 启用：默认 true（A 股核心规则）。回测短线策略想假设 T+0 时可设 false */
  enable_t_plus_one: boolean;
  /** 涨停板买入拦截：默认 true */
  block_limit_up: boolean;
  /** 跌停板卖出拦截：默认 true */
  block_limit_down: boolean;
  /** 停牌（成交量为 0）拦截：默认 true */
  block_suspended: boolean;
  /** ST 股过滤：默认 true（散户级风险偏好）。回测高风险策略可设 false */
  block_st_stocks: boolean;
  /** 涨停判定阈值（百分比）：默认 9.8。科创板 / 创业板可调到 19.8 */
  limit_up_pct: number;
  /** 跌停判定阈值（百分比）：默认 -9.8 */
  limit_down_pct: number;
  /** 最小成交额过滤（元）：低于此值视为流动性不足，拦截。默认 0 关闭 */
  min_turnover_yuan: number;
}

export const DEFAULT_CONSTRAINT_SETTINGS: ConstraintSettings = {
  enable_t_plus_one: true,
  block_limit_up: true,
  block_limit_down: true,
  block_suspended: true,
  block_st_stocks: true,
  limit_up_pct: 9.8,
  limit_down_pct: -9.8,
  min_turnover_yuan: 0,
};

/**
 * 费率配置（默认值匹配主流互联网券商如华泰/国君/中信 2024-2026 报价）。
 *
 * 佣金双边万 2.5（含最低 5 元）：commission = max(amount * 0.00025, 5)
 * 印花税卖出单边千 1：stamp_tax = (side==='sell') ? amount * 0.001 : 0
 * 过户费双边万 0.1：transfer_fee = amount * 0.00001
 */
export interface FeeSettings {
  /** 佣金费率（双边），默认 0.00025（万 2.5） */
  commission_rate: number;
  /** 最低佣金（每笔），默认 5 元 */
  min_commission: number;
  /** 印花税率（仅卖出），默认 0.001（千 1） */
  stamp_tax_rate: number;
  /** 过户费率（双边），默认 0.00001（万 0.1） */
  transfer_fee_rate: number;
}

export const DEFAULT_FEE_SETTINGS: FeeSettings = {
  commission_rate: 0.00025,
  min_commission: 5,
  stamp_tax_rate: 0.001,
  transfer_fee_rate: 0.00001,
};

export interface SlippageSettings {
  /** 基础滑点率（小数，0.002 表示 0.2%）。默认 0.002 */
  slippage_rate: number;
  /** 启用按成交额动态调整滑点（成交额越小滑点越大），默认 true */
  dynamic: boolean;
}

export const DEFAULT_SLIPPAGE_SETTINGS: SlippageSettings = {
  slippage_rate: 0.002,
  dynamic: true,
};

export interface FeeBreakdown {
  /** 成交金额（数量 * 价格），不含费用 */
  amount: number;
  /** 佣金（双边） */
  commission: number;
  /** 印花税（仅卖出，买入为 0） */
  stamp_tax: number;
  /** 过户费（双边） */
  transfer_fee: number;
  /** 总费用 = commission + stamp_tax + transfer_fee */
  total_cost: number;
}

export interface ExecutionPriceResult {
  /** 基准价（未含滑点） */
  base_price: number;
  /** 滑点率（小数）—— 已经按动态规则放大过 */
  slippage_rate: number;
  /** 单股滑点成本（元，绝对值） */
  slippage_cost: number;
  /** 含滑点的成交价 */
  price: number;
  /** 价格来源（next_open / same_close / twap_proxy）—— 便于审计 */
  source: ExecutionTiming;
}

/**
 * 订单评估结果。
 *
 * 设计要点：评估失败时返回 ok=false + reason + detail（人类可读补充信息）,
 * 不抛异常。让回测引擎统一通过 `if (!result.ok) record rejection()` 处理。
 */
export interface OrderEvaluation {
  /** 是否允许成交 */
  ok: boolean;
  /** 拒单原因（仅 ok=false 时存在）— enum 值便于聚合 */
  reason?: RejectionReasonValue;
  /** 人类可读补充（如 "涨停 9.95%, 阈值 9.8%"），供 RejectedOrder.detail 直接展示 */
  detail?: string;
}

/**
 * 评估订单上下文。所有字段都是引擎计算所需的最小输入。
 */
export interface EvaluateOrderContext {
  side: TradeSide;
  bar: QuantBar;
  /** ST 过滤需要的股票名（"ST嘉凯城" / "*ST海马" 等）。可选 — 不传则跳过 ST 检查 */
  stock_name?: string | null;
  /** 仅 side='sell' 且 enable_t_plus_one=true 时使用 */
  buy_date?: string;
  /** 当前评估日期（与 buy_date 比较算 T+1） */
  trade_date: string;
  settings?: Partial<ConstraintSettings>;
  /**
   * audit S-2 修复：股票代码。当 prev_close 也传入时, evaluateOrder 会按市场段
   * (主板 10% / 创业板 20% / 科创板 20% / 北交所 30% / ST 5%) 算出真实涨跌停
   * 价然后用 bar.open/high/low/close 比较, 而不是用单一 `limit_up_pct` + bar.
   * change_percent (口径错且未来信息)。**强烈建议传入** — 不传时回退到旧的
   * `change_percent` 估算路径并打一条 warn。
   */
  symbol?: string;
  /**
   * audit S-2/S-4 修复：T 日开盘前已知的 prev_close (前一交易日 close)。
   * 用来按市场段算精确涨跌停价。**强烈建议传入** — 不传时只能用 bar.change_percent
   * (这是当日收盘后才有的信息, 同 day 撮合本质上是 lookahead-bias)。
   */
  prev_close?: number | null;
}

// ---------------------------------------------------------------- 工具函数

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function diffDaysISO(start: string, end: string): number {
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86400000));
}

/**
 * ST 名称检测 — 重新导出自 `backend/src/utils/stNameUtils.ts`（US-025 抽取）。
 * 任何判定逻辑变更只改共享模块；回测引擎与策略层保持判定一致。
 */
export { isSTName };

// ---------------------------------------------------------------- 引擎

export class AShareConstraintEngine {
  constructor(
    private settings: ConstraintSettings = DEFAULT_CONSTRAINT_SETTINGS,
    private fees: FeeSettings = DEFAULT_FEE_SETTINGS,
    private slippage: SlippageSettings = DEFAULT_SLIPPAGE_SETTINGS
  ) {}

  /**
   * 评估一笔订单是否可以成交。
   *
   * 按"早过滤先做"顺序：
   *   1. 停牌（volume<=0 && turnover<=0）  — 最便宜的检查
   *   2. ST 名称（仅当 block_st_stocks=true 且传入 stock_name）
   *   3. 流动性最低门槛（仅当 min_turnover_yuan > 0）
   *   4. 涨跌停（仅当对应方向被设 block）
   *   5. T+1（仅 side='sell' 且 enable_t_plus_one=true）
   */
  evaluateOrder(ctx: EvaluateOrderContext): OrderEvaluation {
    const settings = { ...this.settings, ...(ctx.settings || {}) };

    // (1) 停牌
    if (settings.block_suspended && this.isSuspended(ctx.bar)) {
      return {
        ok: false,
        reason: RejectionReason.SUSPENDED_OR_ZERO_VOLUME,
        detail: 'volume=0 视为停牌',
      };
    }

    // (2) ST 过滤
    if (settings.block_st_stocks && isSTName(ctx.stock_name)) {
      return {
        ok: false,
        reason: RejectionReason.ST_FILTERED,
        detail: `ST/*ST 股名命中: ${ctx.stock_name}`,
      };
    }

    // (3) 流动性门槛
    if (settings.min_turnover_yuan > 0) {
      const turnover = this.resolveTurnover(ctx.bar);
      if (turnover < settings.min_turnover_yuan) {
        return {
          ok: false,
          reason: RejectionReason.TURNOVER_BELOW_THRESHOLD,
          detail: `成交额 ${turnover.toFixed(0)} 元 < 阈值 ${settings.min_turnover_yuan} 元`,
        };
      }
    }

    // (4) 涨跌停 (audit S-2 修复)
    //   优先路径: 用 symbol + prev_close + market segment 算精确涨跌停价
    //            (主板 10% / 创业板 20% / 科创板 20% / 北交所 30% / ST 5%)
    //   回退路径: 单一 `limit_up_pct` + bar.change_percent (历史路径, 已 deprecated)
    const isST = isSTName(ctx.stock_name);
    const usePreciseLimit =
      typeof ctx.symbol === 'string' &&
      ctx.symbol.length > 0 &&
      typeof ctx.prev_close === 'number' &&
      Number.isFinite(ctx.prev_close) &&
      ctx.prev_close > 0;

    if (usePreciseLimit) {
      const segment: MarketSegment = inferMarketSegment(ctx.symbol!);
      // 严格用 prev_close-based limit price + bar.open/high/low/close 任一命中
      if (ctx.side === 'buy' && settings.block_limit_up) {
        const { upper } = getLimitPrices(ctx.prev_close as number, segment, isST);
        if (marketIsAtLimitUp(ctx.bar, segment, isST, ctx.prev_close as number)) {
          return {
            ok: false,
            reason: RejectionReason.LIMIT_UP_BLOCK_BUY,
            detail: `涨停 (${segment}${isST ? '+ST' : ''}) prev_close=${(
              ctx.prev_close as number
            ).toFixed(2)} limit=${upper.toFixed(2)}`,
          };
        }
      }
      if (ctx.side === 'sell' && settings.block_limit_down) {
        const { lower } = getLimitPrices(ctx.prev_close as number, segment, isST);
        if (marketIsAtLimitDown(ctx.bar, segment, isST, ctx.prev_close as number)) {
          return {
            ok: false,
            reason: RejectionReason.LIMIT_DOWN_BLOCK_SELL,
            detail: `跌停 (${segment}${isST ? '+ST' : ''}) prev_close=${(
              ctx.prev_close as number
            ).toFixed(2)} limit=${lower.toFixed(2)}`,
          };
        }
      }
    } else {
      // 回退路径: 用 change_percent (历史口径, lookahead-biased)。
      // 任何调用方都应当传 symbol + prev_close，本路径仅为向后兼容旧测试。
      const changePercent = toNumber(ctx.bar.change_percent, 0);
      if (ctx.side === 'buy' && settings.block_limit_up && changePercent >= settings.limit_up_pct) {
        return {
          ok: false,
          reason: RejectionReason.LIMIT_UP_BLOCK_BUY,
          detail: `涨幅 ${changePercent.toFixed(2)}% ≥ 阈值 ${
            settings.limit_up_pct
          }% (legacy 路径, 建议传入 symbol+prev_close)`,
        };
      }
      if (
        ctx.side === 'sell' &&
        settings.block_limit_down &&
        changePercent <= settings.limit_down_pct
      ) {
        return {
          ok: false,
          reason: RejectionReason.LIMIT_DOWN_BLOCK_SELL,
          detail: `跌幅 ${changePercent.toFixed(2)}% ≤ 阈值 ${
            settings.limit_down_pct
          }% (legacy 路径, 建议传入 symbol+prev_close)`,
        };
      }
    }

    // (5) T+1（仅卖出）
    if (
      ctx.side === 'sell' &&
      settings.enable_t_plus_one &&
      ctx.buy_date &&
      diffDaysISO(ctx.buy_date, ctx.trade_date) < 1
    ) {
      return {
        ok: false,
        reason: RejectionReason.T_PLUS_ONE,
        detail: `当日买入(${ctx.buy_date}) 同日卖出被 T+1 拦截`,
      };
    }

    return { ok: true };
  }

  /**
   * 计算执行价（含滑点）。
   *
   * - 'next_open'：取 bar.open（回退到 bar.close）
   * - 'same_close'：取 bar.close（回退到 bar.open）
   * - 'twap_proxy'：取 (open+high+low+close)/4 — 日内 VWAP 的简单代理
   *   适合短线/龙头策略，比 next_open 更难"完美捕捉"开盘脉冲
   *
   * 滑点：买入 +slippage，卖出 -slippage。动态滑点按 turnover 分段：
   *   - turnover ≤ 0 → slippage * 2（流动性极差）
   *   - turnover < 30M → slippage * 1.8
   *   - turnover < 100M → slippage * 1.25
   *   - 其他 → slippage * 1.0
   */
  executionPrice(
    bar: QuantBar,
    side: TradeSide,
    timing: ExecutionTiming = 'next_open'
  ): ExecutionPriceResult {
    let basePrice: number;
    switch (timing) {
      case 'next_open':
        basePrice = toNumber(bar.open || bar.close, 0);
        break;
      case 'same_close':
        basePrice = toNumber(bar.close || bar.open, 0);
        break;
      case 'twap_proxy': {
        const o = toNumber(bar.open, 0);
        const h = toNumber(bar.high, 0);
        const l = toNumber(bar.low, 0);
        const c = toNumber(bar.close, 0);
        // 任一为 0 都跳过；用非零项均值兜底
        const nonZero = [o, h, l, c].filter(v => v > 0);
        basePrice = nonZero.length ? nonZero.reduce((s, v) => s + v, 0) / nonZero.length : 0;
        break;
      }
      default: {
        // 防御性：若新增了 timing 但忘记更新这里，TS exhaustiveness 在编译期会报错
        const _exhaustive: never = timing;
        throw new Error(`unknown execution timing: ${_exhaustive}`);
      }
    }

    const slippageRate = this.resolveSlippageRate(bar);
    const rawPrice = basePrice * (side === 'buy' ? 1 + slippageRate : 1 - slippageRate);
    // audit S-2 修复: 撮合价 round 到 A 股 0.01 tick (券商客户端口径)。
    const price = roundToTick(rawPrice);

    return {
      base_price: basePrice,
      slippage_rate: slippageRate,
      slippage_cost: Math.abs(price - basePrice),
      price,
      source: timing,
    };
  }

  /**
   * 计算单笔成交的全部费用。
   *
   * 买入：commission + transfer_fee（无印花税）
   * 卖出：commission + transfer_fee + stamp_tax
   */
  computeFees(amount: number, side: TradeSide): FeeBreakdown {
    const commission = Math.max(amount * this.fees.commission_rate, this.fees.min_commission);
    const transfer_fee = amount * this.fees.transfer_fee_rate;
    const stamp_tax = side === 'sell' ? amount * this.fees.stamp_tax_rate : 0;
    return {
      amount,
      commission,
      stamp_tax,
      transfer_fee,
      total_cost: commission + stamp_tax + transfer_fee,
    };
  }

  /** 当前生效的约束设置（已 merge 默认值）—— 供调用方写入回测 metrics。 */
  getSettings(): ConstraintSettings {
    return { ...this.settings };
  }

  /** 当前生效的费率设置 —— 供调用方写入回测 metrics 便于审计。 */
  getFees(): FeeSettings {
    return { ...this.fees };
  }

  /** 当前生效的滑点设置 */
  getSlippageSettings(): SlippageSettings {
    return { ...this.slippage };
  }

  // ---------------------------------------------------------------- 内部工具

  private isSuspended(bar: QuantBar): boolean {
    const volume = toNumber(bar.volume, 0);
    const turnover = this.resolveTurnover(bar);
    return volume <= 0 && turnover <= 0;
  }

  private resolveTurnover(bar: QuantBar): number {
    const persistedTurnover = toNumber(bar.turnover ?? bar.amount, 0);
    if (persistedTurnover > 0) return persistedTurnover;
    const volume = toNumber(bar.volume, 0);
    const close = toNumber(bar.close || bar.open, 0);
    if (volume > 0 && close > 0) return volume * close;
    return 0;
  }

  private resolveSlippageRate(bar: QuantBar): number {
    if (!this.slippage.dynamic) return this.slippage.slippage_rate;
    const turnover = this.resolveTurnover(bar);
    if (turnover <= 0) return this.slippage.slippage_rate * 2;
    if (turnover < 30_000_000) return this.slippage.slippage_rate * 1.8;
    if (turnover < 100_000_000) return this.slippage.slippage_rate * 1.25;
    return this.slippage.slippage_rate;
  }
}

/**
 * 默认实例 —— 同款配置（默认 settings + 默认 fees + 默认 slippage）。
 * 回测引擎一般持有自己的 settings 与 fees，不强行复用此实例。
 */
export const aShareConstraintEngine = new AShareConstraintEngine();
