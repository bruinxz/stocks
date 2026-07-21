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

import { Op } from 'sequelize';
import {
  checkAllWizards,
  checkDruckenmiller,
  checkPaulTudorJones,
  checkMichaelMarcus,
  checkBruceKovner,
  checkSorosReflexivity,
  WizardRuleViolation,
} from './governor/trader-mind-deep';
import { logger } from '../utils/logger';

export interface ComplianceCheckInput {
  realized_pnl_pct: number;
  position_size_pct: number;
  conviction_level: number; // 1-10
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
  const flatViolations: Array<{ wizard: string; rule: string; severity: string; detail: string }> =
    [];
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
  flatViolations.sort(
    (a, b) =>
      sevOrder[a.severity as 'high' | 'medium' | 'low'] -
      sevOrder[b.severity as 'high' | 'medium' | 'low']
  );

  const summary =
    wizardOutput.total_violations === 0
      ? `Grade A: 完美遵守 5 wizards 规则`
      : `Grade ${wizardOutput.rule_compliance_grade}: ${
          wizardOutput.total_violations
        } 条违规, severity=${wizardOutput.severity_score.toFixed(0)}/100`;

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
  portfolio_id?: number;
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
      message: `📋 ${input.symbol} (${input.trade_direction}, PnL=${(
        input.realized_pnl_pct * 100
      ).toFixed(1)}%) — Grade ${input.result.rule_compliance_grade}: ${
        input.result.total_violations
      } 条违规, severity=${input.result.severity_score.toFixed(0)}. ${violationsList}${
        input.result.violations.length > 3 ? `; +${input.result.violations.length - 3} more` : ''
      }`,
      metadata: {
        portfolio_id: input.portfolio_id,
        symbol: input.symbol,
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

// =====================================================================
// BETA-1 (2026-06-18): Pre-trade 合规 gate
// =====================================================================
// audit S-5 修复：5 wizard rule 之前只在 RecommendationTradeOutcome.afterUpdate
// 事后跑（出场后告警）。本模块新增 `checkPreTradeCompliance`，让 BUY 草稿/审批
// 入口在下单前先跑可前置的 5 个 wizard 子检查 +  3 个 pre-trade 独有规则（次日
// 追高 / 频繁交易 / 信号陈旧），抛硬否决 (severity='high') 拒单，软违规
// (severity='medium') 仍下单但写 RiskAlert LOW 让 ops 看到。
//
// 设计判据：
//  1. 复用 trader-mind-deep 中已存在的 5 个 check* 子函数（**不重写 wizard 规则**），
//     仅按 pre-trade 阶段已知的字段裁剪：position_size_pct / conviction_level /
//     stop_loss_distance_pct / market_trend / current_pe / historical_avg_pe /
//     has_specific_catalyst 等可在下单前推断。
//  2. **额外**加 3 个 pre-trade 独有 wizard：
//     a. NEXT_DAY_CHASE  — Druckenmiller "不追高" 衍生：T 日已上 7% 还买 → high；
//     b. FREQUENT_TRADING — Marcus "顺势/纪律" 衍生：同 symbol 7 日内 BUY ≥ 3 次 → medium；
//     c. MIN_HOLDING_PERIOD — PTJ "不日内换手" 衍生：BUY 后 N 日内同 portfolio
//        重复 BUY 同 symbol → low (信息性,不阻塞)。
//     d. STALE_SIGNAL — Kovner "worst-case 必算" 衍生：信号陈旧 > 24h → medium。
//  3. **fail-OPEN**：DB / 数据缺失时返回 ok=true + 警告 log，不阻塞业务。
//     与本仓 risk/ 软 gate 一致；硬风控保留在 PositionLimitGuard / DrawdownBreaker。
//  4. **caller 决定阻塞策略**：本模块只返回 violations，caller (createBuyTrade /
//     approveDraft) 按 severity 选择 throw / RiskAlert / log。

/** Pre-trade 草稿输入。允许字段大多 optional，未知字段不参与子规则评估。 */
export interface PreTradeComplianceDraft {
  user_id: number;
  portfolio_id?: number;
  /** A 股 6 位代码（不含 sh./sz. 前缀，与 PaperTradingTrade.symbol 一致） */
  symbol: string;
  side: 'BUY' | 'SELL';
  /** 拟下单价 */
  price: number;
  /** 拟下单数量（股） */
  quantity: number;
  /** 本次拟下单仓位占组合总资产比 (0-1)，由 caller 计算后传入 */
  position_size_pct?: number;
  /** signal_score / fusion_score / conviction 1-10 */
  conviction_level?: number;
  strategy_key?: string;
  /** 风控配置中的止损距离 % (0-1)，例如 0.07 */
  stop_loss_distance_pct?: number;
  /** 大盘 / 行业趋势 */
  market_trend?: 'up' | 'down' | 'sideways';
  /** 当前 PE */
  current_pe?: number;
  /** 历史均值 PE（5 年） */
  historical_avg_pe?: number;
  has_specific_catalyst?: boolean;
  /** 当日相对昨收涨幅 (0-1)，例如 0.08 = 涨 8% */
  intraday_change_pct?: number;
  /** 信号产生时间戳 (ms) — 早于 24h 算 stale */
  signal_timestamp_ms?: number;
  /** caller 可显式 disable（如 EOD 强平 / 系统 rebalance） */
  bypass?: boolean;
}

export interface PreTradeComplianceViolation {
  rule: string;
  wizard: string;
  severity: 'high' | 'medium' | 'low';
  reason: string;
}

export interface PreTradeComplianceResult {
  ok: boolean;
  /** 是否拒单（high severity 时为 true） */
  block: boolean;
  violations: PreTradeComplianceViolation[];
  summary: string;
}

/** 最小持有期（天）—— 同 portfolio 同 symbol 在窗口内重复 BUY 视为频繁交易。 */
const MIN_HOLDING_PERIOD_DAYS = 3;
/** 频繁交易窗口（天）—— 同 portfolio 同 symbol N 天内 BUY 次数。 */
const FREQUENT_TRADING_WINDOW_DAYS = 7;
const FREQUENT_TRADING_MAX_BUYS = 3;
/** 信号陈旧阈值（小时） */
const STALE_SIGNAL_HOURS = 24;
/** 次日追高阈值 —— 当日已涨 7% 仍 BUY = high。 */
const CHASE_HIGH_PCT_THRESHOLD = 0.07;

function flattenWizardViolations(violations: WizardRuleViolation[]): PreTradeComplianceViolation[] {
  return violations.map(v => ({
    wizard: v.wizard_name,
    rule: v.rule,
    severity: v.severity,
    reason: v.detail,
  }));
}

/**
 * 在 BUY 草稿真正写库前调用。返回值 `block=true` 时 caller 必须拒单。
 *
 * 内部聚合 5 个 trader-mind wizard 中**可在 pre-trade 阶段评估**的子规则 +
 * 3 个 pre-trade 独有规则。SELL 路径暂不跑（SELL 多是止损 / 止盈，规则不适用），
 * 直接返回 ok=true。
 */
export async function checkPreTradeCompliance(
  draft: PreTradeComplianceDraft
): Promise<PreTradeComplianceResult> {
  const violations: PreTradeComplianceViolation[] = [];

  if (draft.bypass) {
    return { ok: true, block: false, violations: [], summary: 'pre-trade compliance bypassed' };
  }
  if (draft.side !== 'BUY') {
    return { ok: true, block: false, violations: [], summary: 'SELL 路径不跑 pre-trade wizard' };
  }

  try {
    // ============ 1. wizard 子规则（pre-trade 可评估的部分） ============
    const positionSize = Number.isFinite(draft.position_size_pct as number)
      ? Number(draft.position_size_pct)
      : 0;
    const conviction = Number.isFinite(draft.conviction_level as number)
      ? Number(draft.conviction_level)
      : 5;
    const stopLoss = Number.isFinite(draft.stop_loss_distance_pct as number)
      ? Number(draft.stop_loss_distance_pct)
      : 0.07;
    const marketTrend = draft.market_trend || 'sideways';

    // Druckenmiller — 重仓 conviction 不足（保护本金 rule 只能事后判，跳过）
    violations.push(
      ...flattenWizardViolations(
        checkDruckenmiller({
          realized_pnl_pct: 0, // pre-trade 没 realized_pnl，传 0 让 capital-preservation rule 永不命中
          position_size_pct: positionSize,
          conviction_level: conviction,
        })
      )
    );

    // Marcus — Risk per trade ≤ 5% + 顺势
    violations.push(
      ...flattenWizardViolations(
        checkMichaelMarcus({
          position_size_pct: positionSize,
          stop_loss_distance_pct: stopLoss,
          market_trend: marketTrend,
          trade_direction: 'BUY',
        })
      )
    );

    // Kovner — RR ≥ 3:1（pre-trade 可能传 expected_target_pct，否则 skip）
    // pre-trade 暂只传 stop_loss_distance_pct；target 由策略层算，这里设 0 让 RR rule skip
    violations.push(
      ...flattenWizardViolations(
        checkBruceKovner({
          expected_target_pct: 0,
          expected_stop_pct: stopLoss,
          worst_case_analyzed_pre_trade: true, // 通过本 gate 即视为已分析
        })
      )
    );

    // Soros — 高估买入需有 catalyst
    if (
      Number.isFinite(draft.current_pe as number) &&
      Number.isFinite(draft.historical_avg_pe as number) &&
      (draft.historical_avg_pe as number) > 0
    ) {
      violations.push(
        ...flattenWizardViolations(
          checkSorosReflexivity({
            current_pe: Number(draft.current_pe),
            historical_avg_pe: Number(draft.historical_avg_pe),
            has_specific_catalyst: !!draft.has_specific_catalyst,
            trade_direction: 'BUY',
          })
        )
      );
    }

    // PTJ — 持仓过周末等 5% drawdown 仅事后能判，pre-trade 跳过

    // ============ 2. pre-trade 独有 wizard ============

    // 2a. NEXT_DAY_CHASE — 当日已涨 ≥ 7% 还 BUY → high
    if (Number.isFinite(draft.intraday_change_pct as number)) {
      const chg = Number(draft.intraday_change_pct);
      if (chg >= CHASE_HIGH_PCT_THRESHOLD) {
        violations.push({
          wizard: 'PreTrade',
          rule: 'NEXT_DAY_CHASE — 当日已上 7% 不追高',
          severity: 'high',
          reason: `${draft.symbol} 当日已涨 ${(chg * 100).toFixed(2)}%，超过 7% 追高阈值`,
        });
      }
    }

    // 2b. FREQUENT_TRADING — 7 日窗口同 portfolio 同 symbol BUY ≥ 3 次 → medium
    if (draft.portfolio_id) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingTrade } = require('../models/PaperTradingTrade');
        const since = new Date(Date.now() - FREQUENT_TRADING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        const recentBuyCount = await PaperTradingTrade.count({
          where: {
            portfolio_id: draft.portfolio_id,
            symbol: draft.symbol,
            direction: 'BUY',
            created_at: { [Op.gte]: since },
          },
        });
        if (recentBuyCount >= FREQUENT_TRADING_MAX_BUYS) {
          violations.push({
            wizard: 'PreTrade',
            rule: 'FREQUENT_TRADING — 同 symbol 7 日内 BUY 次数过多',
            severity: 'medium',
            reason: `portfolio ${draft.portfolio_id} 在过去 ${FREQUENT_TRADING_WINDOW_DAYS} 天对 ${draft.symbol} 已 BUY ${recentBuyCount} 次（≥ ${FREQUENT_TRADING_MAX_BUYS}）`,
          });
        }

        // 2c. MIN_HOLDING_PERIOD — 同 portfolio 上次 BUY 在 N 天内 → low
        const lastBuy = await PaperTradingTrade.findOne({
          where: {
            portfolio_id: draft.portfolio_id,
            symbol: draft.symbol,
            direction: 'BUY',
          },
          order: [['created_at', 'DESC']],
        });
        if (lastBuy) {
          const ageDays =
            (Date.now() - new Date((lastBuy as any).created_at).getTime()) / (24 * 60 * 60 * 1000);
          if (ageDays < MIN_HOLDING_PERIOD_DAYS) {
            violations.push({
              wizard: 'PreTrade',
              rule: 'MIN_HOLDING_PERIOD — 最低持有期内重复 BUY',
              severity: 'low',
              reason: `portfolio ${draft.portfolio_id} 上次 BUY ${
                draft.symbol
              } 在 ${ageDays.toFixed(1)} 天前 (< ${MIN_HOLDING_PERIOD_DAYS} 天最低持有期)`,
            });
          }
        }
      } catch (err: any) {
        // fail-OPEN: DB 查询失败不阻塞业务；只 log
        logger.warn(
          `[checkPreTradeCompliance] FREQUENT_TRADING/MIN_HOLDING_PERIOD 查询失败 (fail-open): ${
            err?.message || err
          }`
        );
      }
    }

    // 2d. STALE_SIGNAL — 信号 timestamp > 24h → medium
    if (Number.isFinite(draft.signal_timestamp_ms as number)) {
      const ts = Number(draft.signal_timestamp_ms);
      const ageHours = (Date.now() - ts) / (60 * 60 * 1000);
      if (ageHours > STALE_SIGNAL_HOURS) {
        violations.push({
          wizard: 'PreTrade',
          rule: 'STALE_SIGNAL — 信号陈旧',
          severity: 'medium',
          reason: `信号 timestamp 距今 ${ageHours.toFixed(1)} 小时 (> ${STALE_SIGNAL_HOURS}h)`,
        });
      }
    }
  } catch (err: any) {
    // 顶层 fail-OPEN
    logger.warn(`[checkPreTradeCompliance] 内部异常 (fail-open): ${err?.message || err}`);
    return {
      ok: true,
      block: false,
      violations: [],
      summary: `pre-trade compliance 检查异常: ${err?.message || err}（fail-open）`,
    };
  }

