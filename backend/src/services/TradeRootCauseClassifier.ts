/**
 * TradeRootCauseClassifier — Phase 5 trade outcome 根因自动归类
 *
 * 输入：一笔已完成 trade outcome (buy + sell metadata + 价格序列)
 * 输出：root_cause enum + confidence + label
 *
 * **设计目标**：把 trade 失败/成功的"为什么"从 free-text exit_reason 升级到结构化
 * enum，让我们能聚合 "哪种 root_cause 出现最多" 找系统性问题。
 *
 * **纯函数 + 无 DB**: 输入 plain JSON，输出 plain object，方便单测 + 多入口调用。
 * RecommendationTradeOutcomeService 在写入 outcome 时调用一次填三个字段。
 *
 * **优先级链 (高 confidence 先匹配)**:
 *   1. risk_kill_switch (exit_reason 含 kill_switch) → conf=1.0
 *   2. backtest_drift (实盘 vs 回测预期偏离 > 50%) → conf=0.9
 *   3. data_quality (买入价或卖出价 NaN / 0 / impossible) → conf=1.0
 *   4. wrong_regime (买入时是 bull 但卖出时是 bear, 持仓 ≥ 5 天) → conf=0.7
 *   5. catalyst_failed (买入因为业绩预告 catalyst 但卖出时 negative_return) → conf=0.6
 *   6. wrong_entry (买入后第一周内最大回撤 > 5% 且最终 loss) → conf=0.65
 *   7. stop_loss (exit_reason='stop_loss' 或 return_pct ≤ -strategy_stop_pct) → conf=0.95
 *   8. time_stop (持仓天数 ≥ max_holding_days) → conf=0.9
 *   9. profit_take (return_pct > 0 且没匹配上面) → conf=0.8
 *   10. unknown → conf=0.0 (fallback)
 *
 * **配 confidence 是为了**: <0.5 的可以提示 UI 让用户手工 review；>=0.8 直接信任。
 */

// ============================================================
// Types
// ============================================================

export type TradeRootCause =
  | 'profit_take'
  | 'stop_loss'
  | 'time_stop'
  | 'wrong_entry'
  | 'wrong_regime'
  | 'catalyst_failed'
  | 'data_quality'
  | 'backtest_drift'
  | 'risk_kill_switch'
  | 'unknown';

export interface TradeRootCauseInput {
  /** trade 总收益率 (%, 已 trim signed)；亏损为负 */
  return_pct: number;
  /** 持仓天数 (calendar) */
  holding_days: number;
  /** exit_reason free-text (来自现有 exit_reason 字段) */
  exit_reason?: string | null;
  /** 入场价 (元) */
  entry_price?: number;
  /** 出场价 (元) */
  exit_price?: number;
  /** 买入时市场 regime */
  market_regime_at_entry?: string | null;
  /** 卖出时市场 regime */
  market_regime_at_exit?: string | null;
  /** 买入信号的 catalyst 类型 (e.g. 'earnings_surprise', 'momentum', 'value')；可选 */
  signal_catalyst?: string | null;
  /** 策略默认止损百分比 (e.g. -7 表示 -7%)；可选 */
  strategy_stop_loss_pct?: number;
  /** 策略默认最大持仓天数；可选 */
  strategy_max_holding_days?: number;
  /** 回测期对该 strategy 的平均年化收益 (%)；用来判 backtest_drift */
  backtest_expected_annual_return_pct?: number;
  /** trade 实际年化收益 (%)；外部计算好 */
  actual_annualized_return_pct?: number;
  /** 持仓期 max drawdown % (绝对值) */
  max_drawdown_during_hold_pct?: number;
}

export interface TradeRootCauseResult {
  root_cause: TradeRootCause;
  root_cause_label: string;
  confidence: number;
  matched_rule: string;
}

// ============================================================
// Label dictionary
// ============================================================

export const ROOT_CAUSE_LABELS: Record<TradeRootCause, string> = {
  profit_take: '止盈出场',
  stop_loss: '止损触发',
  time_stop: '持仓超期',
  wrong_entry: '入场时机不佳',
  wrong_regime: '市场环境切换',
  catalyst_failed: '催化兑现失败',
  data_quality: '数据异常',
  backtest_drift: '实盘偏离回测',
  risk_kill_switch: '风控熔断',
  unknown: '未归类',
};

// ============================================================
// Main classifier (priority-chain)
// ============================================================

const KILL_SWITCH_KEYWORDS = ['kill_switch', 'circuit_breaker', 'forced_close', 'emergency_exit'];
const DATA_QUALITY_KEYWORDS = ['nan', 'null', 'invalid_price', 'suspended'];

/**
 * Phase 5: 单笔 trade 自动归类入口
 *
 * 优先级链按上面 doc 的 1-10 顺序判断，第一个 match 的 rule 决定 root_cause。
 *
 * 边界:
 *   - return_pct NaN / Infinity → return unknown
 *   - 所有 boolean 判断都防御性 null check
 */
