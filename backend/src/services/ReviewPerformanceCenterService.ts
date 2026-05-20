import moment from 'moment-timezone';
import { recommendationTradeOutcomeService } from './RecommendationTradeOutcomeService';
import { aiInvestmentSignalService } from './AIInvestmentSignalService';
import { paperTradingRiskProfileService } from './PaperTradingRiskProfileService';
import { logger } from '../utils/logger';

interface ReviewPerformanceCenterOptions {
  user_id: number;
  username?: string;
  horizon?: string;
  lookback_days?: number;
  limit?: number;
}

type PartialResult<T = any> = {
  ok: boolean;
  data: T | null;
  error?: string;
};

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundNumber(value: any, digits = 2): number {
  const parsed = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(parsed * base) / base;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeText(value: any, maxLength = 120): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function asPlain<T = any>(record: any): T {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
}

function sourceLabel(value?: string): string {
  const labels: Record<string, string> = {
    quant_recommendation: '量化候选',
    tradingagents: 'TradingAgents',
    daily_screener: 'AI每日优选',
    manual_analysis: '人工分析',
  };
  return labels[String(value || '')] || value || '未标注';
}

function buildDateRange(lookbackDays: number) {
  const endDate = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
  const startDate = moment(endDate)
    .subtract(Math.max(1, lookbackDays), 'days')
    .format('YYYY-MM-DD');
  return { start_date: startDate, end_date: endDate };
}

class ReviewPerformanceCenterService {
  async getPerformanceCenter(options: ReviewPerformanceCenterOptions) {
    const horizon = options.horizon || '5d';
    const lookbackDays = clamp(toNumber(options.lookback_days, 365), 30, 3650);
    const limit = clamp(toNumber(options.limit, 2000), 100, 10000);
    const dateRange = buildDateRange(lookbackDays);

    const [outcomeResult, performanceResult, qualityResult, agentTailResult, riskResult] =
      await Promise.all([
        this.safeRead('推荐交易收益闭环', () =>
          recommendationTradeOutcomeService.getDashboard({
            user_id: options.user_id,
            username: options.username,
            include_open: true,
            lookback_days: lookbackDays,
            limit,
          })
        ),
        this.safeRead('信号后验绩效', () =>
          aiInvestmentSignalService.getPerformanceDashboard({
            ...dateRange,
            horizon,
            limit,
          })
        ),
        this.safeRead('信号质量日报', () =>
          aiInvestmentSignalService.getSignalQualityReport({
            horizon,
            lookback_days: lookbackDays,
            min_samples: 5,
            limit,
            auto_repair_missing_data: false,
          })
        ),
        this.safeRead('Agent尾盘账本', () =>
          aiInvestmentSignalService.getAgentTailAlphaLedger({
            source_type: 'tradingagents',
            agent_session: 'close',
            horizon,
            lookback_days: lookbackDays,
            min_samples: 5,
            limit,
          })
        ),
        this.safeRead('组合风险画像', () =>
          paperTradingRiskProfileService.getRiskProfile({ user_id: options.user_id })
        ),
      ]);

    const outcomeDashboard = outcomeResult.data;
    const performanceDashboard = performanceResult.data;
    const qualityReport = qualityResult.data;
    const agentTailLedger = agentTailResult.data;
    const riskProfile = riskResult.data;

    const summary = this.buildSummary({
      outcomeDashboard,
      performanceDashboard,
      qualityReport,
      agentTailLedger,
      riskProfile,
    });
    const sourceComparison = this.buildSourceComparison({
      outcomeDashboard,
      performanceDashboard,
      qualityReport,
    });
    const equityCurve = this.buildEquityCurve(outcomeDashboard?.outcomes || []);
    const bestSegments = this.pickBestSegments({ outcomeDashboard, qualityReport, agentTailLedger });
    const weakSegments = this.pickWeakSegments({ outcomeDashboard, qualityReport, agentTailLedger });
    const actionItems = this.buildActionItems({
      outcomeDashboard,
      qualityReport,
      agentTailLedger,
      riskProfile,
      summary,
    });

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      filters: {
        horizon,
        lookback_days: lookbackDays,
        start_date: dateRange.start_date,
        end_date: dateRange.end_date,
        limit,
      },
      health: {
        outcome: this.toHealth(outcomeResult),
        performance: this.toHealth(performanceResult),
        quality: this.toHealth(qualityResult),
        agent_tail: this.toHealth(agentTailResult),
        risk_profile: this.toHealth(riskResult),
      },
      conclusion: this.buildConclusion(summary, riskProfile),
      summary,
      source_comparison: sourceComparison,
      equity_curve: equityCurve,
      best_segments: bestSegments,
      weak_segments: weakSegments,
      action_items: actionItems,
      outcome: {
        summary: outcomeDashboard?.summary || null,
        feedback: outcomeDashboard?.feedback || null,
        groups: outcomeDashboard?.groups
          ? {
              by_source_type: (outcomeDashboard.groups.by_source_type || []).slice(0, 8),
              by_agent_session: (outcomeDashboard.groups.by_agent_session || []).slice(0, 8),
              by_style: (outcomeDashboard.groups.by_style || []).slice(0, 8),
              by_market_regime: (outcomeDashboard.groups.by_market_regime || []).slice(0, 8),
            }
          : null,
        latest_outcomes: (outcomeDashboard?.outcomes || []).slice(0, 12).map((item: any) =>
          asPlain(item)
        ),
      },
      signal_performance: {
        overview: performanceDashboard?.overview || null,
        playbook: performanceDashboard?.playbook || null,
        horizon_summary: performanceDashboard?.horizon_summary || [],
        top_symbols: (performanceDashboard?.top_symbols || []).slice(0, 8),
      },
      signal_quality: {
        overview: qualityReport?.overview || null,
        data_health: qualityReport?.data_health || null,
        best_segments: qualityReport?.best_segments || [],
        worst_segments: qualityReport?.worst_segments || [],
      },
      agent_tail: {
        summary: agentTailLedger?.summary || null,
        horizon_summary: agentTailLedger?.horizon_summary || [],
        best_symbols: agentTailLedger?.best_symbols || [],
        weak_symbols: agentTailLedger?.weak_symbols || [],
        insights: agentTailLedger?.insights || [],
        next_actions: agentTailLedger?.next_actions || [],
      },
      risk_profile: riskProfile,
      links: {
        trades: '/review/trades',
        performance: '/review/performance',
        agent_tail: '/review/agent-tail',
        today: '/today',
        strategy_research: '/strategy-research/optimization',
      },
    };
  }

  private async safeRead<T>(label: string, loader: () => Promise<T>): Promise<PartialResult<T>> {
    try {
      const data = await loader();
      return { ok: true, data };
    } catch (error: any) {
      const message = error?.message || String(error);
      logger.warn(`收益复盘中心读取${label}失败: ${message}`);
      return { ok: false, data: null, error: message };
    }
  }

  private toHealth(result: PartialResult) {
    return result.ok
      ? { ok: true, status: 'ok' }
      : { ok: false, status: 'partial', message: safeText(result.error, 120) };
  }

  private buildSummary(payload: Record<string, any>) {
    const outcomeSummary = payload.outcomeDashboard?.summary || {};
    const performanceOverview = payload.performanceDashboard?.overview || {};
    const qualityOverview = payload.qualityReport?.overview || {};
    const dataHealth = payload.qualityReport?.data_health || {};
    const agentOverall = payload.agentTailLedger?.summary?.overall || {};
    const agentGate = payload.agentTailLedger?.summary?.gate || {};
    const riskStatus = payload.riskProfile?.status || {};
    const riskMetrics = payload.riskProfile?.risk_metrics || {};
    const feedback = payload.outcomeDashboard?.feedback || {};

    return {
      total_pnl: roundNumber(outcomeSummary.total_pnl, 2),
      total_realized_pnl: roundNumber(outcomeSummary.total_realized_pnl, 2),
      total_unrealized_pnl: roundNumber(outcomeSummary.total_unrealized_pnl, 2),
      closed_count: toNumber(outcomeSummary.closed_count, 0),
      open_count: toNumber(outcomeSummary.open_count, 0),
      tracked_count: toNumber(outcomeSummary.total_count, 0),
      win_rate: roundNumber(outcomeSummary.win_rate, 2),
      excess_win_rate: roundNumber(outcomeSummary.excess_win_rate, 2),
      avg_closed_return_pct: roundNumber(outcomeSummary.avg_closed_return_pct, 2),
      avg_excess_return_pct: roundNumber(outcomeSummary.avg_excess_return_pct, 2),
      profit_factor: roundNumber(outcomeSummary.profit_factor, 2),
      recommended_min_score: toNumber(feedback.recommended_min_score, 72),
      position_multiplier: roundNumber(feedback.position_multiplier || 0.75, 2),
      signal_total: toNumber(performanceOverview.total_signals, 0),
      signal_completed_samples: toNumber(performanceOverview.completed_samples, 0),
      signal_avg_return_pct: roundNumber(performanceOverview.avg_return_pct, 2),
      signal_avg_excess_return_pct: roundNumber(performanceOverview.avg_excess_return_pct, 2),
      signal_quality_score: toNumber(qualityOverview.quality_score, 0),
      no_data_signals: toNumber(dataHealth.no_data_signals, 0),
      pending_signals: toNumber(dataHealth.pending_signals, 0),
      agent_tail_samples: toNumber(agentOverall.count, 0),
      agent_tail_quality_score: toNumber(agentOverall.quality_score, 0),
      agent_tail_avg_excess_return_pct: roundNumber(agentOverall.avg_excess_return_pct, 2),
      agent_tail_gate_label: agentGate.label || '',
      risk_level: riskStatus.level || 'safe',
      risk_label: riskStatus.label || '未生成',
      risk_conclusion: riskStatus.conclusion || '',
      exposure_pct: roundNumber(riskMetrics.exposure_pct, 2),
      cash_pct: roundNumber(riskMetrics.cash_pct, 2),
      drawdown_pct: roundNumber(riskMetrics.drawdown_pct, 2),
    };
  }

  private buildConclusion(summary: Record<string, any>, riskProfile: any) {
    const closedCount = toNumber(summary.closed_count, 0);
    const avgExcess = toNumber(summary.avg_excess_return_pct, 0);
    const excessWinRate = toNumber(summary.excess_win_rate, 0);
    const riskLevel = String(riskProfile?.status?.level || summary.risk_level || 'safe');

    if (riskLevel === 'danger') {
      return {
        tone: 'danger',
        headline: '组合风控优先，暂停放大推荐仓位',
        reason: safeText(riskProfile?.status?.conclusion || '风险画像出现异常，需要先处理持仓风险。'),
        next_action: '先处理卖出/减仓与现金水位，再继续观察新推荐。',
      };
    }

    if (closedCount < 5) {
      return {
        tone: 'wait',
        headline: `闭环样本 ${closedCount}/5，继续小仓采样`,
        reason: '当前收益统计还不足以证明策略稳定有效，避免过早放大。',
        next_action: '保持自动模拟盘运行，优先补齐后验样本和行情数据。',
      };
    }

    if (avgExcess >= 1 && excessWinRate >= 52) {
      return {
        tone: 'good',
        headline: '推荐闭环阶段性跑赢基准，可小幅放大优胜片段',
        reason: `已闭环 ${closedCount} 笔，平均超额 ${avgExcess.toFixed(
          2
        )}%，超额胜率 ${excessWinRate.toFixed(2)}%。`,
        next_action: '仅放大高评分、低风险、策略共识强的片段，弱片段继续降权。',
      };
    }

    if (avgExcess < -1 || excessWinRate < 45) {
      return {
        tone: 'reduce',
        headline: '推荐闭环暂未跑赢基准，下一轮应降仓和提高门槛',
        reason: `平均超额 ${avgExcess.toFixed(2)}%，超额胜率 ${excessWinRate.toFixed(2)}%。`,
        next_action: '提高最低评分、收紧止损，并复盘亏损来源。',
      };
    }

    return {
      tone: 'watch',
      headline: '推荐闭环进入观察区，保持当前试验强度',
      reason: `样本 ${closedCount} 笔，优势不够显著但未触发降权。`,
      next_action: '继续沉淀样本，优先比较量化、Agent 与融合来源差异。',
    };
  }

  private buildSourceComparison(payload: Record<string, any>) {
    const outcomeGroups = payload.outcomeDashboard?.groups?.by_source_type || [];
    const performanceGroups = payload.performanceDashboard?.by_source_type || [];
    const qualityGroups = payload.qualityReport?.rankings?.by_source_type || [];
    const keys = new Set<string>();
    outcomeGroups.forEach((item: any) => keys.add(String(item.key || 'unknown')));
    performanceGroups.forEach((item: any) => keys.add(String(item.key || 'unknown')));
    qualityGroups.forEach((item: any) => keys.add(String(item.key || 'unknown')));

    return [...keys]
      .map(key => {
        const outcome = outcomeGroups.find((item: any) => String(item.key) === key) || {};
        const performance = performanceGroups.find((item: any) => String(item.key) === key) || {};
        const quality = qualityGroups.find((item: any) => String(item.key) === key) || {};
        const score =
          toNumber(outcome.closed_count, 0) * 2 +
          toNumber(outcome.avg_excess_return_pct, 0) * 6 +
          toNumber(quality.quality_score, 0) * 0.35 +
          toNumber(performance.avg_return_pct, 0) * 2;
        return {
          key,
          label: sourceLabel(key),
          tracked_count: toNumber(outcome.count, 0),
          closed_count: toNumber(outcome.closed_count, 0),
          total_pnl: roundNumber(outcome.total_pnl, 2),
          avg_excess_return_pct: roundNumber(outcome.avg_excess_return_pct, 2),
          excess_win_rate: roundNumber(outcome.excess_win_rate, 2),
          signal_count: toNumber(performance.count, 0),
          signal_avg_return_pct: roundNumber(performance.avg_return_pct, 2),
          quality_score: toNumber(quality.quality_score, 0),
          gate_label: quality.gate?.label || '',
          composite_score: roundNumber(score, 2),
        };
      })
      .sort((a, b) => b.composite_score - a.composite_score);
  }

  private buildEquityCurve(outcomes: any[]) {
    const sorted = outcomes
      .map(item => asPlain<any>(item))
      .sort((a, b) =>
        String(a.exit_date || a.entry_date || a.signal_date || '').localeCompare(
          String(b.exit_date || b.entry_date || b.signal_date || '')
        )
      );
    let cumulativePnl = 0;
    let peakPnl = 0;
    return sorted.map(item => {
      const pnl = toNumber(item.total_pnl, 0);
      cumulativePnl += pnl;
      peakPnl = Math.max(peakPnl, cumulativePnl);
      return {
        date: item.exit_date || item.entry_date || item.signal_date,
        symbol: item.symbol,
        name: item.name,
        pnl: roundNumber(pnl, 2),
        cumulative_pnl: roundNumber(cumulativePnl, 2),
        drawdown_pnl: roundNumber(cumulativePnl - peakPnl, 2),
      };
    });
  }

  private normalizeSegment(item: any, dimensionFallback: string) {
    if (!item) return null;
    return {
      key: item.key,
      label: item.label || item.key || '未标注',
      dimension: item.dimension || dimensionFallback,
      count: toNumber(item.closed_count ?? item.count, 0),
      open_count: toNumber(item.open_count, 0),
      avg_return_pct: roundNumber(item.avg_return_pct ?? item.avg_closed_return_pct, 2),
      avg_excess_return_pct: roundNumber(item.avg_excess_return_pct, 2),
      win_rate: roundNumber(item.win_rate ?? item.positive_rate, 2),
      excess_win_rate: roundNumber(item.excess_win_rate ?? item.excess_positive_rate, 2),
      total_pnl: roundNumber(item.total_pnl, 2),
      quality_score: toNumber(item.quality_score ?? item.robust_score, 0),
      gate_label: item.gate?.label || item.budget_action || item.action || '',
      reason: safeText(item.gate?.reason || item.budget_action_reason || item.reason, 120),
    };
  }

  private pickBestSegments(payload: Record<string, any>) {
    const items = [
      ...(payload.outcomeDashboard?.feedback?.best_segments || []).map((item: any) =>
        this.normalizeSegment(item, '交易闭环')
      ),
      ...(payload.qualityReport?.best_segments || []).map((item: any) =>
        this.normalizeSegment(item, '信号质量')
      ),
      ...(payload.agentTailLedger?.best_symbols || []).map((item: any) =>
        this.normalizeSegment(item, 'Agent尾盘')
      ),
    ].filter(Boolean);

    return items
      .sort(
        (a: any, b: any) =>
          toNumber(b.quality_score, 0) - toNumber(a.quality_score, 0) ||
          toNumber(b.avg_excess_return_pct, 0) - toNumber(a.avg_excess_return_pct, 0)
      )
      .slice(0, 8);
  }

  private pickWeakSegments(payload: Record<string, any>) {
    const items = [
      ...(payload.outcomeDashboard?.feedback?.weak_segments || []).map((item: any) =>
        this.normalizeSegment(item, '交易闭环')
      ),
      ...(payload.qualityReport?.worst_segments || []).map((item: any) =>
        this.normalizeSegment(item, '信号质量')
      ),
      ...(payload.agentTailLedger?.weak_symbols || []).map((item: any) =>
        this.normalizeSegment(item, 'Agent尾盘')
      ),
    ].filter(Boolean);

    return items
      .sort(
        (a: any, b: any) =>
          toNumber(a.avg_excess_return_pct, 0) - toNumber(b.avg_excess_return_pct, 0) ||
          toNumber(a.quality_score, 0) - toNumber(b.quality_score, 0)
      )
      .slice(0, 8);
  }

  private buildActionItems(payload: Record<string, any>) {
    const items = [
      ...(payload.outcomeDashboard?.feedback?.next_actions || []),
      ...(payload.qualityReport?.action_items || []),
      ...(payload.agentTailLedger?.next_actions || []),
      ...(payload.riskProfile?.next_actions || []),
    ]
      .map(item => safeText(item, 120))
      .filter(Boolean);

    const unique = [...new Set(items)].slice(0, 8);
    if (unique.length > 0) return unique;
    if (payload.summary.closed_count < 5) {
      return ['继续让自动模拟盘沉淀至少 5 笔闭环样本，再决定是否放大仓位。'];
    }
    return ['保持当前自动荐股和风控任务运行，等待下一轮收益样本更新。'];
  }
}

export const reviewPerformanceCenterService = new ReviewPerformanceCenterService();
