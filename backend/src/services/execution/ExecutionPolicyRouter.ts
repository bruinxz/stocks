/**
 * Sprint 41-E: ExecutionPolicyRouter — 按订单规模/流动性/波动率选择执行 policy
 *
 * "很多量化系统不死在选股, 死在执行" — 同一个 BUY 信号:
 *   - 小单直接限价单贴价
 *   - 中单 VWAP / TWAP 减少冲击
 *   - 大单 POV 限制参与率
 *   - 高波动 / 低流动 / 临近涨停 → skip 或等
 *
 * 本 service 把 ExecutionFeasibility 已经做的"能不能成交"升级成"该怎么成交":
 *   输入: { symbol, side, amount_yuan, avg_daily_turnover, current_volatility,
 *           spread_pct, is_gap_up, close_to_limit_up_pct, urgency }
 *   输出: { policy: 'LIMIT'|'TWAP'|'VWAP'|'POV'|'WAIT_5M'|'WAIT_15M'|'WAIT_30M'|'SKIP',
 *           slice_count, participation_rate, max_slippage_pct, wait_minutes, reason }
 *
 * 设计要点:
 *   1. **纯函数 routing**: routeExecutionPolicy(input) → result, 全 export 单测脱依赖
 *   2. **policy 优先级链**: SKIP 硬条件 > WAIT 时机条件 > 按规模分流 LIMIT/TWAP/VWAP/POV
 *   3. **Threshold Object.freeze**: 默认阈值可被 caller override 但不能 mutate 默认
 *   4. **MetaData 透传**: 输出 reason 含每个判定的具体阈值 + 实际值, 便于运维 debug
 *   5. **下游集成 (Sprint 41-E+ 留接口)**: PaperTradingFacade.placeOrder 可在下单前
 *      调本 router 选 policy, 然后 execute 时按 policy 拆单 / 等待 / 限价
 */

import { logger } from '../../utils/logger';

// ===========================================================================
// Types
// ===========================================================================

export type ExecutionPolicy =
  | 'LIMIT_AT_TOUCH'
  | 'TWAP'
  | 'VWAP'
  | 'POV'
  | 'WAIT_5M'
  | 'WAIT_15M'
  | 'WAIT_30M'
  | 'SKIP';

export type OrderUrgency = 'low' | 'normal' | 'high';

export interface ExecutionPolicyInput {
  symbol: string;
  side: 'BUY' | 'SELL';
  /** 拟下单金额 (元) */
  amount_yuan: number;
  /** 近 N 日 (典型 20) 平均日成交额 (元) */
  avg_daily_turnover: number;
  /** 当日实时波动率, ATR % 或近 N 分钟收益率标准差 (0.01 = 1%) */
  current_volatility: number;
  /** 当前 spread (ask - bid) / mid 比例 (0.001 = 0.1%) */
  spread_pct: number;
  /** 当日是否高/低开 > 3% (开盘跳空) */
  is_gap_up: boolean;
  /** 距涨停板剩余空间 % (0.01 = 1%); SELL 时是距跌停板 */
  close_to_limit_up_pct: number;
  /** 信号紧急度: low=耐心拆单, normal=平衡, high=尽快成交 */
  urgency?: OrderUrgency;
  options?: Partial<ExecutionPolicyOptions>;
}

export interface ExecutionPolicyOptions {
  /** amount/turnover 比例阈值: 低于此用 LIMIT 直接吃单 (默认 0.005 = 0.5%) */
  small_order_pct_of_turnover: number;
  /** TWAP 阈值 (默认 0.02 = 2%) */
  medium_order_pct_of_turnover: number;
  /** VWAP 阈值 (默认 0.05 = 5%) */
  large_order_pct_of_turnover: number;
  /** POV 参与率上限 (默认 0.10 = 10%) */
  pov_participation_rate: number;
  /** 波动率 SKIP 阈值 (默认 0.05 = 5% / day) */
  skip_volatility_threshold: number;
  /** 距涨停 SKIP 阈值 (默认 0.02 = 2%; BUY 时距涨停板太近不追) */
  skip_close_to_limit_pct: number;
  /** spread SKIP 阈值 (默认 0.005 = 0.5%) */
  skip_spread_pct: number;
  /** gap_up + urgency='low' 时等待分钟数 */
  gap_wait_minutes_low: number;
  /** gap_up + urgency='normal' 时等待分钟数 */
  gap_wait_minutes_normal: number;
  /** TWAP slice count 默认 */
  twap_slice_count_default: number;
  /** VWAP slice count 默认 */
  vwap_slice_count_default: number;
}

export const DEFAULT_EXECUTION_POLICY_OPTIONS: ExecutionPolicyOptions = Object.freeze({
  small_order_pct_of_turnover: 0.005,
  medium_order_pct_of_turnover: 0.02,
  large_order_pct_of_turnover: 0.05,
  pov_participation_rate: 0.1,
  skip_volatility_threshold: 0.05,
  skip_close_to_limit_pct: 0.02,
  skip_spread_pct: 0.005,
  gap_wait_minutes_low: 30,
  gap_wait_minutes_normal: 15,
  twap_slice_count_default: 5,
  vwap_slice_count_default: 8,
}) as ExecutionPolicyOptions;

