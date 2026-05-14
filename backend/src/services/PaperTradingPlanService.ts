import moment from 'moment-timezone';
import {
  PaperTradingAutoResult,
  PaperTradingRiskCheckResult,
  paperTradingAutomationService,
} from './PaperTradingAutomationService';
import {
  PaperTradingAttributionResult,
  paperTradingAttributionService,
} from './PaperTradingAttributionService';
import { feishuTaskReportService } from './FeishuTaskReportService';

export type TradingPlanActionType = 'exit' | 'entry' | 'monitor' | 'review';
export type TradingPlanPriority = 'critical' | 'high' | 'medium' | 'low';

export interface PaperTradingPlanOptions {
  user_id?: number;
  username?: string;
  portfolio_id?: number;
  portfolio_name?: string;
  initial_capital?: number;
  force_new_portfolio?: boolean;
  include_entries?: boolean;
  include_exits?: boolean;
  include_monitor?: boolean;
  report_to_feishu?: boolean;
  source_type?: string;
  limit?: number;
  entry_limit?: number;
  scan_limit?: number;
  min_score?: number;
  max_positions?: number;
  default_position_pct?: number;
  max_position_pct?: number;
  min_trade_amount?: number;
  allowed_risk_levels?: string[];
  use_attribution_feedback?: boolean;
  use_profit_gate?: boolean;
  profit_gate_horizon?: string;
  profit_gate_min_samples?: number;
  profit_gate_min_quality_score?: number;
  profit_gate_allow_deprioritized?: boolean;
  profit_gate_allow_sampling?: boolean;
  profit_gate_sampling_multiplier?: number;
  use_outcome_feedback?: boolean;
  outcome_feedback_min_closed_samples?: number;
  outcome_feedback_lookback_days?: number;
  outcome_feedback_limit?: number;
  enable_stop_loss?: boolean;
  enable_take_profit?: boolean;
  enable_trailing_take_profit?: boolean;
  enable_sell_signals?: boolean;
  default_stop_loss_pct?: number;
  default_take_profit_pct?: number;
  trailing_activation_pct?: number;
  trailing_drawdown_pct?: number;
  max_hold_days?: number;
  min_sell_signal_score?: number;
  sell_signal_source_type?: string;
}

export interface TradingPlanAction {
  action_type: TradingPlanActionType;
  priority: TradingPlanPriority;
  symbol?: string;
  name?: string;
  action_label: string;
  reason: string;
  instructions: string[];
  quantity?: number;
  reference_price?: number;
  estimated_amount?: number;
  estimated_cash_change?: number;
  estimated_pnl?: number;
  estimated_pnl_pct?: number;
  holding_days?: number;
  signal_id?: number;
  source_signal_id?: number;
  source_type?: string;
  score?: number;
  risk_level?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface PaperTradingPlanResult {
  portfolio_id: number;
  user_id: number;
  generated_at: string;
  mode: 'daily_plan';
  summary: {
    action_count: number;
    urgent_count: number;
    exit_count: number;
    entry_count: number;
    monitor_count: number;
    review_count: number;
    current_cash: number;
    total_value: number;
    position_value: number;
    planned_sell_cash_inflow: number;
    planned_buy_cash_outflow: number;
    projected_cash_after_plan: number;
    recommended_min_score?: number;
    effective_min_score?: number;
    recommended_allowed_risk_levels?: string[];
    generated_from_closed_samples: number;
    profit_gate_label?: string;
    profit_gate_quality_score?: number;
    profit_gate_position_multiplier?: number;
    outcome_feedback_enabled?: boolean;
    outcome_closed_samples?: number;
    outcome_min_closed_samples?: number;
    outcome_avg_excess_return_pct?: number;
    outcome_excess_win_rate?: number;
    outcome_recommended_min_score?: number;
    outcome_effective_min_score?: number;
    outcome_position_multiplier?: number;
    outcome_reason?: string;
    outcome_blocked_segments?: any[];
  };
  actions: TradingPlanAction[];
  attribution: PaperTradingAttributionResult;
  risk_check?: PaperTradingRiskCheckResult;
  entry_preview?: PaperTradingAutoResult;
}

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const normalized = Math.floor(num);
  return max ? Math.min(normalized, max) : normalized;
}

