/**
 * Trader Mind Deep — DQS auto-apply + Reason Triplet + Schwager Wizards + Quant Postmortem
 *
 * 书 reference:
 *   Steenbarger, B. (2009). *The Daily Trading Coach.* Wiley.
 *   Schwager, J. (1989). *Market Wizards.* HarperBusiness.
 *   Schwager, J. (1992). *The New Market Wizards.* HarperBusiness.
 *   Freeman-Shor, L. (2015). *The Art of Execution.* Harriman House.
 *
 * **Reason Triplet**:
 *   每笔 closed trade 评 3 分 (entry + exit + size) 拆开，避免 "盈亏定优劣" bias.
 *
 *   - Entry: thesis 明确度 / 数据支持 / 时机
 *   - Exit: 执行纪律 / 是否止损止盈 / 是否情绪化
 *   - Size: 与 conviction 匹配度 / vol-adjusted
 *
 *   3 分独立 → 复合 DQS.
 *
 * **Schwager Market Wizards Rules**:
 *   提炼 5 位 wizard 的 systematic rules.
 *
 *   1. Druckenmiller: "保护本金 + 集中 conviction" — 错时小亏，对时重仓
 *   2. Paul Tudor Jones: "5% loss = 立即清" + "不持仓过周末除非高确信"
 *   3. Michael Marcus: "永远 risk < 5% 单笔" + "顺势"
 *   4. Bruce Kovner: "先想 worst case, 再算 reward/risk"
 *   5. George Soros: "Theory of reflexivity — markets create reality"
 *
 *   每条 rule 对照 trade 行为给 0/1 violation flag.
 *
 * **Quant Postmortem Scoring**:
 *   替换 TradePostmortemService 自由文本 → 5 维量化:
 *     - thesis_validity: 0-100
 *     - execution_quality: 0-100
 *     - sizing_appropriateness: 0-100
 *     - exit_timing: 0-100
 *     - learning_extraction: 0-100
 */

// ============================================================
// Reason Triplet
// ============================================================

export interface TradeReasonTriplet {
  entry_score: number; // 0-100
  exit_score: number; // 0-100
  size_score: number; // 0-100
  composite_dqs: number; // 0-100
  weaknesses: string[]; // 具体扣分原因
}

/**
 * Compute Reason Triplet for a closed trade.
 *
 * Inputs are observable facts (no PnL bias).
 */
export function computeReasonTriplet(input: {
  // Entry inputs
  thesis_recorded_pre_trade: boolean; // 是否提前写 thesis
  data_support_count: number; // 几个独立数据点支持
  entry_at_planned_price: boolean; // 入场价是否 = plan
  // Exit inputs
  exit_per_plan: boolean; // 是否按 plan 退出
  stop_loss_honored: boolean; // 是否守 stop
  emotional_exit_flag: boolean; // 是否情绪化 (大涨/大跌追/砍)
  // Size inputs
  conviction_level: number; // 0-10 自评
  position_size_pct: number; // 实际仓位
  vol_target_size_pct: number; // vol-adjusted 推荐
}): TradeReasonTriplet {
  const weaknesses: string[] = [];

  // Entry score
  let entry = 100;
  if (!input.thesis_recorded_pre_trade) {
    entry -= 40;
    weaknesses.push('入场前未记录 thesis');
  }
  if (input.data_support_count === 0) {
    entry -= 30;
    weaknesses.push('无独立数据支持');
  } else if (input.data_support_count === 1) {
    entry -= 15;
    weaknesses.push('仅 1 个数据点支持');
  }
  if (!input.entry_at_planned_price) {
    entry -= 15;
    weaknesses.push('追涨入场 (价格 > plan)');
  }
  entry = Math.max(0, entry);

  // Exit score
  let exit = 100;
  if (!input.exit_per_plan) {
    exit -= 30;
    weaknesses.push('未按 plan 退出');
  }
  if (!input.stop_loss_honored) {
    exit -= 50;
    weaknesses.push('破纪律 — 没守 stop loss');
  }
  if (input.emotional_exit_flag) {
    exit -= 25;
    weaknesses.push('情绪化退出 (追/砍)');
  }
  exit = Math.max(0, exit);

  // Size score
  let size = 100;
  // Conviction-size mismatch
  const expected_size_pct = (input.conviction_level / 10) * 0.1; // 10 conviction → 10% max
  const size_diff_pct =
    Math.abs(input.position_size_pct - expected_size_pct) / Math.max(0.001, expected_size_pct);
  if (size_diff_pct > 0.5) {
    size -= 30;
    weaknesses.push(
      `仓位与 conviction 不匹配 (实=${(input.position_size_pct * 100).toFixed(1)}%, 期=${(
        expected_size_pct * 100
      ).toFixed(1)}%)`
    );
  }
  // Vol-adjusted check
  const vol_diff =
    Math.abs(input.position_size_pct - input.vol_target_size_pct) /
    Math.max(0.001, input.vol_target_size_pct);
  if (vol_diff > 0.5) {
    size -= 20;
    weaknesses.push(
      `忽略 vol target (实=${(input.position_size_pct * 100).toFixed(1)}%, vol-adj=${(
        input.vol_target_size_pct * 100
      ).toFixed(1)}%)`
    );
  }
  size = Math.max(0, size);

  // Composite DQS = weighted average (exit 最重要 — 守纪律比 entry 更难)
  const composite = Math.round(0.3 * entry + 0.45 * exit + 0.25 * size);

  return {
    entry_score: Math.round(entry),
    exit_score: Math.round(exit),
    size_score: Math.round(size),
    composite_dqs: composite,
    weaknesses,
  };
}