export interface ExecutionPolicyResult {
  policy: ExecutionPolicy;
  /** TWAP/VWAP 拆几片; LIMIT/SKIP/WAIT 时 = 1 */
  slice_count: number;
  /** POV 参与率 (0-1) */
  participation_rate: number;
  /** 拟最大滑点容忍 % */
  max_slippage_pct: number;
  /** WAIT 时长 (分钟) */
  wait_minutes: number;
  /** amount / avg_turnover 比例 (诊断用) */
  order_size_pct: number;
  /** 判定理由链 */
  reason: string;
  options: ExecutionPolicyOptions;
}

// ===========================================================================
// Pure helpers (all exported for testing)
// ===========================================================================

export function normalizeExecutionPolicyOptions(
  input?: Partial<ExecutionPolicyOptions>
): ExecutionPolicyOptions {
  const def = DEFAULT_EXECUTION_POLICY_OPTIONS;
  if (!input) return def;
  const out: ExecutionPolicyOptions = { ...def };
  const numKeys: Array<keyof ExecutionPolicyOptions> = [
    'small_order_pct_of_turnover',
    'medium_order_pct_of_turnover',
    'large_order_pct_of_turnover',
    'pov_participation_rate',
    'skip_volatility_threshold',
    'skip_close_to_limit_pct',
    'skip_spread_pct',
    'gap_wait_minutes_low',
    'gap_wait_minutes_normal',
    'twap_slice_count_default',
    'vwap_slice_count_default',
  ];
  for (const k of numKeys) {
    const v = Number((input as any)[k]);
    if (Number.isFinite(v) && v >= 0) (out as any)[k] = v;
  }
  return out;
}

/**
 * 判定是否应 SKIP. 高 vol / 临近涨停 / 大 spread 任一触发即 SKIP.
 *
 * 注意: spread 计算只在大单时严苛; 小单 spread 影响有限.
 */
export function shouldSkip(
  input: ExecutionPolicyInput,
  opts: ExecutionPolicyOptions
): { skip: boolean; reason: string } {
  if (input.current_volatility >= opts.skip_volatility_threshold) {
    return {
      skip: true,
      reason: `vol=${(input.current_volatility * 100).toFixed(2)}% >= skip 阈值 ${(
        opts.skip_volatility_threshold * 100
      ).toFixed(2)}%`,
    };
  }
  if (input.side === 'BUY' && input.close_to_limit_up_pct <= opts.skip_close_to_limit_pct) {
    return {
      skip: true,
      reason: `距涨停 ${(input.close_to_limit_up_pct * 100).toFixed(2)}% <= 阈值 ${(
        opts.skip_close_to_limit_pct * 100
      ).toFixed(2)}%, 不追涨停`,
    };
  }
  // spread 限制仅 medium+ 单
  const size_pct = input.avg_daily_turnover > 0 ? input.amount_yuan / input.avg_daily_turnover : 1;
  if (size_pct >= opts.medium_order_pct_of_turnover && input.spread_pct >= opts.skip_spread_pct) {
    return {
      skip: true,
      reason: `中大单 (size=${(size_pct * 100).toFixed(2)}%) 遭遇 spread=${(
        input.spread_pct * 100
      ).toFixed(3)}% >= 阈值 ${(opts.skip_spread_pct * 100).toFixed(3)}%`,
    };
  }
  return { skip: false, reason: '' };
}

/**
 * 判定是否应 WAIT (开盘跳空时机).
 */
export function shouldWait(
  input: ExecutionPolicyInput,
  opts: ExecutionPolicyOptions
): { wait_minutes: number; reason: string } {
  if (!input.is_gap_up) return { wait_minutes: 0, reason: '' };
  const urgency = input.urgency || 'normal';
  if (urgency === 'high') return { wait_minutes: 0, reason: '' }; // 紧急信号不等
  if (urgency === 'low') {
    return {
      wait_minutes: opts.gap_wait_minutes_low,
      reason: `跳空 + 低紧急度 → 等 ${opts.gap_wait_minutes_low} 分钟确认`,
    };
  }
  return {
    wait_minutes: opts.gap_wait_minutes_normal,
    reason: `跳空 + 中等紧急度 → 等 ${opts.gap_wait_minutes_normal} 分钟确认`,
  };
}

/**
 * 按订单规模分流 LIMIT/TWAP/VWAP/POV.
 */
