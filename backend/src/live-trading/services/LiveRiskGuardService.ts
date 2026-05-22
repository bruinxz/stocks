import { liveTradingSafetyService } from './LiveTradingSafetyService';

function round(value: any, digits = 2): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

export interface LiveRiskCheckInput {
  side: 'BUY' | 'SELL';
  symbol: string;
  name?: string;
  quantity: number;
  limit_price: number;
  total_asset?: number;
  available_cash?: number;
  current_position_value?: number;
  total_exposure_pct?: number;
  is_st?: boolean;
  is_limit_up?: boolean;
  price_deviation_pct?: number;
}

export class LiveRiskGuardService {
  evaluate(input: LiveRiskCheckInput) {
    const limits = liveTradingSafetyService.getDefaultRiskLimits();
    const quantity = Math.max(0, Math.floor(Number(input.quantity || 0) / 100) * 100);
    const limitPrice = round(input.limit_price, 4);
    const estimatedAmount = round(quantity * limitPrice, 2);
    const totalAsset = Math.max(Number(input.total_asset || 0), 0);
    const availableCash = Math.max(Number(input.available_cash || 0), 0);
    const orderPct = totalAsset > 0 ? round((estimatedAmount / totalAsset) * 100, 4) : 0;
    const projectedPositionPct =
      totalAsset > 0
        ? round(((Number(input.current_position_value || 0) + (input.side === 'BUY' ? estimatedAmount : 0)) / totalAsset) * 100, 4)
        : 0;
    const projectedExposurePct = round(
      Number(input.total_exposure_pct || 0) + (input.side === 'BUY' ? orderPct : 0),
      4
    );

    const checks = [
      {
        key: 'round_lot',
        passed: quantity > 0 && quantity % 100 === 0,
        label: 'A股整手校验',
        message: quantity > 0 && quantity % 100 === 0 ? '数量满足 100 股整手规则' : '数量必须为 100 股整数倍',
      },
      {
        key: 'single_order_pct',
        passed: orderPct === 0 || orderPct <= limits.max_single_order_pct,
        label: '单笔资金占比',
        message: `预计占总资产 ${orderPct}% / 上限 ${limits.max_single_order_pct}%`,
      },
      {
        key: 'single_position_pct',
        passed: projectedPositionPct === 0 || projectedPositionPct <= limits.max_single_position_pct,
        label: '单股仓位上限',
        message: `预计单股仓位 ${projectedPositionPct}% / 上限 ${limits.max_single_position_pct}%`,
      },
      {
        key: 'total_exposure_pct',
        passed: projectedExposurePct === 0 || projectedExposurePct <= limits.max_total_exposure_pct,
        label: '总仓位上限',
        message: `预计总仓位 ${projectedExposurePct}% / 上限 ${limits.max_total_exposure_pct}%`,
      },
      {
        key: 'cash_available',
        passed: input.side === 'SELL' || availableCash === 0 || estimatedAmount <= availableCash,
        label: '可用资金校验',
        message:
          input.side === 'SELL'
            ? '卖出不占用新增现金'
            : `预计金额 ¥${estimatedAmount.toLocaleString()} / 可用资金 ¥${availableCash.toLocaleString()}`,
      },
      {
        key: 'st_filter',
        passed: !input.is_st,
        label: 'ST/退市风险过滤',
        message: input.is_st ? '疑似 ST/退市风险标的，禁止实盘草稿通过' : '未发现 ST 风险标识',
      },
      {
        key: 'limit_up_buy',
        passed: !(input.side === 'BUY' && input.is_limit_up),
        label: '涨停买入过滤',
        message: input.side === 'BUY' && input.is_limit_up ? '涨停买入默认禁止' : '未触发涨停买入限制',
      },
      {
        key: 'price_deviation',
        passed:
          input.price_deviation_pct === undefined ||
          Math.abs(Number(input.price_deviation_pct || 0)) <= limits.price_deviation_guard_pct,
        label: '价格偏离保护',
        message:
          input.price_deviation_pct === undefined
            ? '暂无外部参考价偏离数据，仅保留人工确认'
            : `价格偏离 ${round(input.price_deviation_pct, 4)}% / 上限 ${limits.price_deviation_guard_pct}%`,
      },
    ];

    const failed = checks.filter(item => !item.passed);
    return {
      allowed: failed.length === 0,
      risk_level: failed.length >= 2 ? 'high' : failed.length === 1 ? 'medium' : 'low',
      estimated_amount: estimatedAmount,
      order_pct: orderPct,
      projected_position_pct: projectedPositionPct,
      projected_exposure_pct: projectedExposurePct,
      checks,
      failed_checks: failed,
      conclusion:
        failed.length === 0
          ? '订单草稿通过基础实盘风控，但仍需用户强确认后才可提交券商。'
          : `订单草稿未通过 ${failed.length} 项基础风控，不允许提交券商。`,
    };
  }
}

export const liveRiskGuardService = new LiveRiskGuardService();