// ============================================================
// Schwager Market Wizards Systematic Rules
// ============================================================

export interface WizardRuleViolation {
  wizard_name: string;
  rule: string;
  violated: boolean;
  severity: 'low' | 'medium' | 'high';
  detail: string;
}

/**
 * Check Druckenmiller rules.
 *
 *   - "Protect capital first" — 单笔最大亏损 ≤ 5%
 *   - "Concentrate on high-conviction" — 5%+ 仓位的 trade 必须 conviction ≥ 8/10
 */
export function checkDruckenmiller(trade: {
  realized_pnl_pct: number;
  position_size_pct: number;
  conviction_level: number;
}): WizardRuleViolation[] {
  const out: WizardRuleViolation[] = [];
  // Rule 1: capital preservation
  if (trade.realized_pnl_pct < -0.05) {
    out.push({
      wizard_name: 'Druckenmiller',
      rule: '保护本金 — 单笔亏损 ≤ 5%',
      violated: true,
      severity: trade.realized_pnl_pct < -0.1 ? 'high' : 'medium',
      detail: `实亏 ${(trade.realized_pnl_pct * 100).toFixed(1)}% < -5%`,
    });
  }
  // Rule 2: conviction-size match
  if (trade.position_size_pct >= 0.05 && trade.conviction_level < 8) {
    out.push({
      wizard_name: 'Druckenmiller',
      rule: '重仓 (≥5%) 必须 conviction ≥ 8/10',
      violated: true,
      severity: 'medium',
      detail: `仓位 ${(trade.position_size_pct * 100).toFixed(1)}% with conviction=${
        trade.conviction_level
      }/10`,
    });
  }
  return out;
}

/**
 * Check Paul Tudor Jones rules.
 *
 *   - "5% loss = 立即清"
 *   - "永远不持高 vol 仓位过周末"
 */
export function checkPaulTudorJones(trade: {
  max_drawdown_during_hold_pct: number;
  closed_pre_weekend: boolean;
  held_over_weekend: boolean;
  realized_vol_during_hold: number;
}): WizardRuleViolation[] {
  const out: WizardRuleViolation[] = [];
  if (trade.max_drawdown_during_hold_pct < -0.05 && trade.held_over_weekend) {
    out.push({
      wizard_name: 'PTJ',
      rule: '5% drawdown trigger immediate exit',
      violated: true,
      severity: 'high',
      detail: `mid-trade dd ${(trade.max_drawdown_during_hold_pct * 100).toFixed(1)}%, 但仍持仓`,
    });
  }
  if (trade.held_over_weekend && trade.realized_vol_during_hold > 0.4) {
    out.push({
      wizard_name: 'PTJ',
      rule: '高 vol (>40% annualized) 仓位不过周末',
      violated: true,
      severity: 'medium',
      detail: `realized vol=${(trade.realized_vol_during_hold * 100).toFixed(
        1
      )}% 但 held over weekend`,
    });
  }
  return out;
}