export function pickSizeBasedPolicy(
  size_pct: number,
  opts: ExecutionPolicyOptions
): { policy: ExecutionPolicy; slice_count: number; participation_rate: number; reason: string } {
  if (size_pct < opts.small_order_pct_of_turnover) {
    return {
      policy: 'LIMIT_AT_TOUCH',
      slice_count: 1,
      participation_rate: 0,
      reason: `小单 (size=${(size_pct * 100).toFixed(3)}% < ${(
        opts.small_order_pct_of_turnover * 100
      ).toFixed(2)}%) → 限价单贴买/卖一档`,
    };
  }
  if (size_pct < opts.medium_order_pct_of_turnover) {
    return {
      policy: 'TWAP',
      slice_count: opts.twap_slice_count_default,
      participation_rate: 0,
      reason: `中单 (size=${(size_pct * 100).toFixed(3)}%) → TWAP ${
        opts.twap_slice_count_default
      } 切片均匀执行`,
    };
  }
  if (size_pct < opts.large_order_pct_of_turnover) {
    return {
      policy: 'VWAP',
      slice_count: opts.vwap_slice_count_default,
      participation_rate: 0,
      reason: `中-大单 (size=${(size_pct * 100).toFixed(3)}%) → VWAP ${
        opts.vwap_slice_count_default
      } 切片按成交量分布执行`,
    };
  }
  return {
    policy: 'POV',
    slice_count: 0, // POV 不分固定切片
    participation_rate: opts.pov_participation_rate,
    reason: `大单 (size=${(size_pct * 100).toFixed(3)}% >= ${(
      opts.large_order_pct_of_turnover * 100
    ).toFixed(2)}%) → POV 参与率 cap ${(opts.pov_participation_rate * 100).toFixed(0)}%`,
  };
}

// ===========================================================================
// Main router
// ===========================================================================

/**
 * 主入口: 给定订单 input → execution policy.
 *
 * 优先级:
 *   1. SKIP (硬约束) - 高 vol / 临近涨停 / 大 spread
 *   2. WAIT (开盘跳空 + 非紧急)
 *   3. 按 size 分流 LIMIT / TWAP / VWAP / POV
 */
export function routeExecutionPolicy(input: ExecutionPolicyInput): ExecutionPolicyResult {
  const opts = normalizeExecutionPolicyOptions(input.options);
  const size_pct = input.avg_daily_turnover > 0 ? input.amount_yuan / input.avg_daily_turnover : 1;

  // 1. SKIP 硬约束
  const skip = shouldSkip(input, opts);
  if (skip.skip) {
    return {
      policy: 'SKIP',
      slice_count: 1,
      participation_rate: 0,
      max_slippage_pct: 0,
      wait_minutes: 0,
      order_size_pct: size_pct,
      reason: `SKIP: ${skip.reason}`,
      options: opts,
    };
  }

  // 2. WAIT 时机
  const wait = shouldWait(input, opts);
  if (wait.wait_minutes > 0) {
    const policy: ExecutionPolicy =
      wait.wait_minutes >= 30 ? 'WAIT_30M' : wait.wait_minutes >= 15 ? 'WAIT_15M' : 'WAIT_5M';
    return {
      policy,
      slice_count: 1,
      participation_rate: 0,
      max_slippage_pct: 0,
      wait_minutes: wait.wait_minutes,
      order_size_pct: size_pct,
      reason: `WAIT: ${wait.reason}`,
      options: opts,
    };
  }

  // 3. size-based
  const sized = pickSizeBasedPolicy(size_pct, opts);
  // max slippage 按 policy 设默认
  const max_slippage_pct =
    sized.policy === 'LIMIT_AT_TOUCH'
      ? 0.002
      : sized.policy === 'TWAP'
      ? 0.003
      : sized.policy === 'VWAP'
      ? 0.005
      : 0.008; // POV
  return {
    policy: sized.policy,
    slice_count: sized.slice_count,
    participation_rate: sized.participation_rate,
    max_slippage_pct,
    wait_minutes: 0,
    order_size_pct: size_pct,
    reason: sized.reason,
    options: opts,
  };
}

// ===========================================================================
// Service wrapper (for stateless usage from automation pipeline)
// ===========================================================================

export class ExecutionPolicyRouter {
  /**
   * Main API: route a single order.
   */
  route(input: ExecutionPolicyInput): ExecutionPolicyResult {
    try {
      return routeExecutionPolicy(input);
    } catch (error: any) {
      logger.warn(
        `ExecutionPolicyRouter ${input.symbol} ${input.side} 失败 (fallback LIMIT): ${
          error?.message || error
        }`
      );
      return {
        policy: 'LIMIT_AT_TOUCH',
        slice_count: 1,
        participation_rate: 0,
        max_slippage_pct: 0.005,
        wait_minutes: 0,
        order_size_pct: 0,
        reason: `error fallback: ${error?.message || error}`,
        options: DEFAULT_EXECUTION_POLICY_OPTIONS,
      };
    }
  }

  /**
   * 估算给定 policy 的 cost (% of trade amount), 给 EVDecisionService 用.
   */
  estimateCostPct(result: ExecutionPolicyResult): number {
    // commission 0.025% × 2 (买+卖) = 0.05%
    // slippage = max_slippage_pct (单边, 来回 × 2)
    // impact = POV/VWAP 比 LIMIT 高一倍
    const commission = 0.0005;
    const slippage = result.max_slippage_pct * 2;
    const impact =
      result.policy === 'POV'
        ? 0.002
        : result.policy === 'VWAP'
        ? 0.001
        : result.policy === 'TWAP'
        ? 0.0005
        : 0.0002;
    return commission + slippage + impact;
  }
}

export const executionPolicyRouter = new ExecutionPolicyRouter();