  // 排序：high → medium → low
  const sevOrder = { high: 0, medium: 1, low: 2 } as const;
  violations.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  const hasHigh = violations.some(v => v.severity === 'high');
  const summary =
    violations.length === 0
      ? 'pre-trade compliance: 0 违规'
      : `pre-trade compliance: ${violations.length} 条违规 (high=${
          violations.filter(v => v.severity === 'high').length
        }, medium=${violations.filter(v => v.severity === 'medium').length}, low=${
          violations.filter(v => v.severity === 'low').length
        })`;

  return {
    ok: !hasHigh,
    block: hasHigh,
    violations,
    summary,
  };
}

/**
 * 写一条 pre-trade compliance 告警（区别于 emitWizardAlert 的事后告警）。
 *
 *   - severity='high' → 调用方应直接拒单 + 写 MEDIUM RiskAlert
 *   - severity='medium' → 调用方放行但写 LOW RiskAlert
 *   - severity='low' → 调用方放行（不写 RiskAlert，仅 log）
 *
 * 与 emitWizardAlert 共用 RiskAlert.rule_id='wizard_compliance' 让
 * RealtimeAlertDispatcher dedup 一致。失败 swallow 不阻塞 caller。
 */
export async function emitPreTradeComplianceAlert(input: {
  user_id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  level: 'MEDIUM' | 'LOW';
  draft: PreTradeComplianceDraft;
  result: PreTradeComplianceResult;
}): Promise<{ alert_written: boolean; alert_id?: number; reason?: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RiskAlert } = require('../models/RiskAlert');
    const violationsList = input.result.violations
      .slice(0, 3)
      .map(v => `${v.wizard}:${v.rule}`)
      .join('; ');
    const alert = await RiskAlert.create({
      user_id: input.user_id,
      symbol: 'SYSTEM:PRE_TRADE_COMPLIANCE',
      name: `pre-trade 合规${input.level === 'MEDIUM' ? '阻断' : '提示'} (${input.symbol})`,
      level: input.level,
      rule_id: 'wizard_compliance',
      message: `🚦 ${input.symbol} (${input.side}) — ${input.result.summary}; ${violationsList}${
        input.result.violations.length > 3 ? `; +${input.result.violations.length - 3} more` : ''
      }`,
      metadata: {
        portfolio_id: input.draft.portfolio_id,
        symbol: input.symbol,
        draft: {
          portfolio_id: input.draft.portfolio_id,
          price: input.draft.price,
          quantity: input.draft.quantity,
          strategy_key: input.draft.strategy_key,
        },
        violations: input.result.violations,
        block: input.result.block,
      },
    });
    return { alert_written: true, alert_id: alert.id };
  } catch (err: any) {
    logger.warn(`[TradeCompliance] emitPreTradeComplianceAlert failed: ${err?.message || err}`);
    return { alert_written: false, reason: err?.message || String(err) };
  }
}