/**
 * Check Michael Marcus rules.
 *
 *   - "Risk ≤ 5% per trade"
 *   - "顺势 — 不逆 trend 抄底"
 */
export function checkMichaelMarcus(trade: {
  position_size_pct: number;
  stop_loss_distance_pct: number;
  market_trend: 'up' | 'down' | 'sideways';
  trade_direction: 'BUY' | 'SELL';
}): WizardRuleViolation[] {
  const out: WizardRuleViolation[] = [];
  const max_risk = trade.position_size_pct * trade.stop_loss_distance_pct;
  if (max_risk > 0.05) {
    out.push({
      wizard_name: 'Marcus',
      rule: 'Risk per trade ≤ 5%',
      violated: true,
      severity: 'high',
      detail: `max_risk = ${(max_risk * 100).toFixed(1)}% (仓位 ${(
        trade.position_size_pct * 100
      ).toFixed(1)}% × stop ${(trade.stop_loss_distance_pct * 100).toFixed(1)}%)`,
    });
  }
  // Counter-trend BUY in down-trend
  if (trade.trade_direction === 'BUY' && trade.market_trend === 'down') {
    out.push({
      wizard_name: 'Marcus',
      rule: '顺势 — 不在 down-trend 中抄底',
      violated: true,
      severity: 'medium',
      detail: 'BUY in down-trend market',
    });
  }
  return out;
}

/**
 * Check Bruce Kovner rules.
 *
 *   - "想 worst case 在前 — 永远先算最坏会亏多少"
 *   - "reward/risk ≥ 3:1"
 */
export function checkBruceKovner(trade: {
  expected_target_pct: number;
  expected_stop_pct: number;
  worst_case_analyzed_pre_trade: boolean;
}): WizardRuleViolation[] {
  const out: WizardRuleViolation[] = [];
  if (!trade.worst_case_analyzed_pre_trade) {
    out.push({
      wizard_name: 'Kovner',
      rule: '入场前必算 worst case',
      violated: true,
      severity: 'medium',
      detail: 'worst_case_analyzed_pre_trade = false',
    });
  }
  if (trade.expected_stop_pct > 0) {
    const rr = Math.abs(trade.expected_target_pct / trade.expected_stop_pct);
    if (rr < 3) {
      out.push({
        wizard_name: 'Kovner',
        rule: 'Reward/Risk ≥ 3:1',
        violated: true,
        severity: 'low',
        detail: `RR = ${rr.toFixed(2)}, target ${(trade.expected_target_pct * 100).toFixed(
          1
        )}% / stop ${(trade.expected_stop_pct * 100).toFixed(1)}%`,
      });
    }
  }
  return out;
}

/**
 * Check Soros reflexivity rule.
 *
 *   - "Theory of reflexivity — when fundamentals & price diverge, find catalyst"
 *
 *   实操: 如果 price 远超 fundamental (P/E > 2× history avg), 卖出 catalyst 必须明确.
 */
export function checkSorosReflexivity(trade: {
  current_pe: number;
  historical_avg_pe: number;
  has_specific_catalyst: boolean;
  trade_direction: 'BUY' | 'SELL';
}): WizardRuleViolation[] {
  const out: WizardRuleViolation[] = [];
  if (trade.trade_direction === 'BUY' && trade.historical_avg_pe > 0) {
    const pe_ratio = trade.current_pe / trade.historical_avg_pe;
    if (pe_ratio > 2 && !trade.has_specific_catalyst) {
      out.push({
        wizard_name: 'Soros',
        rule: '高估买入必须有明确 catalyst',
        violated: true,
        severity: 'medium',
        detail: `P/E 是历史 ${pe_ratio.toFixed(2)}× 但无明确 catalyst`,
      });
    }
  }
  return out;
}

/**
 * Aggregate all 5 wizards' violations for a trade.
 */
