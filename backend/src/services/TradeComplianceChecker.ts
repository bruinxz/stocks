/**
 * TradeComplianceChecker — Schwager Market Wizards 规则合规检查 (Sprint 24)
 *
 * 在每笔 closed RecommendationTradeOutcome 触发, 用 Sprint 22 的
 * `checkAllWizards` 5 wizard rule 检测违规:
 *   - Druckenmiller (保护本金 + 集中)
 *   - Paul Tudor Jones (5% stop + 不持周末)
 *   - Michael Marcus (risk ≤ 5% + 顺势)
 *   - Bruce Kovner (worst case + RR 3:1)
 *   - Soros (reflexivity + catalyst)
 *
 * grade 输出:
 *   - A (0 violations) / B (1-2 minor) / C (3-4) / D (5-6) / F (7+)
 *
 * grade D/F 或 severity_score > 50 → 写 RiskAlert(level='MEDIUM',
 * rule_id='wizard_compliance', symbol='SYSTEM:WIZARD_VIOLATION') 让用户在
 * 风控面板看到 "本笔交易违反 X 条 wizards 规则" 提醒.
 *
 * 与 TradeRootCauseClassifier 关系: 互补.
 *   - RootCauseClassifier: 这笔交易亏损的根因 (wrong_entry / wrong_regime / ...)
 *   - ComplianceChecker: 这笔交易 (无论盈亏) 违反了哪些资深操盘手的纪律
 *
 * 即便盈利但违反多条规则 (e.g. 没设 stop / 仓位过大), grade 也会差 — 这是
 * "DQS 赚钱但不符合纪律, 要扣分" 的实现.
 */

import { checkAllWizards } from './governor/trader-mind-deep';
import { logger } from '../utils/logger';

export interface ComplianceCheckInput {
  realized_pnl_pct: number;
  position_size_pct: number;
  conviction_level: number;        // 1-10
  max_drawdown_during_hold_pct: number;
  closed_pre_weekend: boolean;
  held_over_weekend: boolean;
  realized_vol_during_hold: number; // annualized
  stop_loss_distance_pct: number;
  market_trend: 'up' | 'down' | 'sideways';
  trade_direction: 'BUY' | 'SELL';
  expected_target_pct: number;
  expected_stop_pct: number;
  worst_case_analyzed_pre_trade: boolean;
  current_pe: number;
  historical_avg_pe: number;
  has_specific_catalyst: boolean;
}

export interface ComplianceCheckResult {
  total_violations: number;
  severity_score: number;
  rule_compliance_grade: 'A' | 'B' | 'C' | 'D' | 'F';
  violations: Array<{ wizard: string; rule: string; severity: string; detail: string }>;
  summary_message: string;
  should_alert: boolean;
}

/**
 * Run all wizard checks on a closed trade.
 */
export function checkTradeCompliance(input: ComplianceCheckInput): ComplianceCheckResult {
  const wizardOutput = checkAllWizards(input);
  const should_alert =
    wizardOutput.rule_compliance_grade === 'D' ||
    wizardOutput.rule_compliance_grade === 'F' ||
    wizardOutput.severity_score > 50;

  // Flatten by_wizard map into a single ordered violation list
  const flatViolations: Array<{ wizard: string; rule: string; severity: string; detail: string }> = [];
  for (const [wizardName, rules] of Object.entries(wizardOutput.by_wizard)) {
    for (const v of rules) {
      flatViolations.push({
        wizard: wizardName,
        rule: v.rule,
        severity: v.severity,
        detail: v.detail,
      });
    }
  }
  // Sort high → medium → low
  const sevOrder = { high: 0, medium: 1, low: 2 } as const;
  flatViolations.sort((a, b) => (sevOrder[a.severity as 'high' | 'medium' | 'low'] - sevOrder[b.severity as 'high' | 'medium' | 'low']));

  const summary = wizardOutput.total_violations === 0
    ? `Grade A: 完美遵守 5 wizards 规则`
    : `Grade ${wizardOutput.rule_compliance_grade}: ${wizardOutput.total_violations} 条违规, severity=${wizardOutput.severity_score.toFixed(0)}/100`;

  return {
    total_violations: wizardOutput.total_violations,
    severity_score: wizardOutput.severity_score,
    rule_compliance_grade: wizardOutput.rule_compliance_grade,
    violations: flatViolations,
    summary_message: summary,
    should_alert,
  };
}

/**
 * Write a RiskAlert if grade D/F or severity > 50.
 *
 * 严重违规时入风控面板, 用户看到 "本笔交易违反 5 条 wizards 规则" 提醒.
 * 失败 swallow 不阻塞 caller.
 */
export async function emitWizardAlert(input: {
  user_id: number;
  outcome_id: number;
  symbol: string;
  name?: string;
  trade_direction: 'BUY' | 'SELL';
  realized_pnl_pct: number;
  result: ComplianceCheckResult;
}): Promise<{ alert_written: boolean; alert_id?: number; reason?: string }> {
  if (!input.result.should_alert) {
    return { alert_written: false, reason: 'grade pass threshold' };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RiskAlert } = require('../models/RiskAlert');
    const violationsList = input.result.violations
      .slice(0, 3)
      .map(v => `${v.wizard}: ${v.rule}`)
      .join('; ');
    const alert = await RiskAlert.create({
      user_id: input.user_id,
      symbol: 'SYSTEM:WIZARD_VIOLATION',
      name: `交易合规违规 (${input.symbol})`,
      level: 'MEDIUM',
      rule_id: 'wizard_compliance',
      message: `📋 ${input.symbol} (${input.trade_direction}, PnL=${(input.realized_pnl_pct * 100).toFixed(1)}%) — Grade ${input.result.rule_compliance_grade}: ${input.result.total_violations} 条违规, severity=${input.result.severity_score.toFixed(0)}. ${violationsList}${input.result.violations.length > 3 ? `; +${input.result.violations.length - 3} more` : ''}`,
      metadata: {
        outcome_id: input.outcome_id,
        grade: input.result.rule_compliance_grade,
        severity_score: input.result.severity_score,
        violations: input.result.violations,
      },
    });
    return { alert_written: true, alert_id: alert.id };
  } catch (err: any) {
    logger.warn(`[TradeCompliance] emitWizardAlert failed: ${err?.message || err}`);
    return { alert_written: false, reason: err?.message || String(err) };
  }
}
