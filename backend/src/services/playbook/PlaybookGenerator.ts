/**
 * Sprint 42-D: PlaybookGenerator — 把"操盘手盘感"结构化成可学习字段
 *
 * 每条 signal 入池时自动生成一份 Playbook, 写到 QuantSignal.raw_factors.playbook
 * 让 MetaLabel V2 训练时能拿到这些"人类操盘手会问的问题"作为 feature:
 *
 *   - trade_type:              这票属于哪类信号? (趋势/反转/事件/价值/资金驱动)
 *   - core_catalyst:           核心催化是什么? (一句话描述)
 *   - failure_condition:       失败条件是什么? (止损线 / 技术破位)
 *   - expected_holding_days:   预期持仓周期 (自然日)
 *   - trade_style:             快进快出还是波段 (quick_swing / position / long_term)
 *   - is_crowded:              该方向是否拥挤?
 *   - account_risk_status:     当前账户风险状态 (aggressive / normal / defensive)
 *
 * 这些字段长期会比单纯技术指标更有价值, 是 MetaLabel 模型从"看数字"升级到
 * "看交易逻辑"的关键 feature.
 *
 * 设计要点:
 *   1. **纯函数 generatePlaybook(input)**: 0 DB / 0 外部依赖, 单测全覆盖.
 *   2. **strategy_key → trade_type 映射表**: 与 quant/strategies/ 13 个策略对齐.
 *   3. **fail-open**: 任何字段缺数据 fallback 到合理默认, 不抛错.
 *   4. **不写库, 由 caller 决定持久化**: PaperTradingAutomationService 在 buy gate
 *      调 generatePlaybook + 把结果写到 QuantSignal.raw_factors.playbook.
 */

// ===========================================================================
// Types
// ===========================================================================

export type TradeType = 'trend' | 'reversal' | 'event' | 'value_repair' | 'flow_driven' | 'unknown';
export type TradeStyle = 'quick_swing' | 'position' | 'long_term' | 'unknown';
export type AccountRiskStatus = 'aggressive' | 'normal' | 'defensive' | 'unknown';

export interface PlaybookInput {
  strategy_key: string;
  symbol: string;
  signal_score?: number;
  /** 当前市场环境 (regime) */
  market_regime?: string;
  /** 当前账户回撤 % (用于判断 aggressive/normal/defensive) */
  current_drawdown_pct?: number;
  /** 当前持仓数 / 最大持仓数 (用于判断是否激进) */
  position_count?: number;
  max_positions?: number;
  /** FactorOrthogonalizationService 算的 crowding (0-1) */
  factor_crowding_score?: number;
  /** 是否有业绩预告 / 北向加仓 / 龙虎榜机构买等事件 */
  has_earnings_event?: boolean;
  has_northbound_inflow?: boolean;
  has_dragon_tiger_inst_buy?: boolean;
}

export interface Playbook {
  trade_type: TradeType;
  core_catalyst: string;
  failure_condition: string;
  expected_holding_days: number;
  trade_style: TradeStyle;
  is_crowded: boolean;
  account_risk_status: AccountRiskStatus;
  reason: string;
}

// ===========================================================================
// Mapping tables (与 quant/strategies/ 对齐)
// ===========================================================================

/**
 * Strategy key → trade_type 映射表.
 * 必须与 quant/strategies/ 13 个组合级策略 + 16 个 per-stock 策略对齐.
 */
export const STRATEGY_TYPE_MAP: Record<string, TradeType> = Object.freeze({
  // 趋势 / 突破 / 动量类
  ma_trend: 'trend',
  macd_trend: 'trend',
  relative_strength_momentum: 'trend',
  breakout_atr: 'trend',
  breakout_strategy: 'trend',
  donchian_trend: 'trend',
  turtle_breakout: 'trend',
  minervini_trend_template: 'trend',
  volatility_contraction_breakout: 'trend',
  dual_momentum_rotation: 'trend',
  trend_pullback_reentry: 'trend',
  cta100_momentum: 'trend',
  // 反转 / 摆动
  rsi_mean_reversion: 'reversal',
  bollinger_reversion: 'reversal',
  left_side_reversal: 'reversal',
  // 事件驱动
  earnings_surprise: 'event',
  dragon_head_momentum: 'event',
  game_trader_relay: 'event',
  linkage_strategy: 'event',
  // 价值修复 / 长线
  high_dividend_value: 'value_repair',
  garp_strategy: 'value_repair',
  low_volatility_quality: 'value_repair',
  quality_momentum_blend: 'value_repair',
  // 资金驱动
  northbound_follow: 'flow_driven',
  volume_price_confirmation: 'flow_driven',
  // 多因子 / meta
  multi_factor_ranking: 'trend',
  multi_factor_alpha: 'trend',
  ensemble_strategy: 'trend',
  // 行业轮动
  sector_rotation_leader: 'flow_driven',
});

/**
 * Strategy key → 默认预期持仓天数 (自然日).
 */
export const STRATEGY_HOLDING_DAYS_MAP: Record<string, number> = Object.freeze({
  // 短线 (3-15 天)
  dragon_head_momentum: 3,
  game_trader_relay: 3,
  linkage_strategy: 3,
  left_side_reversal: 15,
  rsi_mean_reversion: 7,
  bollinger_reversion: 10,
  volume_price_confirmation: 10,
  // 中线 (15-60 天)
  breakout_atr: 30,
  breakout_strategy: 60,
  ma_trend: 30,
  macd_trend: 30,
  relative_strength_momentum: 30,
  multi_factor_ranking: 30,
  multi_factor_alpha: 30,
  ensemble_strategy: 30,
  earnings_surprise: 60,
  northbound_follow: 21,
  sector_rotation_leader: 21,
  cta100_momentum: 30,
  trend_pullback_reentry: 30,
  donchian_trend: 30,
  turtle_breakout: 45,
  minervini_trend_template: 60,
  volatility_contraction_breakout: 45,
  dual_momentum_rotation: 30,
  quality_momentum_blend: 60,
  // 长线 (>= 90 天)
  high_dividend_value: 180,
  garp_strategy: 180,
  low_volatility_quality: 90,
});