export function classifyTradeRootCause(input: TradeRootCauseInput): TradeRootCauseResult {
  // 边界：输入完全脏
  if (!Number.isFinite(input.return_pct)) {
    return {
      root_cause: 'unknown',
      root_cause_label: ROOT_CAUSE_LABELS.unknown,
      confidence: 0,
      matched_rule: 'invalid_return_pct',
    };
  }

  const exitReason = (input.exit_reason || '').toLowerCase();

  // (1) risk_kill_switch — 风控熔断
  if (KILL_SWITCH_KEYWORDS.some(kw => exitReason.includes(kw))) {
    return {
      root_cause: 'risk_kill_switch',
      root_cause_label: ROOT_CAUSE_LABELS.risk_kill_switch,
      confidence: 1.0,
      matched_rule: 'exit_reason_kill_switch_keyword',
    };
  }

  // (2) data_quality — 数据异常
  if (
    DATA_QUALITY_KEYWORDS.some(kw => exitReason.includes(kw)) ||
    (input.entry_price !== undefined && (!Number.isFinite(input.entry_price) || input.entry_price <= 0)) ||
    (input.exit_price !== undefined && (!Number.isFinite(input.exit_price) || input.exit_price <= 0))
  ) {
    return {
      root_cause: 'data_quality',
      root_cause_label: ROOT_CAUSE_LABELS.data_quality,
      confidence: 1.0,
      matched_rule: 'invalid_price_or_keyword',
    };
  }

  // (3) backtest_drift — 实盘大幅偏离回测预期
  if (
    Number.isFinite(input.backtest_expected_annual_return_pct ?? NaN) &&
    Number.isFinite(input.actual_annualized_return_pct ?? NaN)
  ) {
    const expected = input.backtest_expected_annual_return_pct as number;
    const actual = input.actual_annualized_return_pct as number;
    // 偏离 = (expected - actual) / |expected|；超过 50% 标记 drift
    if (Math.abs(expected) >= 5 && (expected - actual) / Math.abs(expected) > 0.5) {
      return {
        root_cause: 'backtest_drift',
        root_cause_label: ROOT_CAUSE_LABELS.backtest_drift,
        confidence: 0.9,
        matched_rule: 'actual_annualized_below_50pct_of_backtest_expected',
      };
    }
  }

  // (4) wrong_regime — 买入和卖出时 regime 不一致 (持仓 >=5 天)
  if (
    input.market_regime_at_entry &&
    input.market_regime_at_exit &&
    input.market_regime_at_entry !== input.market_regime_at_exit &&
    input.holding_days >= 5 &&
    input.return_pct < 0
  ) {
    const entry = input.market_regime_at_entry;
    const exit = input.market_regime_at_exit;
    // 特别针对 bull → bear / range → stress 这种"恶化"切换
    const isBadShift =
      (entry === 'bull' && (exit === 'bear' || exit === 'stress')) ||
      (entry === 'rebound' && (exit === 'bear' || exit === 'stress')) ||
      (entry === 'range' && exit === 'stress');
    if (isBadShift) {
      return {
        root_cause: 'wrong_regime',
        root_cause_label: ROOT_CAUSE_LABELS.wrong_regime,
        confidence: 0.7,
        matched_rule: `regime_shift_${entry}_to_${exit}`,
      };
    }
  }

  // (5) catalyst_failed — 入场是某 catalyst 信号 (earnings_surprise / event) 但 return 为负
  const eventCatalysts = ['earnings_surprise', 'announcement', 'event', 'block_trade_signal'];
  if (
    input.signal_catalyst &&
    eventCatalysts.some(c => String(input.signal_catalyst).includes(c)) &&
    input.return_pct < 0
  ) {
    return {
      root_cause: 'catalyst_failed',
      root_cause_label: ROOT_CAUSE_LABELS.catalyst_failed,
      confidence: 0.6,
      matched_rule: `catalyst_${input.signal_catalyst}_negative_return`,
    };
  }

  // (6) wrong_entry — 持仓期内最大回撤 > 5% 且最终亏损 + 第一周
  if (
    input.return_pct < 0 &&
    input.holding_days <= 7 &&
    Number.isFinite(input.max_drawdown_during_hold_pct ?? NaN) &&
    (input.max_drawdown_during_hold_pct as number) > 5
  ) {
    return {
      root_cause: 'wrong_entry',
      root_cause_label: ROOT_CAUSE_LABELS.wrong_entry,
      confidence: 0.65,
      matched_rule: 'first_week_drawdown_over_5pct_with_loss',
    };
  }

  // (7) stop_loss
  if (
    exitReason.includes('stop_loss') ||
    exitReason.includes('stoploss') ||
    (Number.isFinite(input.strategy_stop_loss_pct ?? NaN) &&
      input.return_pct <= (input.strategy_stop_loss_pct as number))
  ) {
    return {
      root_cause: 'stop_loss',
      root_cause_label: ROOT_CAUSE_LABELS.stop_loss,
      confidence: 0.95,
      matched_rule: 'exit_reason_stop_loss_or_below_strategy_stop',
    };
  }

  // (8) time_stop
  if (
    exitReason.includes('time_stop') ||
    exitReason.includes('max_hold') ||
    (Number.isFinite(input.strategy_max_holding_days ?? NaN) &&
      input.holding_days >= (input.strategy_max_holding_days as number))
  ) {
    return {
      root_cause: 'time_stop',
      root_cause_label: ROOT_CAUSE_LABELS.time_stop,
      confidence: 0.9,
      matched_rule: 'exit_reason_or_holding_days_threshold',
    };
  }

  // (9) profit_take — 收益为正且没被上面规则截
  if (input.return_pct > 0) {
    return {
      root_cause: 'profit_take',
      root_cause_label: ROOT_CAUSE_LABELS.profit_take,
      confidence: 0.8,
      matched_rule: 'positive_return_default',
    };
  }

  // (10) unknown fallback
  return {
    root_cause: 'unknown',
    root_cause_label: ROOT_CAUSE_LABELS.unknown,
    confidence: 0,
    matched_rule: 'no_rule_matched',
  };
}
