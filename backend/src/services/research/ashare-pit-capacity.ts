/**
 * A 股专项收尾 — PIT financial + PIT index membership + Strategy capacity + Alpha decay
 *
 * 论文 reference:
 *   Banz, R. (1981). "The relationship between return and market value of
 *   common stocks." JFE 9, 3-18. (PIT survivorship bias 经典)
 *
 *   Korajczyk, R. and Sadka, R. (2004). "Are momentum profits robust to
 *   trading costs?" JoF 59(3), 1039-1082. (Strategy capacity)
 *
 *   Grinold, R. (1989). "The fundamental law of active management."
 *   JPM 15(3), 30-37. (Alpha decay)
 *
 * **PIT (Point-in-Time) Financial Data**:
 *
 *   财报覆盖期 ≠ 发布日期. 回测使用 fin_data 必须按 *发布日 + 1 个交易日*
 *   才可见; 否则 Q1 数据 4 月才发，3 月内用 Q1 = 未来函数泄漏.
 *
 *   A 股发布日规则:
 *     - Q1 (1-3 月): 4 月 30 日前发布
 *     - Q2 / 半年 (1-6 月): 8 月 31 日前发布
 *     - Q3 (1-9 月): 10 月 31 日前发布
 *     - Q4 / 年报 (全年): 次年 4 月 30 日前发布
 *
 * **PIT Index Membership**:
 *
 *   沪深 300 / 中证 500 成分股每半年调整一次 (6 月 / 12 月). 回测时若
 *   用今天的成分股回看 2020 年表现 → survivorship bias.
 *
 *   正确做法: 时点查询 — 给 date, 返回当时实际成分股名单.
 *
 * **Strategy Capacity Estimator**:
 *
 *   单策略最大容纳 capital, 使得 impact 不破坏 alpha.
 *
 *   公式: capacity = (alpha_per_trade / impact_per_unit) × n_trades_per_period
 *
 *   small-cap strategy 容量天然小 (低流动性 → impact 大).
 *
 * **Short-life Alpha Decay**:
 *
 *   - 龙虎榜信号: 半衰期 ~3-5 天
 *   - 题材热点: 半衰期 ~10-20 天
 *   - 资金流: 半衰期 ~7 天
 *   - 北上变化: 半衰期 ~15 天
 *
 *   监控: 若实际 IC 衰减快于历史半衰期 → 信号失效预警.
 */

// ============================================================
// PIT Financial Data
// ============================================================

export type FiscalPeriod = 'Q1' | 'Q2' | 'Q3' | 'Q4';

/**
 * Get the latest publishing deadline date for a fiscal period.
 *
 *   Q1 → 4-30 of fiscal_year
 *   Q2 → 8-31 of fiscal_year
 *   Q3 → 10-31 of fiscal_year
 *   Q4 → 4-30 of fiscal_year + 1
 */
export function getFinancialPublishDeadline(fiscal_year: number, period: FiscalPeriod): string {
  switch (period) {
    case 'Q1': return `${fiscal_year}-04-30`;
    case 'Q2': return `${fiscal_year}-08-31`;
    case 'Q3': return `${fiscal_year}-10-31`;
    case 'Q4': return `${fiscal_year + 1}-04-30`;
  }
}

export interface PITFinancialDataPoint {
  symbol: string;
  fiscal_year: number;
  fiscal_period: FiscalPeriod;
  fiscal_period_end_date: string;
  actual_publish_date: string | null;  // 实际发布日; null = 估计 = 用 deadline
  is_pit_safe: boolean;                // 是否经过 PIT 验证可用
  data: Record<string, number>;        // financial metrics
}

/**
 * Check if a financial data point is safe to use at as_of_date.
 *
 *   如果 actual_publish_date <= as_of_date → safe
 *   否则 (未发布 OR 未来日) → unsafe (会构成 lookahead bias)
 */
export function isPITSafe(point: PITFinancialDataPoint, as_of_date: string): boolean {
  if (!point.is_pit_safe) return false;
  const pub_date = point.actual_publish_date ?? getFinancialPublishDeadline(point.fiscal_year, point.fiscal_period);
  return pub_date <= as_of_date;
}

/**
 * Get latest PIT-safe financial data for a symbol at as_of_date.
 *
 *   从 all_points 找最近的 fiscal_period_end_date,
 *   且 actual_publish_date <= as_of_date.
 */
export function getLatestPITSafeData(all_points: PITFinancialDataPoint[], symbol: string, as_of_date: string): PITFinancialDataPoint | null {
  const safe = all_points
    .filter(p => p.symbol === symbol && isPITSafe(p, as_of_date))
    .sort((a, b) => b.fiscal_period_end_date.localeCompare(a.fiscal_period_end_date));
  return safe[0] ?? null;
}

