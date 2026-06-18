/**
 * PositionSizingPolicy — Phase 2 多元化仓位 sizing 策略
 *
 * 现状 (Phase 0)：PaperTradingAutomationService 只支持 "percent of equity" 一种
 * sizing 算法：`target_amount = total_equity * position_pct`。所有信号统一按
 * 固定百分比 sizing，不考虑信号 conviction 强弱、不考虑标的波动率、不做
 * Kelly 优化。
 *
 * Phase 2 把 sizing 算法抽出成可插拔策略，提供 4 种实现：
 *
 *   1. `equal_pct` (默认，向后兼容)
 *      target_amount = equity * position_pct
 *      规则简单、可预测，适合早期没有充足历史数据的策略。
 *
 *   2. `vol_target` (波动率目标)
 *      target_amount = equity * (vol_target / sigma) * conviction_multiplier
 *      让每个仓位贡献相同的"风险"（用 20 日年化波动率衡量）。
 *      高波动股拿小仓位，低波动股拿大仓位。配 cap 防止极端。
 *      引用：BridgeWater 的 Risk Parity 思想简化版。
 *
 *   3. `atr_based` (ATR 反比)
 *      target_amount = equity * risk_pct / (atr_n / current_price)
 *      每笔交易最多亏 risk_pct (e.g. 1%)，等价于 stop_loss 距离反比 sizing。
 *      引用：Turtle Trader / Van Tharp 经典做法。
 *
 *   4. `kelly` (分数凯利公式)
 *      Kelly fraction: f* = (p*b - q) / b
 *        - p = 历史胜率 (win_rate)
 *        - q = 1 - p
 *        - b = 平均盈利金额 / 平均亏损金额 (payoff_ratio)
 *      target_amount = equity * f* * kelly_fraction_multiplier
 *      实务中很少用满 Kelly（满 Kelly 波动太大），默认用 1/4 Kelly (multiplier=0.25)
 *      或 1/2 Kelly。需要策略至少有 50+ 笔历史交易才有统计意义。
 *      引用：Edward Thorp / Ralph Vince。
 *
 * **共同约束**：
 *   - 所有算法都受 `max_position_pct` (e.g. 12%) cap 限制
 *   - 受 `min_trade_amount` (现金阈值) 限制
 *   - 受 `available_cash` 限制
 *   - 输出 target_amount 后由 caller 按 lot_size (100 股) round down 成 quantity
 *
 * **纯函数 + 注入式**：模块本身不读 DB / 无 state；caller 准备好 SizingContext
 * (含 equity / atr / sigma / strategy_conviction 等输入)，policy 返回 sizing 结果。
 * 完全单测脱离 DB。
 *
 * **配置**：User.risk_config.sizing_policy JSONB:
 *   ```jsonc
 *   {
 *     "method": "equal_pct",  // 或 "vol_target" / "atr_based" / "kelly"
 *     "base_position_pct": 5,         // 用于 equal_pct 的基础仓位
 *     "max_position_pct": 12,         // 任何方法都不超过
 *     "vol_target_pct": 0.15,         // vol_target 用：年化目标波动 15%
 *     "vol_max_lookback_days": 20,    // vol 计算回看天数
 *     "atr_risk_pct": 1.0,            // atr_based 用：每笔最多亏 1% equity
 *     "atr_period": 14,               // ATR 计算周期
 *     "kelly_fraction_multiplier": 0.25,  // kelly 用：分数凯利 (1/4 Kelly 比较稳)
 *     "kelly_min_sample_size": 50     // kelly 用：低于这个 sample 数退化到 base
 *   }
 *   ```
 */

// ============================================================
// Types
// ============================================================

export type SizingMethod = 'equal_pct' | 'vol_target' | 'atr_based' | 'kelly';

/**
 * 单次 sizing 决策的输入上下文。
 */