export function checkAllWizards(trade: {
  realized_pnl_pct: number;
  position_size_pct: number;
  conviction_level: number;
  max_drawdown_during_hold_pct: number;
  closed_pre_weekend: boolean;
  held_over_weekend: boolean;
  realized_vol_during_hold: number;
  stop_loss_distance_pct: number;
  market_trend: 'up' | 'down' | 'sideways';
  trade_direction: 'BUY' | 'SELL';
  expected_target_pct: number;
  expected_stop_pct: number;
  worst_case_analyzed_pre_trade: boolean;
  current_pe: number;
  historical_avg_pe: number;
  has_specific_catalyst: boolean;
}): {
  total_violations: number;
  by_wizard: Record<string, WizardRuleViolation[]>;
  severity_score: number; // 0-100, 0 = perfect, 100 = all high-severity
  rule_compliance_grade: 'A' | 'B' | 'C' | 'D' | 'F';
} {
  const all_violations = [
    ...checkDruckenmiller(trade),
    ...checkPaulTudorJones(trade),
    ...checkMichaelMarcus(trade),
    ...checkBruceKovner(trade),
    ...checkSorosReflexivity(trade),
  ];
  const by_wizard: Record<string, WizardRuleViolation[]> = {};
  for (const v of all_violations) {
    if (!by_wizard[v.wizard_name]) by_wizard[v.wizard_name] = [];
    by_wizard[v.wizard_name].push(v);
  }
  let severity_score = 0;
  for (const v of all_violations) {
    severity_score += v.severity === 'high' ? 30 : v.severity === 'medium' ? 15 : 5;
  }
  severity_score = Math.min(100, severity_score);
  let grade: 'A' | 'B' | 'C' | 'D' | 'F';
  if (severity_score === 0) grade = 'A';
  else if (severity_score < 20) grade = 'B';
  else if (severity_score < 50) grade = 'C';
  else if (severity_score < 80) grade = 'D';
  else grade = 'F';
  return {
    total_violations: all_violations.length,
    by_wizard,
    severity_score,
    rule_compliance_grade: grade,
  };
}

// ============================================================
// Quant Postmortem Scoring (replaces free-text)
// ============================================================

export interface QuantPostmortemScore {
  thesis_validity: number; // 0-100: 原 thesis 是否事后看仍合理
  execution_quality: number; // 0-100: 撮合时机
  sizing_appropriateness: number; // 0-100: 仓位是否合适
  exit_timing: number; // 0-100: 退出时机
  learning_extraction: number; // 0-100: 是否记录 learnings
  composite_score: number; // 0-100 weighted
  classification: 'true_alpha' | 'variance_loss' | 'lucky_win' | 'bad_execution';
  improvement_areas: string[];
}

/**
 * Compute quantitative postmortem score for a closed trade.
 */