/**
 * Detect lookahead bias in backtest config.
 *
 *   Given a backtest start_date AND a usage date for fin_data,
 *   verify all financial data used are PIT-safe.
 */
export function detectFinancialLookahead(input: {
  backtest_used_data: Array<{ symbol: string; as_of_date: string; data_point: PITFinancialDataPoint }>;
}): { lookahead_count: number; offending_rows: Array<{ symbol: string; as_of_date: string; data_publish_date: string; days_ahead: number }> } {
  const offending: Array<{ symbol: string; as_of_date: string; data_publish_date: string; days_ahead: number }> = [];
  for (const row of input.backtest_used_data) {
    const pub = row.data_point.actual_publish_date ?? getFinancialPublishDeadline(row.data_point.fiscal_year, row.data_point.fiscal_period);
    if (pub > row.as_of_date) {
      const days_ahead = Math.floor((new Date(pub).getTime() - new Date(row.as_of_date).getTime()) / (24 * 3600 * 1000));
      offending.push({ symbol: row.symbol, as_of_date: row.as_of_date, data_publish_date: pub, days_ahead });
    }
  }
  return { lookahead_count: offending.length, offending_rows: offending };
}

// ============================================================
// PIT Index Membership
// ============================================================

export interface IndexMembershipChange {
  index_code: string;
  effective_date: string;  // 调整生效日
  added_symbols: string[];
  removed_symbols: string[];
}

/**
 * Reconstruct index membership at a point in time.
 *
 *   Input: current membership + all historical changes (descending date).
 *   Output: membership as of as_of_date.
 *
 *   Logic: 从 current 反向 unapply 所有 (effective_date > as_of_date) 的调整.
 */
export function getIndexMembershipAt(input: {
  current_members: string[];
  historical_changes: IndexMembershipChange[];
  as_of_date: string;
}): string[] {
  const members = new Set(input.current_members);
  const sorted_changes = input.historical_changes
    .filter(c => c.effective_date > input.as_of_date)
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date));
  for (const change of sorted_changes) {
    // Reverse-apply: re-add removed, remove added
    for (const s of change.removed_symbols) members.add(s);
    for (const s of change.added_symbols) members.delete(s);
  }
  return Array.from(members).sort();
}

/**
 * Detect survivorship bias in backtest universe.
 *
 *   Given backtest period + universe definition + actual PIT membership,
 *   count stocks that should have been delisted/removed but weren't.
 */
export function detectSurvivorshipBias(input: {
  backtest_universe: string[];       // 回测里用的 universe (today's)
  pit_membership_at_start: string[]; // start_date 时实际成分
  pit_membership_at_end: string[];   // end_date 时实际成分
}): {
  survivorship_bias_count: number;
  symbols_added_via_survivor_bias: string[];
} {
  // 应该用 union of start + end, 不应该用 today's
  const correct_universe = new Set([...input.pit_membership_at_start, ...input.pit_membership_at_end]);
  const biased = input.backtest_universe.filter(s => !correct_universe.has(s));
  return { survivorship_bias_count: biased.length, symbols_added_via_survivor_bias: biased };
}

// ============================================================
// Strategy Capacity Estimator
// ============================================================

/**
 * Estimate strategy capacity in 元 (CNY).
 *
 *   capacity = sum over trades of (max_traded_value_per_stock)
 *
 *   max_traded_value_per_stock = participation_rate × ADV (average daily volume)
 *
 *   Standard: 不超过 10-20% of ADV (避免冲击成本失控).
 */
export function estimateStrategyCapacity(input: {
  stock_adv_values: Array<{ symbol: string; adv_cny: number }>; // 平均日成交额
  positions_per_stock_pct: number;       // 每股目标仓位 (e.g. 5%)
  n_holding_days: number;                // 平均持仓天数
  participation_rate: number;            // 单日参与率上限 (e.g. 0.15)
  n_trades_per_year: number;
}): {
  capacity_cny: number;
  per_stock_capacity: Array<{ symbol: string; max_capital_cny: number }>;
  bottleneck_symbol: string;
  capacity_grade: 'high' | 'medium' | 'low';
} {
  // For each stock: max_daily_trade = participation × ADV
  //                 if turn over in n_days → max position = max_daily_trade × n_days
  const per_stock = input.stock_adv_values.map(s => {
    const max_daily = s.adv_cny * input.participation_rate;
    // Max position can be built in n_holding_days
    const max_position = max_daily * input.n_holding_days;
    // Capital that can be deployed = max_position / positions_per_stock_pct
    const max_capital = max_position / Math.max(0.001, input.positions_per_stock_pct);
    return { symbol: s.symbol, max_capital_cny: max_capital };
  });
  // Capacity = min across stocks (bottleneck)
  let min_capacity = Infinity;
  let bottleneck = '';
  for (const p of per_stock) {
    if (p.max_capital_cny < min_capacity) {
      min_capacity = p.max_capital_cny;
      bottleneck = p.symbol;
    }
  }

  let grade: 'high' | 'medium' | 'low';
  if (min_capacity >= 1e9) grade = 'high';      // 10 亿+
  else if (min_capacity >= 1e8) grade = 'medium'; // 1 亿
  else grade = 'low';

  return {
    capacity_cny: min_capacity,
    per_stock_capacity: per_stock,
    bottleneck_symbol: bottleneck,
    capacity_grade: grade,
  };
}