export interface SizingContext {
  /** 当前账户总权益 (cash + market_value of positions) */
  equity: number;
  /** 可用现金 */
  available_cash: number;
  /** 信号目标股的最新价 */
  current_price: number;
  /** 信号目标股 20 日年化波动率 (annualized stddev, 比如 0.35 = 35%) */
  vol_annualized?: number;
  /** 信号目标股 N 期 ATR (与 current_price 同单位) */
  atr?: number;
  /** 策略层面的 conviction 倍数（默认 1.0）；可以让强信号自动放大仓位 */
  conviction_multiplier?: number;
  /** 单笔最少交易金额（A 股一般 5000 起步） */
  min_trade_amount?: number;
  /** 单股最大仓位百分比 cap (e.g. 12 = 12%) */
  max_position_pct: number;
  /** Phase 2+: Kelly sizing 用 — 历史胜率 (0-1)，从策略 outcome 聚合 */
  historical_win_rate?: number;
  /** Phase 2+: Kelly sizing 用 — 平均盈利金额 / 平均亏损金额 (>0)，从策略 outcome 聚合 */
  historical_payoff_ratio?: number;
  /** Phase 2+: Kelly sizing 用 — 历史交易样本数（< kelly_min_sample_size 退化到 base） */
  historical_sample_size?: number;
}

/**
 * Sizing policy 完整配置（来自 User.risk_config.sizing_policy）
 */
export interface SizingPolicyConfig {
  method: SizingMethod;
  /** equal_pct 用：基础仓位百分比 (默认 5%) */
  base_position_pct: number;
  /** 任何方法都不超过的最大仓位百分比 (默认 12%) */
  max_position_pct: number;
  /** vol_target 用：年化目标波动 (默认 0.15 = 15%) */
  vol_target_pct: number;
  /** vol 计算回看天数 (默认 20) */
  vol_max_lookback_days: number;
  /** atr_based 用：每笔最多亏 X% equity (默认 1%) */
  atr_risk_pct: number;
  /** ATR 计算周期 (默认 14) */
  atr_period: number;
  /** kelly 用：分数凯利乘数 (默认 0.25 = 1/4 Kelly，业界稳健选择) */
  kelly_fraction_multiplier: number;
  /** kelly 用：低于此样本量退化到 base_position_pct (默认 50 笔) */
  kelly_min_sample_size: number;
  /**
   * Phase 2+ 硬切换开关 (默认 false = shadow mode)。
   *
   * - false (默认): PaperTradingAutomationService 只计算 sizing 决策并写 log，
   *   实际下单仍走原有 effectiveTargetPct (equal_pct 行为)。让用户先观察 1-2 周
   *   shadow 数据对比再决定是否真的切换。
   * - true: PaperTradingAutomationService 用 decideSizing 计算的 position_pct
   *   替换 effectiveTargetPct，sizing 决策真正生效。
   *
   * 切换路径：先在 SettingsWorkspace 配 method=kelly/vol_target/atr_based 跑 shadow，
   * 观察 7-14 天 [shadow-sizing] log，确认 delta 合理后再 PATCH hard_cutover_enabled=true。
   */
  hard_cutover_enabled: boolean;
}

/**
 * 默认配置（向后兼容：method='equal_pct' 等于 Phase 0 行为）
 */
export const DEFAULT_SIZING_POLICY: Readonly<SizingPolicyConfig> = Object.freeze({
  method: 'equal_pct',
  base_position_pct: 5,
  max_position_pct: 12,
  vol_target_pct: 0.15,
  vol_max_lookback_days: 20,
  atr_risk_pct: 1.0,
  atr_period: 14,
  kelly_fraction_multiplier: 0.25,
  kelly_min_sample_size: 50,
  hard_cutover_enabled: false,
});

/**
 * Sizing 决策结果。
 */
export interface SizingDecision {
  /** 推荐 target_amount (元) */
  target_amount: number;
  /** 推荐百分比 (target_amount / equity * 100) — 用于日志可读性 */
  position_pct: number;
  /** 使用的 sizing method (caller 可以记录到 trade metadata) */
  method: SizingMethod;
  /** 决策原因 (人类可读) */
  reason: string;
  /** 是否触发了 max_position_pct cap */
  capped_by_max: boolean;
  /** 是否触发了 available_cash cap */
  capped_by_cash: boolean;
}