export function computeQuantPostmortemScore(input: {
  // Thesis
  thesis_predicted_direction_correct: boolean;
  thesis_predicted_magnitude_pct: number;
  actual_magnitude_pct: number;
  // Execution
  entry_slippage_bps: number; // entry actual vs plan
  exit_slippage_bps: number;
  // Sizing
  position_size_pct: number;
  optimal_size_pct: number; // ex-post optimal
  // Exit
  exit_at_optimal_window: boolean;
  hold_too_long_days: number; // beyond optimal hold
  hold_too_short_days: number;
  // Learning
  learnings_documented: boolean;
  rule_changes_proposed: number;
}): QuantPostmortemScore {
  // Thesis validity
  let thesis = 100;
  if (!input.thesis_predicted_direction_correct) thesis -= 50;
  const mag_error =
    Math.abs(input.thesis_predicted_magnitude_pct - input.actual_magnitude_pct) /
    Math.max(0.01, Math.abs(input.thesis_predicted_magnitude_pct));
  thesis -= Math.min(50, mag_error * 30);
  thesis = Math.max(0, thesis);

  // Execution
  let execution = 100;
  execution -= Math.min(50, input.entry_slippage_bps / 10);
  execution -= Math.min(50, input.exit_slippage_bps / 10);
  execution = Math.max(0, execution);

  // Sizing
  let sizing = 100;
  const size_diff =
    Math.abs(input.position_size_pct - input.optimal_size_pct) /
    Math.max(0.001, input.optimal_size_pct);
  sizing -= Math.min(60, size_diff * 50);
  sizing = Math.max(0, sizing);

  // Exit
  let exit_score = 100;
  if (!input.exit_at_optimal_window) exit_score -= 30;
  exit_score -= Math.min(40, input.hold_too_long_days * 3);
  exit_score -= Math.min(30, input.hold_too_short_days * 3);
  exit_score = Math.max(0, exit_score);

  // Learning
  let learning = 100;
  if (!input.learnings_documented) learning -= 60;
  if (input.rule_changes_proposed === 0) learning -= 30;
  learning = Math.max(0, learning);

  const composite = Math.round(
    0.3 * thesis + 0.2 * execution + 0.2 * sizing + 0.2 * exit_score + 0.1 * learning
  );

  // Classification (decision quality + outcome)
  const dq_high = composite >= 70;
  const outcome_positive =
    (input.thesis_predicted_direction_correct
      ? input.actual_magnitude_pct
      : -input.actual_magnitude_pct) > 0;
  let classification: 'true_alpha' | 'variance_loss' | 'lucky_win' | 'bad_execution';
  if (dq_high && outcome_positive) classification = 'true_alpha';
  else if (dq_high && !outcome_positive) classification = 'variance_loss';
  else if (!dq_high && outcome_positive) classification = 'lucky_win';
  else classification = 'bad_execution';

  // Improvement areas
  const areas: string[] = [];
  if (thesis < 70) areas.push('Thesis: 重新审视 entry 论据');
  if (execution < 70) areas.push('Execution: 优化撮合 (limit vs market)');
  if (sizing < 70) areas.push('Sizing: 更严格按 vol-adjusted Kelly');
  if (exit_score < 70) areas.push('Exit: 设 trailing stop 或 time-stop');
  if (learning < 70) areas.push('Learning: 必须 documentpostmortem');

  return {
    thesis_validity: Math.round(thesis),
    execution_quality: Math.round(execution),
    sizing_appropriateness: Math.round(sizing),
    exit_timing: Math.round(exit_score),
    learning_extraction: Math.round(learning),
    composite_score: composite,
    classification,
    improvement_areas: areas,
  };
}

// ============================================================
// Auto-apply DQS to closed trades (production hook)
// ============================================================

/**
 * Auto-compute DQS for a closed trade row (intended for cron hook on
 * RecommendationTradeOutcome.afterUpdate when trade_status = 'closed').
 *
 * Returns DQS metadata to merge into outcome.metadata.dqs.
 */
export function autoApplyDqsToClosedTrade(outcome: {
  // Outcome row fields
  entry_date: string;
  exit_date: string | null;
  entry_price: number;
  exit_price: number | null;
  total_pnl_pct: number;
  holding_days: number;
  metadata: any;
  // Reconstructed inputs (caller may need to fill from external sources)
  thesis_recorded_pre_trade?: boolean;
  data_support_count?: number;
  stop_loss_honored?: boolean;
  conviction_level?: number;
  position_size_pct?: number;
}): { triplet: TradeReasonTriplet; postmortem_summary: string } {
  const triplet = computeReasonTriplet({
    thesis_recorded_pre_trade: outcome.thesis_recorded_pre_trade ?? false,
    data_support_count: outcome.data_support_count ?? 1,
    entry_at_planned_price: true, // default assume yes if no data
    exit_per_plan: outcome.exit_date !== null,
    stop_loss_honored: outcome.stop_loss_honored ?? outcome.total_pnl_pct > -0.1,
    emotional_exit_flag: outcome.holding_days < 2 && Math.abs(outcome.total_pnl_pct) < 0.02,
    conviction_level: outcome.conviction_level ?? 5,
    position_size_pct: outcome.position_size_pct ?? 0.05,
    vol_target_size_pct: 0.05, // default
  });

  let summary: string;
  if (triplet.composite_dqs >= 80) summary = '✅ 高质量决策 (DQS≥80)';
  else if (triplet.composite_dqs >= 60) summary = '🟢 决策质量 OK';
  else if (triplet.composite_dqs >= 40)
    summary = '🟠 决策质量待改进 — ' + triplet.weaknesses.slice(0, 2).join('; ');
  else summary = '🔴 决策质量差 — ' + triplet.weaknesses.slice(0, 3).join('; ');

  return { triplet, postmortem_summary: summary };
}