// ============================================================
// Short-life Alpha Decay Monitor
// ============================================================

/**
 * Known half-lives for short-life signals (A 股 empirical).
 */
export const SIGNAL_HALF_LIVES: Record<string, number> = {
  'dragon_tiger_seat': 4,           // 龙虎榜席位变化
  'limit_up_continuation': 3,       // 涨停连板
  'industry_hot_money_flow': 7,     // 行业资金流
  'northbound_holding_change': 15,  // 北上持仓变化
  'industry_rotation_signal': 20,   // 行业轮动
  'sector_theme_burst': 10,         // 题材爆发
  'analyst_upgrade': 30,            // 分析师升评
  'earnings_surprise': 60,          // 业绩超预期
};

/**
 * Compute observed half-life from IC time series.
 *
 *   IC(t) ≈ IC(0) × exp(-t / τ)
 *   →  τ = -t / log(IC(t)/IC(0))
 *
 *   Half-life = τ × log(2)
 */
export function observedHalfLife(ic_series: Array<{ days_after_signal: number; ic: number }>): number | null {
  if (ic_series.length < 2) return null;
  const ic_0 = ic_series[0].ic;
  if (ic_0 <= 0) return null;
  const valid = ic_series.filter(p => p.ic > 0 && p.days_after_signal > 0);
  if (valid.length === 0) return null;
  // Compute average tau across all points
  let sum_tau = 0, count = 0;
  for (const p of valid) {
    const ratio = p.ic / ic_0;
    if (ratio > 0 && ratio < 1) {
      const tau = -p.days_after_signal / Math.log(ratio);
      sum_tau += tau;
      count += 1;
    }
  }
  if (count === 0) return null;
  const avg_tau = sum_tau / count;
  return avg_tau * Math.LN2;
}

/**
 * Monitor alpha decay vs expected half-life.
 *
 *   - If observed_half_life < expected × 0.5 → 信号显著加速衰减 (alarm)
 *   - If observed_half_life > expected × 1.5 → 信号反常持久 (regime change?)
 */
export function monitorAlphaDecay(input: {
  signal_name: string;
  observed_ic_series: Array<{ days_after_signal: number; ic: number }>;
}): {
  expected_half_life_days: number | null;
  observed_half_life_days: number | null;
  decay_status: 'accelerated' | 'normal' | 'extended' | 'unknown';
  recommendation: string;
} {
  const expected = SIGNAL_HALF_LIVES[input.signal_name] ?? null;
  const observed = observedHalfLife(input.observed_ic_series);
  if (expected === null) {
    return { expected_half_life_days: null, observed_half_life_days: observed, decay_status: 'unknown', recommendation: `未知信号 ${input.signal_name}, 加入 SIGNAL_HALF_LIVES 表` };
  }
  if (observed === null) {
    return { expected_half_life_days: expected, observed_half_life_days: null, decay_status: 'unknown', recommendation: 'IC 数据不足' };
  }
  if (observed < expected * 0.5) {
    return {
      expected_half_life_days: expected,
      observed_half_life_days: observed,
      decay_status: 'accelerated',
      recommendation: `🔴 信号失效预警: observed=${observed.toFixed(1)}d << expected=${expected}d. 可能被市场套利;减小持仓周期或降权重`,
    };
  }
  if (observed > expected * 1.5) {
    return {
      expected_half_life_days: expected,
      observed_half_life_days: observed,
      decay_status: 'extended',
      recommendation: `🟢 信号异常持久: observed=${observed.toFixed(1)}d >> expected=${expected}d. 可能 regime change 或新 alpha source`,
    };
  }
  return {
    expected_half_life_days: expected,
    observed_half_life_days: observed,
    decay_status: 'normal',
    recommendation: `✅ Decay 符合预期 (${observed.toFixed(1)}d vs expected ${expected}d)`,
  };
}

/**
 * Recommend optimal holding period based on half-life.
 *
 *   Best entry → exit ~= 1 half-life (still 50%+ of alpha remaining).
 *   Beyond 2 half-lives → alpha < 25%, not worth.
 */
export function recommendHoldingPeriod(half_life_days: number): {
  optimal_days: number;
  max_days_before_stale: number;
} {
  return {
    optimal_days: Math.round(half_life_days),
    max_days_before_stale: Math.round(half_life_days * 2),
  };
}