// ============================================================
// Pure helpers (independently unit-testable)
// ============================================================

/**
 * 把用户配置 normalize 到合法范围；不抛错。
 */
export function normalizeSizingPolicyConfig(input: any): SizingPolicyConfig {
  const safe = (v: any, fallback: number, min: number, max: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  const m = input?.method;
  const method: SizingMethod =
    m === 'vol_target' || m === 'atr_based' || m === 'kelly' ? m : 'equal_pct';
  return {
    method,
    base_position_pct: safe(input?.base_position_pct, 5, 0.5, 30),
    max_position_pct: safe(input?.max_position_pct, 12, 1, 50),
    vol_target_pct: safe(input?.vol_target_pct, 0.15, 0.05, 1.0),
    vol_max_lookback_days: safe(input?.vol_max_lookback_days, 20, 5, 252),
    atr_risk_pct: safe(input?.atr_risk_pct, 1.0, 0.1, 5.0),
    atr_period: safe(input?.atr_period, 14, 5, 60),
    kelly_fraction_multiplier: safe(input?.kelly_fraction_multiplier, 0.25, 0.05, 1.0),
    kelly_min_sample_size: safe(input?.kelly_min_sample_size, 50, 10, 500),
    hard_cutover_enabled:
      input?.hard_cutover_enabled === true || input?.hard_cutover_enabled === 'true',
  };
}

/**
 * 用 vol_target 算 target_amount。
 *
 * 公式：target_amount = equity * (vol_target_pct / sigma) * conviction
 *   - vol_target_pct = 15% 表示"每个仓位贡献年化 15% 波动"
 *   - sigma = 标的年化波动率
 *   - sigma 越大 → 仓位越小（风险均衡）
 *
 * 边界：
 *   - sigma <= 0 或 NaN → 退化到 base_position_pct * equity
 *   - vol_target_pct / sigma > 1 → cap 到 1 (避免 sigma 过小让仓位爆炸)
 *
 * @returns target_amount (元)，未受 max_position_pct cap 限制
 */
export function computeVolTargetSize(
  equity: number,
  vol_target_pct: number,
  sigma_annualized: number,
  conviction: number,
  base_position_pct: number
): number {
  if (!Number.isFinite(sigma_annualized) || sigma_annualized <= 0) {
    return (equity * base_position_pct) / 100;
  }
  const ratio = Math.min(1, vol_target_pct / sigma_annualized);
  return equity * ratio * Math.max(0.1, Math.min(3, conviction));
}

/**
 * 用 atr_based 算 target_amount。
 *
 * 公式：position_size_shares = (equity * risk_pct / 100) / atr
 *   target_amount = position_size_shares * current_price
 * 改写为：target_amount = (equity * risk_pct / 100) * current_price / atr
 *
 * 解读：每笔交易 stop_loss = atr 距离，所以最大亏损 = atr * shares = equity * risk_pct%
 *
 * 边界：
 *   - atr <= 0 或 NaN → 退化到 base_position_pct * equity
 *   - target_amount > equity → cap 到 equity（不能超 100%）
 *
 * @returns target_amount (元)，未受 max_position_pct cap 限制
 */
export function computeAtrBasedSize(
  equity: number,
  atr_risk_pct: number,
  atr: number,
  current_price: number,
  base_position_pct: number
): number {
  if (!Number.isFinite(atr) || atr <= 0) {
    return (equity * base_position_pct) / 100;
  }
  if (!Number.isFinite(current_price) || current_price <= 0) {
    return (equity * base_position_pct) / 100;
  }
  const dollarRisk = (equity * atr_risk_pct) / 100;
  const shares = dollarRisk / atr;
  const targetAmount = shares * current_price;
  return Math.min(equity, Math.max(0, targetAmount));
}

/**
 * 计算原始 Kelly 分数 (满 Kelly)。
 *
 * 公式：f* = (p*b - q) / b
 *   p = 胜率 (0-1)
 *   q = 1 - p (败率)
 *   b = 平均盈利金额 / 平均亏损金额 (payoff_ratio, >0)
 *
 * 解读：
 *   f* > 0  → 策略有正期望，可以下注
 *   f* <= 0 → 策略无优势，不要下注（返回 0）
 *   f* > 1  → 极少见（要求 b 很大且 p 很高），cap 到 1
 *
 * 边界：
 *   - p 越界 → 钳到 [0, 1]
 *   - b <= 0 或 NaN → 返回 0（无效输入）
 *   - 输出钳到 [0, 1]（满 Kelly 也不能超过 100%）
 *
 * @param winRate       0-1 之间的胜率
 * @param payoffRatio   平均盈利 / 平均亏损（> 0）
 * @returns 满 Kelly 分数 (0-1)
 */
export function computeKellyFraction(winRate: number, payoffRatio: number): number {
  if (!Number.isFinite(winRate) || !Number.isFinite(payoffRatio) || payoffRatio <= 0) {
    return 0;
  }
  const p = Math.max(0, Math.min(1, winRate));
  const q = 1 - p;
  const f = (p * payoffRatio - q) / payoffRatio;
  if (!Number.isFinite(f) || f <= 0) return 0;
  return Math.min(1, f);
}

/**
 * 用 Kelly 算 target_amount（分数 Kelly + 样本量门槛）。
 *
 * 公式：target_amount = equity * f* * kelly_fraction_multiplier
 *
 * 边界：
 *   - 样本量 < kelly_min_sample_size → 退化到 base_position_pct（数据不足，不能信 Kelly）
 *   - p / b 缺失或非法 → 退化到 base_position_pct
 *   - f* = 0 (无正期望) → 返回 0，不下注
 *   - kelly_fraction_multiplier 用 [0.05, 1.0]，业界惯用 0.25 (Quarter Kelly) 或 0.5 (Half Kelly)
 *
 * @returns target_amount (元)，未受 max_position_pct cap 限制
 */
export function computeKellySize(
  equity: number,
  winRate: number | undefined,
  payoffRatio: number | undefined,
  sampleSize: number | undefined,
  fractionMultiplier: number,
  minSampleSize: number,
  basePositionPct: number
): number {
  // 样本量太少 → 数据噪声大，退化
  if (!Number.isFinite(sampleSize as number) || (sampleSize as number) < minSampleSize) {
    return (equity * basePositionPct) / 100;
  }
  // 输入无效 → 退化
  if (
    !Number.isFinite(winRate as number) ||
    !Number.isFinite(payoffRatio as number) ||
    (payoffRatio as number) <= 0
  ) {
    return (equity * basePositionPct) / 100;
  }
  const f = computeKellyFraction(winRate as number, payoffRatio as number);
  if (f <= 0) return 0; // 负期望 → 不下注
  const safeFraction = Math.max(0.05, Math.min(1.0, fractionMultiplier));
  return equity * f * safeFraction;
}

// ============================================================
// Main entry — choose method and apply caps
// ============================================================

/**
 * 根据 policy + context 计算 sizing 决策。
 *
 * 流程：
 *   1. 按 policy.method 跑对应算法得 raw target_amount
 *   2. 应用 max_position_pct cap (硬上限)
 *   3. 应用 available_cash cap (不能超出可用资金)
 *   4. 应用 min_trade_amount 检查 (不够最低交易额返回 0 + reason)
 *   5. 返回 SizingDecision
 *
 * @param policy   sizing 配置 (来自 User.risk_config)
 * @param ctx      运行时上下文 (equity / cash / 标的指标)
 * @returns        sizing 决策
 */
export function decideSizing(policy: SizingPolicyConfig, ctx: SizingContext): SizingDecision {
  const conviction = Number.isFinite(ctx.conviction_multiplier as number)
    ? (ctx.conviction_multiplier as number)
    : 1.0;
  const minTrade = Number.isFinite(ctx.min_trade_amount as number)
    ? (ctx.min_trade_amount as number)
    : 5000;
  const maxPctEffective = Math.min(policy.max_position_pct, ctx.max_position_pct);
  const maxByPct = (ctx.equity * maxPctEffective) / 100;

  // 1. 跑对应算法
  let rawAmount = 0;
  let reason = '';
  switch (policy.method) {
    case 'vol_target': {
      rawAmount = computeVolTargetSize(
        ctx.equity,
        policy.vol_target_pct,
        ctx.vol_annualized ?? 0,
        conviction,
        policy.base_position_pct
      );
      reason = ctx.vol_annualized
        ? `vol_target=${(policy.vol_target_pct * 100).toFixed(1)}% / sigma=${(
            ctx.vol_annualized * 100
          ).toFixed(1)}% × conviction=${conviction.toFixed(2)}`
        : `vol 缺失，退化到 base ${policy.base_position_pct}%`;
      break;
    }
    case 'atr_based': {
      rawAmount = computeAtrBasedSize(
        ctx.equity,
        policy.atr_risk_pct,
        ctx.atr ?? 0,
        ctx.current_price,
        policy.base_position_pct
      );
      reason = ctx.atr
        ? `atr_risk=${policy.atr_risk_pct}% / ATR=${ctx.atr.toFixed(
            3
          )} @ price=${ctx.current_price.toFixed(2)}`
        : `ATR 缺失，退化到 base ${policy.base_position_pct}%`;
      break;
    }
    case 'kelly': {
      rawAmount = computeKellySize(
        ctx.equity,
        ctx.historical_win_rate,
        ctx.historical_payoff_ratio,
        ctx.historical_sample_size,
        policy.kelly_fraction_multiplier,
        policy.kelly_min_sample_size,
        policy.base_position_pct
      );
      const sample = ctx.historical_sample_size ?? 0;
      const wr = ctx.historical_win_rate;
      const pr = ctx.historical_payoff_ratio;
      if (sample < policy.kelly_min_sample_size) {
        reason = `Kelly 样本不足 (${sample} < ${policy.kelly_min_sample_size})，退化到 base ${policy.base_position_pct}%`;
      } else if (!Number.isFinite(wr as number) || !Number.isFinite(pr as number)) {
        reason = `Kelly 输入缺失 (winRate / payoff)，退化到 base ${policy.base_position_pct}%`;
      } else {
        const f = computeKellyFraction(wr as number, pr as number);
        reason = `kelly p=${((wr as number) * 100).toFixed(1)}% b=${(pr as number).toFixed(
          2
        )} f*=${(f * 100).toFixed(2)}% × ${(policy.kelly_fraction_multiplier * 100).toFixed(
          0
        )}% Kelly`;
      }
      break;
    }
    case 'equal_pct':
    default: {
      const effectivePct = policy.base_position_pct * conviction;
      rawAmount = (ctx.equity * effectivePct) / 100;
      reason = `equal_pct base=${policy.base_position_pct}% × conviction=${conviction.toFixed(2)}`;
      break;
    }
  }

  // 2. 应用 max_position_pct cap
  let cappedByMax = false;
  if (rawAmount > maxByPct) {
    rawAmount = maxByPct;
    cappedByMax = true;
  }

  // 3. 应用 available_cash cap (留 2% buffer 防四舍五入)
  let cappedByCash = false;
  const maxByCash = ctx.available_cash * 0.98;
  if (rawAmount > maxByCash) {
    rawAmount = maxByCash;
    cappedByCash = true;
  }

  // 4. 不能 < min_trade_amount
  if (rawAmount < minTrade) {
    return {
      target_amount: 0,
      position_pct: 0,
      method: policy.method,
      reason: `${reason}；最终 ¥${rawAmount.toFixed(0)} < min_trade ¥${minTrade}，跳过`,
      capped_by_max: cappedByMax,
      capped_by_cash: cappedByCash,
    };
  }

  return {
    target_amount: rawAmount,
    position_pct: (rawAmount / ctx.equity) * 100,
    method: policy.method,
    reason:
      reason +
      (cappedByMax ? ' | 触顶 max_position_pct' : '') +
      (cappedByCash ? ' | 触顶 available_cash' : ''),
    capped_by_max: cappedByMax,
    capped_by_cash: cappedByCash,
  };
}