function toBoolean(value: any, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function priorityWeight(priority: TradingPlanPriority): number {
  const weights: Record<TradingPlanPriority, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  return weights[priority] || 0;
}

class PaperTradingPlanService {
  async generatePlan(options: PaperTradingPlanOptions = {}): Promise<PaperTradingPlanResult> {
    const includeEntries = toBoolean(options.include_entries, true);
    const includeExits = toBoolean(options.include_exits, true);
    const includeMonitor = toBoolean(options.include_monitor, true);
    const reportToFeishu = toBoolean(options.report_to_feishu, false);
    const entryLimit = toPositiveInt(options.entry_limit || options.limit, 3, 20);
    const maxPositions = toPositiveInt(options.max_positions, 8, 30);

    const attribution = await paperTradingAttributionService.getAttribution({
      user_id: options.user_id,
      username: options.username,
      portfolio_id: options.portfolio_id,
      portfolio_name: options.portfolio_name,
      initial_capital: options.initial_capital,
      force_new_portfolio: options.force_new_portfolio,
      include_open: true,
      source_type: options.source_type,
      report_to_feishu: false,
    });

    let riskCheck: PaperTradingRiskCheckResult | undefined;
    if (includeExits) {
      riskCheck = await paperTradingAutomationService.runRiskCheck({
        user_id: options.user_id,
        username: options.username,
        portfolio_name: options.portfolio_name,
        initial_capital: options.initial_capital,
        force_new_portfolio: options.force_new_portfolio,
        dry_run: true,
        report_to_feishu: false,
        limit: toPositiveInt(options.limit, 30, 100),
        enable_stop_loss: options.enable_stop_loss,
        enable_take_profit: options.enable_take_profit,
        enable_trailing_take_profit: options.enable_trailing_take_profit,
        enable_sell_signals: options.enable_sell_signals,
        default_stop_loss_pct: options.default_stop_loss_pct,
        default_take_profit_pct: options.default_take_profit_pct,
        trailing_activation_pct: options.trailing_activation_pct,
        trailing_drawdown_pct: options.trailing_drawdown_pct,
        max_hold_days: options.max_hold_days,
        min_sell_signal_score: options.min_sell_signal_score,
        sell_signal_source_type: options.sell_signal_source_type,
      });
    }

    let entryPreview: PaperTradingAutoResult | undefined;
    if (includeEntries) {
      entryPreview = await paperTradingAutomationService.autoBuyFromSignals({
        user_id: options.user_id,
        username: options.username,
        portfolio_name: options.portfolio_name,
        initial_capital: options.initial_capital,
        force_new_portfolio: options.force_new_portfolio,
        source_type: options.source_type,
        limit: entryLimit,
        scan_limit: toPositiveInt(options.scan_limit, Math.max(entryLimit * 12, 60), 500),
        min_score: toNumber(options.min_score, 72),
        max_positions: maxPositions + (riskCheck?.exit_candidates || 0),
        default_position_pct: options.default_position_pct,
        max_position_pct: options.max_position_pct,
        min_trade_amount: options.min_trade_amount,
        allowed_risk_levels: options.allowed_risk_levels,
        dry_run: true,
        report_to_feishu: false,
        use_attribution_feedback: options.use_attribution_feedback,
        use_profit_gate: options.use_profit_gate,
        profit_gate_horizon: options.profit_gate_horizon,
        profit_gate_min_samples: options.profit_gate_min_samples,
        profit_gate_min_quality_score: options.profit_gate_min_quality_score,
        profit_gate_allow_deprioritized: options.profit_gate_allow_deprioritized,
        profit_gate_allow_sampling: options.profit_gate_allow_sampling,
        profit_gate_sampling_multiplier: options.profit_gate_sampling_multiplier,
        use_outcome_feedback: options.use_outcome_feedback,
        outcome_feedback_min_closed_samples: options.outcome_feedback_min_closed_samples,
        outcome_feedback_lookback_days: options.outcome_feedback_lookback_days,
        outcome_feedback_limit: options.outcome_feedback_limit,
      });
    }

    const actions: TradingPlanAction[] = [];
    const exitSymbols = new Set<string>();

    if (riskCheck?.exits?.length) {
      for (const item of riskCheck.exits) {
        if (item.symbol) exitSymbols.add(item.symbol);
        actions.push({
          action_type: 'exit',
          priority: this.exitPriority(item.reason, item.pnl_pct),
          symbol: item.symbol,
          name: item.name,
          action_label: item.reason_label || '风控退出',
          reason: `${item.reason_label || item.reason || '触发退出纪律'}，当前盈亏 ${
            item.pnl_pct ?? '--'
          }%，持有 ${item.holding_days ?? '--'} 天${
            item.reason === 'trailing_take_profit'
              ? `，峰值收益 ${item.max_profit_pct ?? '--'}%，峰值回撤 ${item.drawdown_from_peak_pct ?? '--'}%`
              : ''
          }`,
          instructions: [
            `按模拟卖出价 ¥${roundNumber(item.execute_price, 3)} 预估退出 ${item.quantity} 股。`,
            `预计净回款 ¥${roundNumber(item.net_revenue, 2)}，预计实现盈亏 ¥${roundNumber(
              item.realized_pnl,
              2
            )}。`,
            item.reason === 'trailing_take_profit'
              ? `移动止盈：峰值价 ¥${roundNumber(item.peak_price, 3)}，保护线 ¥${roundNumber(
                  item.trailing_stop_price,
                  3
                )}，激活阈值 ${item.trailing_activation_pct ?? '--'}%，回撤阈值 ${
                  item.trailing_drawdown_pct ?? '--'
                }%。`
              : '',
            item.sell_signal_id
              ? `存在卖出信号 #${item.sell_signal_id}，评分 ${item.sell_signal_score ?? '--'}。`
              : '真实下单前确认最新盘口、涨跌停状态和成交量。',
          ].filter(Boolean),
          quantity: item.quantity,
          reference_price: item.execute_price,
          estimated_amount: item.amount,
          estimated_cash_change: item.net_revenue,
          estimated_pnl: item.realized_pnl,
          estimated_pnl_pct: item.pnl_pct,
          holding_days: item.holding_days,
          signal_id: item.sell_signal_id,
          source_signal_id: item.source_signal_id,
          tags: ['risk_exit', item.reason || 'exit'].filter(Boolean),
          metadata: item,
        });
      }
    }

    if (includeMonitor && attribution.open_positions?.length) {
      for (const item of attribution.open_positions.slice(0, 10)) {
        if (exitSymbols.has(item.symbol)) continue;
        const priority = this.monitorPriority(item.risk_state, item.unrealized_pnl_pct);
        actions.push({
          action_type: 'monitor',
          priority,
          symbol: item.symbol,
          name: item.name,
          action_label:
            item.risk_state === 'near_stop_loss'
              ? '临近止损'
              : item.risk_state === 'approaching_take_profit'
                ? '接近止盈'
                : '继续观察',
          reason: `当前浮动盈亏 ${item.unrealized_pnl_pct}% ，距止损 ${
            item.distance_to_stop_loss_pct ?? '--'
          }pct，持有 ${item.holding_days} 天`,
          instructions: [
            item.risk_state === 'near_stop_loss'
              ? '优先人工复核，若盘中继续走弱可提前执行减仓或止损。'
              : '保持原有纪律，不追涨加仓。',
            `当前市值 ¥${roundNumber(item.market_value, 2)}，浮动盈亏 ¥${roundNumber(
              item.unrealized_pnl,
              2
            )}。`,
          ],
          quantity: item.quantity,
          reference_price: item.current_price,
          estimated_amount: item.market_value,
          estimated_pnl: item.unrealized_pnl,
          estimated_pnl_pct: item.unrealized_pnl_pct,
          holding_days: item.holding_days,
          source_signal_id: item.signal_id,
          source_type: item.source_type,
          score: item.score,
          risk_level: item.risk_level,
          tags: ['open_position', item.risk_state].filter(Boolean),
          metadata: item,
        });
      }
    }

    if (entryPreview?.trades?.length) {
      for (const item of entryPreview.trades) {
        actions.push({
          action_type: 'entry',
          priority: toNumber(item.score, 0) >= 85 ? 'high' : 'medium',
          symbol: item.symbol,
          name: item.name,
          action_label: item.action_label || '计划买入',
          reason: `候选评分 ${item.score ?? '--'}，风险等级 ${item.risk_level || '--'}，目标仓位 ${
            item.target_position_pct ?? '--'
          }%`,
          instructions: [
            `计划买入 ${item.quantity} 股，预估成交价 ¥${roundNumber(item.execute_price, 3)}。`,
            `预计占用资金 ¥${roundNumber(item.total_cost, 2)}，止损 ${
              item.stop_loss_pct ?? '--'
            }%，止盈 ${item.take_profit_pct ?? '--'}%。`,
            '若盘中高开过多或流动性不足，降级为观察，不追价。',
          ],
          quantity: item.quantity,
          reference_price: item.execute_price,
          estimated_amount: item.total_cost,
          estimated_cash_change: -toNumber(item.total_cost, 0),
          signal_id: item.signal_id,
          source_type: item.source_type,
          score: item.score,
          risk_level: item.risk_level,
          tags: ['planned_entry', item.action || 'buy'].filter(Boolean),
          metadata: item,
        });
      }
    }

    for (const nextAction of attribution.feedback?.next_actions?.slice(0, 4) || []) {
      actions.push({
        action_type: 'review',
        priority: 'low',
        action_label: '策略复盘',
        reason: nextAction,
        instructions: ['把该建议纳入下一轮自动跟单参数，观察至少 3-5 笔闭环结果。'],
        tags: ['feedback'],
      });
    }

    const outcomePolicy = entryPreview?.outcome_feedback_policy;
    for (const nextAction of outcomePolicy?.next_actions?.slice(0, 4) || []) {
      actions.push({
        action_type: 'review',
        priority: 'medium',
        action_label: '收益闭环反哺',
        reason: nextAction,
        instructions: [
          `下一轮自动跟单将采用最低评分 ${outcomePolicy?.effective_min_score ?? '--'}、仓位倍率 ${
            outcomePolicy?.effective_position_multiplier ?? '--'
          }x。`,
          '优先观察该参数组合是否改善超额胜率，样本不足前不放大仓位。',
        ],
        tags: ['outcome_feedback'],
        metadata: outcomePolicy,
      });
    }

    for (const segment of outcomePolicy?.blocked_segments?.slice(0, 3) || []) {
      actions.push({
        action_type: 'review',
        priority: 'high',
        action_label: '暂停弱势片段',
        reason: `${segment.label || segment.key} 片段平均超额 ${
          segment.avg_excess_return_pct ?? '--'
        }%，样本 ${segment.closed_count ?? 0}，自动跟单已降权/拦截。`,
        instructions: [
          '复盘该片段的入场时点、止损纪律和信号来源质量。',
          '在连续改善前，避免手动绕过自动跟单的降权规则。',
        ],
        tags: ['outcome_feedback', 'blocked_segment'],
        metadata: segment,
      });
    }

    actions.sort((a, b) => {
      const priorityDiff = priorityWeight(b.priority) - priorityWeight(a.priority);
      if (priorityDiff !== 0) return priorityDiff;
      return String(a.symbol || '').localeCompare(String(b.symbol || ''));
    });

    const snapshot = riskCheck?.snapshot || entryPreview?.snapshot;
    const currentCash = toNumber(snapshot?.current_cash, 0);
    const totalValue = toNumber(snapshot?.total_value, attribution.summary.open_exposure || 0);
    const positionValue = toNumber(
      snapshot?.position_value,
      attribution.summary.open_exposure || 0
    );
    const plannedSellCashInflow = roundNumber(
      actions
        .filter(action => action.action_type === 'exit')
        .reduce((sum, action) => sum + Math.max(0, toNumber(action.estimated_cash_change, 0)), 0),
      2
    );
    const plannedBuyCashOutflow = roundNumber(
      Math.abs(
        actions
          .filter(action => action.action_type === 'entry')
          .reduce((sum, action) => sum + Math.min(0, toNumber(action.estimated_cash_change, 0)), 0)
      ),
      2
    );
    const summary = {
      action_count: actions.length,
      urgent_count: actions.filter(action => ['critical', 'high'].includes(action.priority)).length,
      exit_count: actions.filter(action => action.action_type === 'exit').length,
      entry_count: actions.filter(action => action.action_type === 'entry').length,
      monitor_count: actions.filter(action => action.action_type === 'monitor').length,
      review_count: actions.filter(action => action.action_type === 'review').length,
      current_cash: roundNumber(currentCash, 2),
      total_value: roundNumber(totalValue, 2),
      position_value: roundNumber(positionValue, 2),
      planned_sell_cash_inflow: plannedSellCashInflow,
      planned_buy_cash_outflow: plannedBuyCashOutflow,
      projected_cash_after_plan: roundNumber(
        currentCash + plannedSellCashInflow - plannedBuyCashOutflow,
        2
      ),
      recommended_min_score: attribution.feedback?.recommended_min_score,
      effective_min_score: entryPreview?.feedback_policy?.effective_min_score,
      recommended_allowed_risk_levels: attribution.feedback?.recommended_allowed_risk_levels,
      generated_from_closed_samples: attribution.summary.closed_count,
      profit_gate_label: entryPreview?.profit_gate_policy?.gate_label,
      profit_gate_quality_score: entryPreview?.profit_gate_policy?.quality_score,
      profit_gate_position_multiplier:
        entryPreview?.profit_gate_policy?.effective_position_multiplier,
      outcome_feedback_enabled: outcomePolicy?.enabled,
      outcome_closed_samples: outcomePolicy?.closed_samples,
      outcome_min_closed_samples: outcomePolicy?.min_closed_samples,
      outcome_avg_excess_return_pct: outcomePolicy?.avg_excess_return_pct,
      outcome_excess_win_rate: outcomePolicy?.excess_win_rate,
      outcome_recommended_min_score: outcomePolicy?.recommended_min_score,
      outcome_effective_min_score: outcomePolicy?.effective_min_score,
      outcome_position_multiplier: outcomePolicy?.effective_position_multiplier,
      outcome_reason: outcomePolicy?.reason,
      outcome_blocked_segments: outcomePolicy?.blocked_segments,
    };

    const result: PaperTradingPlanResult = {
      portfolio_id: attribution.portfolio_id,
      user_id: attribution.user_id,
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      mode: 'daily_plan',
      summary,
      actions,
      attribution,
      risk_check: riskCheck,
      entry_preview: entryPreview,
    };

    if (reportToFeishu) {
      await feishuTaskReportService.reportPaperTradingPlan(result, {
        record_type: '模拟盘交易计划',
      });
    }

    return result;
  }

  private exitPriority(reason?: string, pnlPct?: number): TradingPlanPriority {
    if (reason === 'stop_loss') return 'critical';
    if (reason === 'sell_signal') return 'high';
    if (reason === 'take_profit') return 'high';
    if (reason === 'trailing_take_profit') return 'high';
    if (toNumber(pnlPct, 0) < -5) return 'high';
    return 'medium';
  }

  private monitorPriority(riskState?: string, pnlPct?: number): TradingPlanPriority {
    if (riskState === 'near_stop_loss') return 'high';
    if (toNumber(pnlPct, 0) <= -5) return 'medium';
    if (riskState === 'approaching_take_profit') return 'medium';
    return 'low';
  }
}

export const paperTradingPlanService = new PaperTradingPlanService();
