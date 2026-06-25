/**
 * positionProtectionDefaults — CB-1 (2026/06/25)
 *
 * 创建 paper_trading_positions 时把 stop_loss_price / take_profit_price 按
 * user.risk_config.stop_loss_percent / take_profit_percent 自动落值. 以前的
 * facade / automation 在 BUY 创建仓位时**没**把 user.risk_config 的两个百分比
 * 翻译成 position 行里的两列价格 — 用户 UI 上看 risk_config = "止损 5% / 止盈
 * 10%", 但 paper_trading_positions.stop_loss_price 全 NULL, GuardSellExecutor
 * 读 NULL 直接 skip = 整套止损止盈失效.
 *
 * 设计原则:
 *   1. **纯函数 + 默认值**: deriveProtectionPrices(avgCost, riskConfig) 接 user
 *      risk_config (UI 上配的两个百分比, 0 < x ≤ 50 合理范围), 返回 2 个价位.
 *      非法 / 缺失 fallback 到 5% / 10% (与 User.risk_config defaultValue 同步).
 *   2. **不抛错**: 拿不到 user 或 avg_cost ≤ 0 时返 {stop_loss_price: null,
 *      take_profit_price: null} — 让 caller 持仓写 NULL (老行为) 不阻塞 BUY.
 *   3. **rounding to 4 decimals**: 与 facade 内 PerStockStopLossGuard 重算 stop_loss_price
 *      时 `.toFixed(4)` 同源, A 股普通 0.001-0.01 元 tick 不会因 precision 漂移.
 *   4. **trailing_stop_pct 独立**: 本 helper 不动 trailing_stop_pct (那是 US-048
 *      TrailingStopGuard 的 trailing 逻辑), 只填硬性 stop_loss_price + take_profit_price.
 */

export const DEFAULT_STOP_LOSS_PERCENT = 5;
export const DEFAULT_TAKE_PROFIT_PERCENT = 10;

/** user.risk_config 关心的字段子集 (避免 import User 类型). */
export interface RiskConfigProtectionInput {
  stop_loss_percent?: number | string | null;
  take_profit_percent?: number | string | null;
}

export interface ProtectionPrices {
  stop_loss_price: number | null;
  take_profit_price: number | null;
  stop_loss_percent: number;
  take_profit_percent: number;
}

/**
 * 把 % 输入 (1-50 合理范围) normalize 到合法数, 非法 fallback. 同 User.risk_config
 * defaultValue {stop_loss_percent: 5, take_profit_percent: 10}.
 */
export function normalizeStopLossPercent(input: any): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0 || n > 50) return DEFAULT_STOP_LOSS_PERCENT;
  return n;
}

export function normalizeTakeProfitPercent(input: any): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0 || n > 200) return DEFAULT_TAKE_PROFIT_PERCENT;
  return n;
}

/**
 * 用 avg_cost × (1 - stop_loss% / 100) 和 avg_cost × (1 + take_profit% / 100) 算两个价位.
 * avg_cost <= 0 → 全 null (BUY 价格异常, 不写保护位).
 */
export function deriveProtectionPrices(
  avgCost: number | null | undefined,
  riskConfig: RiskConfigProtectionInput | null | undefined
): ProtectionPrices {
  const stopLossPct = normalizeStopLossPercent(riskConfig?.stop_loss_percent);
  const takeProfitPct = normalizeTakeProfitPercent(riskConfig?.take_profit_percent);

  const cost = Number(avgCost);
  if (!Number.isFinite(cost) || cost <= 0) {
    return {
      stop_loss_price: null,
      take_profit_price: null,
      stop_loss_percent: stopLossPct,
      take_profit_percent: takeProfitPct,
    };
  }

  return {
    stop_loss_price: Number((cost * (1 - stopLossPct / 100)).toFixed(4)),
    take_profit_price: Number((cost * (1 + takeProfitPct / 100)).toFixed(4)),
    stop_loss_percent: stopLossPct,
    take_profit_percent: takeProfitPct,
  };
}

/**
 * Lazy DB lookup — facade / automation 拿到 user_id 后调本函数取 risk_config,
 * 失败 fail-OPEN 返默认 (避免风控保护字段写入失败阻塞主下单链).
 */
export async function loadProtectionPricesForUser(
  user_id: number,
  avgCost: number
): Promise<ProtectionPrices> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { User } = require('../../models/User');
    const user = await User.findByPk(user_id, { attributes: ['risk_config'] });
    return deriveProtectionPrices(avgCost, user?.risk_config);
  } catch (err) {
    // fail-OPEN: 用默认 5% / 10%
    return deriveProtectionPrices(avgCost, undefined);
  }
}