/**
 * Strategy key → 默认失败条件 (止损 / 技术破位描述).
 */
export const STRATEGY_FAILURE_CONDITION_MAP: Record<string, string> = Object.freeze({
  // 显式止损 + 技术破位
  dragon_head_momentum: '次日大跌 -3% / 持有 3 天到期',
  game_trader_relay: '-7% 止损 / 接力中断',
  linkage_strategy: '-7% 止损 / 当日涨停止盈',
  breakout_atr: '跌破 MA20 / -15% 止损',
  breakout_strategy: '跌破 MA20 / -15% 止损 / 60 天到期',
  left_side_reversal: '-7% 止损 / 5 天涨幅 > 15% sell_half',
  rsi_mean_reversion: 'RSI 超 70 / -5% 止损',
  // 长线 — 季度调仓
  high_dividend_value: '掉出 top N (季度调仓自然换仓)',
  garp_strategy: '掉出 top N (半年度调仓自然换仓)',
  // 默认
  multi_factor_alpha: '掉出 top 30 (月度调仓自然换仓)',
  ensemble_strategy: '子策略权重重新分配自然换仓',
  multi_factor_ranking: '掉出 top N (每日重新打分)',
});

// ===========================================================================
// Pure helper
// ===========================================================================

/**
 * trade_style 由 holding_days 推断:
 *   < 15 天 → quick_swing (快进快出)
 *   15-90 天 → position (波段)
 *   >= 90 天 → long_term
 */
export function inferTradeStyle(holding_days: number): TradeStyle {
  if (!Number.isFinite(holding_days) || holding_days <= 0) return 'unknown';
  if (holding_days < 15) return 'quick_swing';
  if (holding_days < 90) return 'position';
  return 'long_term';
}

/**
 * 账户风险状态推断:
 *   drawdown >= 8% OR position_pct >= 90% → defensive (该收手)
 *   drawdown < 3% AND position_pct < 50% → aggressive (有余力)
 *   其他 → normal
 */
export function inferAccountRiskStatus(input: {
  current_drawdown_pct?: number;
  position_count?: number;
  max_positions?: number;
}): AccountRiskStatus {
  const dd = Number(input.current_drawdown_pct);
  const position_pct =
    input.position_count != null && input.max_positions != null && input.max_positions > 0
      ? input.position_count / input.max_positions
      : NaN;
  if (Number.isFinite(dd) && dd >= 8) return 'defensive';
  if (Number.isFinite(position_pct) && position_pct >= 0.9) return 'defensive';
  if (Number.isFinite(dd) && dd < 3 && Number.isFinite(position_pct) && position_pct < 0.5) {
    return 'aggressive';
  }
  if (!Number.isFinite(dd) && !Number.isFinite(position_pct)) return 'unknown';
  return 'normal';
}

/**
 * 推断 core_catalyst — 优先看事件信号, 没事件就看 strategy 类型默认描述.
 */
export function inferCoreCatalyst(input: PlaybookInput, trade_type: TradeType): string {
  // 事件驱动优先
  if (input.has_earnings_event) return '业绩超预期 / 业绩报告期';
  if (input.has_northbound_inflow) return '北向资金 5 日大幅加仓';
  if (input.has_dragon_tiger_inst_buy) return '龙虎榜机构净买入';
  // 否则按策略类型给默认描述
  switch (trade_type) {
    case 'trend':
      return '价量趋势延续 / 突破信号';
    case 'reversal':
      return '超跌反弹 / 技术指标超卖反转';
    case 'event':
      return '事件触发 (业绩/资金/题材)';
    case 'value_repair':
      return '低估修复 / 高分红长线持有';
    case 'flow_driven':
      return '资金面跟随 (北向/主力)';
    default:
      return `${input.strategy_key} 策略入选`;
  }
}

// ===========================================================================
// Main generator
// ===========================================================================

/**
 * 给一条 signal 生成完整 Playbook.
 *
 * fail-open: 任何字段缺数据 fallback 到 unknown 或合理默认, 不抛错.
 */
export function generatePlaybook(input: PlaybookInput): Playbook {
  const trade_type = STRATEGY_TYPE_MAP[input.strategy_key] || 'unknown';
  const expected_holding_days = STRATEGY_HOLDING_DAYS_MAP[input.strategy_key] || 30;
  const trade_style = inferTradeStyle(expected_holding_days);
  const failure_condition =
    STRATEGY_FAILURE_CONDITION_MAP[input.strategy_key] || '-7% 止损 / 30 天到期';
  const core_catalyst = inferCoreCatalyst(input, trade_type);
  const is_crowded = Number(input.factor_crowding_score) >= 0.6;
  const account_risk_status = inferAccountRiskStatus(input);

  const reason = `${
    input.symbol
  } [${trade_type}/${trade_style}] catalyst="${core_catalyst}" exit="${failure_condition}" holding=${expected_holding_days}d ${
    is_crowded ? '⚠️crowded' : ''
  } risk=${account_risk_status}`;

  return {
    trade_type,
    core_catalyst,
    failure_condition,
    expected_holding_days,
    trade_style,
    is_crowded,
    account_risk_status,
    reason,
  };
}
