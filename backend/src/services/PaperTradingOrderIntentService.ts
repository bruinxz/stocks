import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { PaperTradingOrderIntent } from '../models/PaperTradingOrderIntent';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { User } from '../models/User';
import { AIInvestmentSignal } from '../models/AIInvestmentSignal';

export interface PaperTradingOrderIntentDashboardOptions {
  user_id?: number;
  username?: string;
  portfolio_id?: number;
  portfolio_name?: string;
  initial_capital?: number;
  force_new_portfolio?: boolean;
  lookback_days?: number;
  limit?: number;
  side?: string;
  status?: string;
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

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function modelToPlain<T = any>(record: any): T {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
}

function reasonCategoryLabel(category?: string): string {
  const labels: Record<string, string> = {
    executed: '已成交',
    planned: '预演计划',
    risk_hold: '继续持有',
    execution_reality: '真实成交约束',
    duplicate_or_existing_position: '重复/已持有',
    profit_gate: '收益闸门',
    outcome_feedback: '收益闭环反哺',
    market_environment_guard: '市场环境风控',
    entry_risk_guard: '入场风控',
    risk_level: '风险等级',
    trade_discipline: '交易纪律',
    capital_or_lot_size: '资金/一手限制',
    market_data: '行情/数据质量',
    position_limit: '持仓上限',
    stale_signal: '旧信号',
    other: '其它',
    unknown: '未知',
  };
  return labels[String(category || '')] || category || '未知';
}

function statusLabel(status?: string): string {
  const labels: Record<string, string> = {
    planned: '预演计划',
    executed: '已模拟成交',
    rejected: '未放行',
    skipped: '已跳过',
    held: '继续持有',
  };
  return labels[String(status || '')] || status || '未知';
}

function sideLabel(side?: string): string {
  return String(side || '').toUpperCase() === 'SELL' ? '卖出' : '买入';
}

const HINDSIGHT_HORIZONS = [1, 3, 5, 10];
const RULE_SUGGESTION_WINDOWS = [7, 14, 30];

function dateOnly(value: any): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return moment(date).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

export class PaperTradingOrderIntentService {
  async getIntentDashboard(options: PaperTradingOrderIntentDashboardOptions = {}) {
    const portfolio = await this.resolvePortfolio(options);
    const lookbackDays = toPositiveInt(options.lookback_days, 30, 3650);
    const limit = toPositiveInt(options.limit, 80, 500);
    const startDate = moment()
      .tz('Asia/Shanghai')
      .subtract(lookbackDays, 'days')
      .format('YYYY-MM-DD');

    if (!portfolio) {
      return {
        generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
        portfolio: null,
        filters: {
          lookback_days: lookbackDays,
          start_date: startDate,
          limit,
          side: options.side || 'all',
          status: options.status || 'all',
        },
        summary: {
          total: 0,
          executed_count: 0,
          rejected_count: 0,
          skipped_count: 0,
          planned_count: 0,
          held_count: 0,
          buy_count: 0,
          sell_count: 0,
          buy_rejected_count: 0,
          sell_rejected_count: 0,
          execution_reality_reject_count: 0,
          intended_amount: 0,
          executed_amount: 0,
          execution_rate: 0,
          top_reason_categories: [],
          conclusion: '目标模拟盘尚未创建或没有订单意图，等待自动荐股/风控任务运行后沉淀。',
        },
        intents: [],
        recent_rejections: [],
      };
    }

    const where: any = {
      portfolio_id: portfolio.id,
      intent_date: { [Op.gte]: startDate },
    };
    if (options.side && options.side !== 'all') where.side = String(options.side).toUpperCase();
    if (options.status && options.status !== 'all') where.status = options.status;

    const [records, allRecords] = await Promise.all([
      PaperTradingOrderIntent.findAll({
        where,
        order: [
          ['intent_date', 'DESC'],
          ['created_at', 'DESC'],
        ],
        limit,
      }),
      PaperTradingOrderIntent.findAll({
        where,
        order: [['created_at', 'DESC']],
        limit: 5000,
      }),
    ]);

    const plain = allRecords.map(item => modelToPlain<any>(item));
    const hindsight = await this.buildHindsight(plain);
    const visible = records.map(item =>
      this.normalizeIntent(modelToPlain<any>(item), hindsight.by_intent_id.get(Number(item.id)))
    );
    const statusCounts = this.countBy(plain, 'status');
    const sideCounts = this.countBy(plain, 'side');
    const reasonCounts = this.countBy(plain, 'reason_category');
    const rejectedLike = plain.filter(item => ['rejected', 'skipped'].includes(item.status));
    const executed = plain.filter(item => item.status === 'executed');
    const buyRejected = rejectedLike.filter(item => item.side === 'BUY');
    const sellRejected = rejectedLike.filter(item => item.side === 'SELL');
    const executionRealityReject = rejectedLike.filter(
      item => item.reason_category === 'execution_reality'
    );
    const intendedAmount = plain.reduce((sum, item) => sum + toNumber(item.amount, 0), 0);
    const executedAmount = executed.reduce((sum, item) => sum + toNumber(item.amount, 0), 0);

    const topReasonCategories = Object.entries(reasonCounts)
      .map(([key, count]) => ({
        key,
        label: reasonCategoryLabel(key),
        count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      portfolio: modelToPlain(portfolio),
      filters: {
        lookback_days: lookbackDays,
        start_date: startDate,
        limit,
        side: options.side || 'all',
        status: options.status || 'all',
      },
      summary: {
        total: plain.length,
        executed_count: statusCounts.executed || 0,
        rejected_count: statusCounts.rejected || 0,
        skipped_count: statusCounts.skipped || 0,
        planned_count: statusCounts.planned || 0,
        held_count: statusCounts.held || 0,
        buy_count: sideCounts.BUY || 0,
        sell_count: sideCounts.SELL || 0,
        buy_rejected_count: buyRejected.length,
        sell_rejected_count: sellRejected.length,
        execution_reality_reject_count: executionRealityReject.length,
        intended_amount: roundNumber(intendedAmount, 2),
        executed_amount: roundNumber(executedAmount, 2),
        execution_rate:
          plain.length > 0
            ? roundNumber(((statusCounts.executed || 0) / plain.length) * 100, 2)
            : 0,
        top_reason_categories: topReasonCategories,
        hindsight: hindsight.summary,
        conclusion: this.buildConclusion({
          total: plain.length,
          executed: statusCounts.executed || 0,
          rejected: rejectedLike.length,
          held: statusCounts.held || 0,
          topReasonCategories,
        }),
      },
      intents: visible,
      recent_rejections: visible
        .filter(item => ['rejected', 'skipped'].includes(item.status))
        .slice(0, 10),
    };
  }

  async getIntentTrace(id: number, options: PaperTradingOrderIntentDashboardOptions = {}) {
    const portfolio = await this.resolvePortfolio(options);
    if (!portfolio) throw new Error('目标模拟盘尚未创建或无权访问');

    const record = await PaperTradingOrderIntent.findOne({
      where: { id, portfolio_id: portfolio.id },
    });
    if (!record) return null;

    const item = modelToPlain<any>(record);
    const [hindsight, signal, peerRecords] = await Promise.all([
      this.buildHindsight([item]),
      item.signal_id
        ? AIInvestmentSignal.findByPk(item.signal_id, { raw: true }).catch(() => null)
        : null,
      PaperTradingOrderIntent.findAll({
        where: {
          portfolio_id: portfolio.id,
          reason_category: item.reason_category || 'unknown',
          status: { [Op.in]: ['rejected', 'skipped', 'held'] },
          intent_date: {
            [Op.gte]: moment()
              .tz('Asia/Shanghai')
              .subtract(toPositiveInt(options.lookback_days, 30, 3650), 'days')
              .format('YYYY-MM-DD'),
          },
        },
        order: [
          ['intent_date', 'DESC'],
          ['created_at', 'DESC'],
        ],
        limit: 300,
      }),
    ]);

    const peerPlain = peerRecords.map(peer => modelToPlain<any>(peer));
    const peerHindsight = await this.buildHindsight(peerPlain);
    const opportunityOutcome = hindsight.by_intent_id.get(Number(item.id));
    const normalizedIntent = this.normalizeIntent(item, opportunityOutcome);
    const peerSuggestion = (peerHindsight.summary.rule_suggestions || []).find(
      (suggestion: any) => suggestion.key === (item.reason_category || 'unknown')
    );
    const stableSuggestion = (peerHindsight.summary.stable_rule_suggestions || []).find(
      (suggestion: any) => suggestion.key === (item.reason_category || 'unknown')
    );
    const parameterImpact = (peerHindsight.summary.parameter_adjustment_preview || []).filter(
      (preview: any) => preview.reason_category === (item.reason_category || 'unknown')
    );

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      portfolio: modelToPlain(portfolio),
      intent: normalizedIntent,
      signal: signal ? this.normalizeSignal(signal) : null,
      opportunity_outcome: opportunityOutcome,
      peer_review: {
        reason_category: item.reason_category || 'unknown',
        reason_category_label: reasonCategoryLabel(item.reason_category),
        sample_count: peerPlain.length,
        hindsight: peerHindsight.summary,
        matching_rule_suggestion: peerSuggestion || null,
        stable_rule_suggestion: stableSuggestion || null,
        parameter_impact: parameterImpact,
      },
      timeline: this.buildIntentTraceTimeline(normalizedIntent, signal, opportunityOutcome),
      conclusion: this.buildIntentTraceConclusion(
        normalizedIntent,
        opportunityOutcome,
        stableSuggestion,
        parameterImpact
      ),
    };
  }

  private normalizeIntent(item: any, opportunityOutcome?: any) {
    const metadata = item.metadata || {};
    const executionReality = metadata.execution_reality_decision || {};
    return {
      ...item,
      reference_price: item.reference_price === null ? null : toNumber(item.reference_price),
      execute_price: item.execute_price === null ? null : toNumber(item.execute_price),
      quantity: item.quantity === null ? null : toNumber(item.quantity),
      amount: item.amount === null ? null : toNumber(item.amount),
      target_position_pct:
        item.target_position_pct === null ? null : toNumber(item.target_position_pct),
      score: item.score === null ? null : toNumber(item.score),
      side_label: sideLabel(item.side),
      status_label: statusLabel(item.status),
      reason_category_label: reasonCategoryLabel(item.reason_category),
      execution_reality: executionReality,
      opportunity_outcome: opportunityOutcome,
      compact_reason:
        item.reason_text ||
        executionReality.label ||
        (Array.isArray(executionReality.reasons) ? executionReality.reasons.join('；') : ''),
    };
  }

  private normalizeSignal(signal: any) {
    return {
      id: signal.id,
      source_type: signal.source_type,
      source_id: signal.source_id,
      loop_run_id: signal.loop_run_id,
      symbol: signal.symbol,
      name: signal.name,
      signal_date: signal.signal_date,
      decision: signal.decision,
      normalized_decision: signal.normalized_decision,
      confidence_score:
        signal.confidence_score === null || signal.confidence_score === undefined
          ? null
          : toNumber(signal.confidence_score),
      risk_level: signal.risk_level,
      rationale: signal.rationale,
      current_price:
        signal.current_price === null || signal.current_price === undefined
          ? null
          : toNumber(signal.current_price),
      price_change_pct:
        signal.price_change_pct === null || signal.price_change_pct === undefined
          ? null
          : toNumber(signal.price_change_pct),
      verification_status: signal.verification_status,
      forward_returns: signal.forward_returns || {},
      metadata: signal.metadata || {},
    };
  }

  private buildIntentTraceTimeline(intent: any, signal: any, outcome: any) {
    const timeline: any[] = [
      {
        stage: 'signal',
        label: '信号产生',
        time: signal?.signal_date || intent.intent_date,
        status: signal ? 'completed' : 'missing',
        summary: signal
          ? `${signal.source_type} 信号评分 ${toNumber(
              signal.confidence_score,
              intent.score || 0
            )}，决策 ${signal.normalized_decision || signal.decision || '--'}。`
          : '没有关联信号，可能来自风控持仓检查或手动流程。',
      },
      {
        stage: 'intent',
        label: '形成买卖意图',
        time: intent.intent_date,
        status: intent.status,
        summary: `${intent.side_label || intent.side} · ${
          intent.status_label || intent.status
        }，原因：${intent.compact_reason || intent.reason_category_label || '暂无说明'}`,
      },
    ];

    const horizons = outcome?.horizons || {};
    for (const horizon of HINDSIGHT_HORIZONS) {
      const item = horizons[`${horizon}d`];
      if (!item) continue;
      timeline.push({
        stage: `hindsight_${horizon}d`,
        label: `${horizon}日后验`,
        time: item.target_date,
        status: item.intended_action_return_pct > 0.5 ? 'false_reject' : 'protected_or_neutral',
        summary: item.conclusion,
        metric: {
          intended_action_return_pct: item.intended_action_return_pct,
          raw_future_return_pct: item.raw_future_return_pct,
          target_price: item.target_price,
          base_price: item.base_price,
        },
      });
    }
    return timeline;
  }

  private buildIntentTraceConclusion(
    intent: any,
    outcome: any,
    stableSuggestion: any,
    parameterImpact: any[]
  ) {
    const benchmark =
      outcome?.horizons?.['5d'] || this.firstAvailableHorizon(outcome?.horizons || {});
    if (!benchmark) {
      return `${intent.name || intent.symbol} 的拒单/跳过仍缺少后续K线，暂不能判断是否错杀。`;
    }
    const actionResult =
      toNumber(benchmark.intended_action_return_pct) > 0.5
        ? '这笔更像可能错杀'
        : toNumber(benchmark.intended_action_return_pct) < -0.5
        ? '这笔拦截较有效'
        : '这笔影响有限';
    const tuning =
      stableSuggestion?.eligible_for_auto_tune && parameterImpact.length > 0
        ? `同类规则已进入调参候选，影响 ${parameterImpact.length} 个参数。`
        : '同类规则暂未达到自动调参候选标准。';
    return `${actionResult}：${benchmark.conclusion}。${tuning}`;
  }

  private async buildHindsight(items: any[]) {
    const eligible = items
      .filter(item => {
        const status = String(item.status || '');
        const side = String(item.side || '').toUpperCase();
        return ['rejected', 'skipped'].includes(status) || (status === 'held' && side === 'SELL');
      })
      .slice(0, 500);

    if (eligible.length === 0) {
      return {
        by_intent_id: new Map<number, any>(),
        summary: this.emptyHindsightSummary('暂无可做后验复盘的拒单/跳过/持有观察样本。'),
      };
    }

    const symbols = [...new Set(eligible.map(item => String(item.symbol || '')).filter(Boolean))];
    const stocks = await Stock.findAll({
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    });
    const stockBySymbol = new Map(stocks.map((stock: any) => [stock.symbol, stock]));
    const stockIds = stocks.map((stock: any) => stock.id).filter(Boolean);
    const minIntentDate =
      eligible
        .map(item => String(item.intent_date || '').slice(0, 10))
        .filter(Boolean)
        .sort()[0] || moment().tz('Asia/Shanghai').format('YYYY-MM-DD');

    const bars = stockIds.length
      ? await DailyBar.findAll({
          where: {
            stock_id: { [Op.in]: stockIds },
            time: {
              [Op.gte]: moment(minIntentDate).tz('Asia/Shanghai').subtract(3, 'days').toDate(),
            },
          },
          order: [
            ['stock_id', 'ASC'],
            ['time', 'ASC'],
          ],
          raw: true,
        })
      : [];

    const barsByStockId = new Map<number, any[]>();
    for (const bar of bars as any[]) {
      const stockId = Number(bar.stock_id);
      const list = barsByStockId.get(stockId) || [];
      list.push(bar);
      barsByStockId.set(stockId, list);
    }

    const byIntentId = new Map<number, any>();
    for (const item of eligible) {
      const stock = stockBySymbol.get(item.symbol);
      const stockBars = stock ? barsByStockId.get(Number((stock as any).id)) || [] : [];
      const outcome = this.evaluateIntentHindsight(item, stockBars);
      byIntentId.set(Number(item.id), outcome);
    }

    const completed = Array.from(byIntentId.values()).filter(
      item => item?.evaluation_status === 'completed'
    );
    const benchmarkHorizon = '5d';
    const benchmark = completed
      .map(item => ({
        ...item,
        benchmark: item.horizons?.[benchmarkHorizon] || this.firstAvailableHorizon(item.horizons),
      }))
      .filter(item => item.benchmark);
    const falseRejects = benchmark.filter(
      item => toNumber(item.benchmark.intended_action_return_pct) > 0.5
    );
    const correctRejects = benchmark.filter(
      item => toNumber(item.benchmark.intended_action_return_pct) <= 0.5
    );
    const savedLoss = benchmark.filter(
      item => toNumber(item.benchmark.intended_action_return_pct) < -0.5
    );
    const avg =
      benchmark.length > 0
        ? roundNumber(
            benchmark.reduce(
              (sum, item) => sum + toNumber(item.benchmark.intended_action_return_pct),
              0
            ) / benchmark.length,
            4
          )
        : 0;
    const ruleSuggestions = this.buildRuleSuggestions(benchmark);
    const windowReview = this.buildRuleSuggestionWindows(benchmark, ruleSuggestions);
    const stableRuleSuggestions = this.buildStableRuleSuggestions(
      ruleSuggestions,
      windowReview.windows
    );
    const parameterAdjustmentPreview = this.buildParameterAdjustmentPreview(stableRuleSuggestions);

    return {
      by_intent_id: byIntentId,
      summary: {
        evaluated_count: completed.length,
        pending_count: eligible.length - completed.length,
        benchmark_horizon: benchmarkHorizon,
        benchmark_count: benchmark.length,
        false_reject_count: falseRejects.length,
        correct_reject_count: correctRejects.length,
        saved_loss_count: savedLoss.length,
        avg_intended_action_return_pct: avg,
        rule_suggestions: ruleSuggestions,
        rule_suggestion_windows: windowReview.windows,
        stable_rule_suggestions: stableRuleSuggestions,
        parameter_adjustment_preview: parameterAdjustmentPreview,
        tuning_preview_conclusion: this.buildTuningPreviewConclusion(
          stableRuleSuggestions,
          parameterAdjustmentPreview
        ),
        top_false_rejections: falseRejects
          .sort(
            (a, b) =>
              toNumber(b.benchmark.intended_action_return_pct) -
              toNumber(a.benchmark.intended_action_return_pct)
          )
          .slice(0, 5)
          .map(item => ({
            id: item.intent_id,
            symbol: item.symbol,
            name: item.name,
            side: item.side,
            side_label: sideLabel(item.side),
            status: item.status,
            reason_category_label: reasonCategoryLabel(item.reason_category),
            intended_action_return_pct: item.benchmark.intended_action_return_pct,
            raw_future_return_pct: item.benchmark.raw_future_return_pct,
            horizon: item.benchmark.horizon,
            conclusion: item.benchmark.conclusion,
          })),
        conclusion:
          benchmark.length > 0
            ? `后验复盘 ${benchmark.length} 条可评估意图，可能错杀 ${falseRejects.length} 条，规则有效/影响不大 ${correctRejects.length} 条，平均执行意图相对收益 ${avg}%。`
            : '拒单样本仍缺少足够后续K线，暂不能判断是否错杀。',
      },
    };
  }

  private emptyHindsightSummary(conclusion: string) {
    return {
      evaluated_count: 0,
      pending_count: 0,
      benchmark_horizon: '5d',
      benchmark_count: 0,
      false_reject_count: 0,
      correct_reject_count: 0,
      saved_loss_count: 0,
      avg_intended_action_return_pct: 0,
      top_false_rejections: [],
      rule_suggestions: [],
      rule_suggestion_windows: [],
      stable_rule_suggestions: [],
      parameter_adjustment_preview: [],
      tuning_preview_conclusion: '暂无稳定窗口样本，暂不生成自动调参预览。',
      conclusion,
    };
  }

  private buildRuleSuggestions(items: any[]) {
    const buckets = new Map<string, any[]>();
    for (const item of items) {
      const key = String(item.reason_category || 'unknown');
      const list = buckets.get(key) || [];
      list.push(item);
      buckets.set(key, list);
    }

    return Array.from(buckets.entries())
      .map(([key, list]) => {
        const returns = list.map(item => toNumber(item.benchmark?.intended_action_return_pct, 0));
        const falseRejectCount = returns.filter(value => value > 0.5).length;
        const savedLossCount = returns.filter(value => value < -0.5).length;
        const avg =
          returns.length > 0
            ? roundNumber(returns.reduce((sum, value) => sum + value, 0) / returns.length, 4)
            : 0;
        const falseRejectRate =
          returns.length > 0 ? roundNumber((falseRejectCount / returns.length) * 100, 2) : 0;
        const savedLossRate =
          returns.length > 0 ? roundNumber((savedLossCount / returns.length) * 100, 2) : 0;
        const sampleConfidence = Math.min(1, returns.length / 12);
        const action =
          returns.length < 3
            ? 'observe'
            : falseRejectRate >= 45 && avg > 0.8
            ? 'loosen'
            : savedLossRate >= 45 && avg < -0.5
            ? 'tighten'
            : 'keep';
        const label =
          action === 'loosen'
            ? '建议放松'
            : action === 'tighten'
            ? '建议收紧'
            : action === 'keep'
            ? '维持规则'
            : '继续观察';
        const reason =
          action === 'loosen'
            ? `该类规则可能过严，${falseRejectRate}% 样本后验显示执行更优，平均相对 ${avg}%`
            : action === 'tighten'
            ? `该类拦截较有效，${savedLossRate}% 样本避免不利结果，平均相对 ${avg}%`
            : action === 'keep'
            ? `样本表现中性，平均相对 ${avg}%`
            : `样本 ${returns.length} 条不足，先继续观察`;
        return {
          key,
          label: reasonCategoryLabel(key),
          action,
          action_label: label,
          sample_count: returns.length,
          false_reject_count: falseRejectCount,
          false_reject_rate: falseRejectRate,
          saved_loss_count: savedLossCount,
          saved_loss_rate: savedLossRate,
          avg_intended_action_return_pct: avg,
          sample_confidence: roundNumber(sampleConfidence, 2),
          reason,
        };
      })
      .sort((a, b) => {
        const priority: Record<string, number> = { loosen: 3, tighten: 2, keep: 1, observe: 0 };
        return (
          (priority[b.action] || 0) - (priority[a.action] || 0) ||
          Math.abs(b.avg_intended_action_return_pct) - Math.abs(a.avg_intended_action_return_pct)
        );
      })
      .slice(0, 8);
  }

  private buildRuleSuggestionWindows(items: any[], baselineSuggestions: any[]) {
    const now = moment().tz('Asia/Shanghai');
    const baselineByKey = new Map(baselineSuggestions.map(item => [item.key, item]));

    const windows = RULE_SUGGESTION_WINDOWS.map(days => {
      const startDate = now.clone().subtract(days, 'days').format('YYYY-MM-DD');
      const windowItems = items.filter(item => {
        const intentDate = String(item.intent_date || '').slice(0, 10);
        return intentDate && intentDate >= startDate;
      });
      const suggestions = this.buildRuleSuggestions(windowItems).map(suggestion => ({
        ...suggestion,
        window_days: days,
        window_label: `${days}日`,
        baseline_action: baselineByKey.get(suggestion.key)?.action || 'observe',
      }));
      return {
        window_days: days,
        window_label: `${days}日`,
        start_date: startDate,
        sample_count: windowItems.length,
        suggestions,
      };
    });

    return { windows };
  }

  private buildStableRuleSuggestions(ruleSuggestions: any[], windows: any[]) {
    return ruleSuggestions
      .map(suggestion => {
        const windowEvidence = windows
          .map(window => {
            const matched = (window.suggestions || []).find(
              (item: any) => item.key === suggestion.key
            );
            return matched
              ? {
                  window_days: window.window_days,
                  window_label: window.window_label,
                  sample_count: matched.sample_count,
                  action: matched.action,
                  action_label: matched.action_label,
                  avg_intended_action_return_pct: matched.avg_intended_action_return_pct,
                  false_reject_rate: matched.false_reject_rate,
                  saved_loss_rate: matched.saved_loss_rate,
                  sample_confidence: matched.sample_confidence,
                }
              : {
                  window_days: window.window_days,
                  window_label: window.window_label,
                  sample_count: 0,
                  action: 'observe',
                  action_label: '继续观察',
                  avg_intended_action_return_pct: 0,
                  false_reject_rate: 0,
                  saved_loss_rate: 0,
                  sample_confidence: 0,
                };
          })
          .sort((a, b) => a.window_days - b.window_days);

        const sameDirectionWindows = windowEvidence.filter(
          evidence =>
            evidence.action === suggestion.action &&
            ['loosen', 'tighten'].includes(evidence.action) &&
            evidence.sample_count >= 3
        );
        const evidenceSampleCount = windowEvidence.reduce(
          (sum, evidence) => sum + toNumber(evidence.sample_count, 0),
          0
        );
        const eligibleForAutoTune =
          ['loosen', 'tighten'].includes(suggestion.action) &&
          suggestion.sample_count >= 5 &&
          sameDirectionWindows.length >= 2;
        const stabilityScore = roundNumber(
          Math.min(
            100,
            sameDirectionWindows.length * 34 +
              Math.min(30, suggestion.sample_count * 2) +
              Math.min(20, Math.abs(toNumber(suggestion.avg_intended_action_return_pct, 0)) * 4)
          ),
          2
        );

        return {
          ...suggestion,
          stability_state: eligibleForAutoTune
            ? 'stable'
            : sameDirectionWindows.length > 0
            ? 'forming'
            : 'unstable',
          stability_label: eligibleForAutoTune
            ? '可进入调参候选'
            : sameDirectionWindows.length > 0
            ? '证据形成中'
            : '暂不稳定',
          eligible_for_auto_tune: eligibleForAutoTune,
          agreed_window_count: sameDirectionWindows.length,
          evidence_sample_count: evidenceSampleCount,
          stability_score: stabilityScore,
          evidence_windows: windowEvidence,
          next_review_rule: eligibleForAutoTune
            ? '进入下一步人工/审计确认，默认仍不自动应用。'
            : '继续等待至少两个滚动窗口给出同向建议。',
        };
      })
      .filter(
        suggestion =>
          ['loosen', 'tighten'].includes(suggestion.action) ||
          suggestion.stability_state !== 'unstable'
      )
      .sort((a, b) => {
        if (Number(b.eligible_for_auto_tune) !== Number(a.eligible_for_auto_tune)) {
          return Number(b.eligible_for_auto_tune) - Number(a.eligible_for_auto_tune);
        }
        return b.stability_score - a.stability_score;
      })
      .slice(0, 8);
  }

  private buildParameterAdjustmentPreview(stableSuggestions: any[]) {
    const previews: any[] = [];
    for (const suggestion of stableSuggestions) {
      if (!suggestion.eligible_for_auto_tune) continue;
      const candidates = this.parameterCandidatesForSuggestion(suggestion);
      previews.push(...candidates);
    }

    const seen = new Set<string>();
    return previews
      .filter(item => {
        const key = `${item.reason_category}:${item.parameter_key}:${item.action}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);
  }

  private parameterCandidatesForSuggestion(suggestion: any) {
    const action = suggestion.action;
    const key = suggestion.key;
    const directionLabel = action === 'loosen' ? '放松' : '收紧';
    const base = {
      reason_category: key,
      reason_category_label: suggestion.label,
      action,
      action_label: suggestion.action_label,
      confidence: suggestion.stability_score,
      sample_count: suggestion.sample_count,
      evidence: {
        false_reject_rate: suggestion.false_reject_rate,
        saved_loss_rate: suggestion.saved_loss_rate,
        avg_intended_action_return_pct: suggestion.avg_intended_action_return_pct,
        agreed_window_count: suggestion.agreed_window_count,
      },
      apply_status: 'preview_only',
      apply_status_label: '仅预览，未应用',
    };

    const make = (
      parameterKey: string,
      parameterLabel: string,
      currentValue: any,
      previewValue: any,
      unit: string,
      rationale: string
    ) => ({
      ...base,
      parameter_key: parameterKey,
      parameter_label: parameterLabel,
      current_value: currentValue,
      preview_value: previewValue,
      unit,
      change_label: `${directionLabel}：${currentValue}${unit} → ${previewValue}${unit}`,
      rationale,
    });

    switch (key) {
      case 'execution_reality':
      case 'market_data':
        return [
          make(
            'min_avg_turnover_yuan',
            '最低日均成交额',
            30000000,
            action === 'loosen' ? 24000000 : 36000000,
            '元',
            action === 'loosen'
              ? '真实成交约束若持续错杀，可先小幅降低流动性门槛，仍保留停牌/涨跌停硬拦截。'
              : '真实成交约束若持续有效，应提高流动性门槛，减少低成交额标的误入模拟盘。'
          ),
        ];
      case 'entry_risk_guard':
      case 'market_environment_guard':
      case 'position_limit':
        return [
          make(
            'max_daily_new_positions',
            '单日新增持仓上限',
            3,
            action === 'loosen' ? 4 : 2,
            '笔',
            action === 'loosen'
              ? '入场风控若连续错杀，可有限增加一笔试错名额。'
              : '入场风控若拦截有效，应减少单日新增仓位，优先保护本金。'
          ),
          make(
            'max_daily_new_exposure_pct',
            '单日新增敞口上限',
            12,
            action === 'loosen' ? 14 : 10,
            '%',
            action === 'loosen'
              ? '只做小幅敞口放松，避免因为短期窗口过拟合而放大风险。'
              : '收紧新增敞口，让弱环境下的仓位纪律更可执行。'
          ),
        ];
      case 'profit_gate':
        return [
          make(
            'profit_gate_min_quality_score',
            '收益闸门质量分',
            45,
            action === 'loosen' ? 40 : 55,
            '分',
            action === 'loosen'
              ? '收益闸门若错杀高收益样本，可降低质量分让少量候选进入试错。'
              : '收益闸门若保护有效，应提高质量分，避免低质量信号继续消耗资金。'
          ),
          make(
            'profit_gate_sampling_multiplier',
            '收益闸门抽样仓位倍率',
            0.35,
            action === 'loosen' ? 0.45 : 0.25,
            'x',
            action === 'loosen'
              ? '放松时仍用抽样仓位，不直接恢复满仓位。'
              : '收紧时降低抽样仓位，保留验证通道但减少损失。'
          ),
        ];
      case 'outcome_feedback':
      case 'risk_level':
      case 'trade_discipline':
        return [
          make(
            'min_score',
            '最低推荐评分',
            72,
            action === 'loosen' ? 69 : 76,
            '分',
            action === 'loosen'
              ? '收益闭环若显示门槛过严，可小幅降低评分线扩大候选池。'
              : '收益闭环若显示低分样本拖累收益，应提高评分线。'
          ),
          make(
            'default_position_pct',
            '默认单票仓位',
            5,
            action === 'loosen' ? 5.5 : 4,
            '%',
            action === 'loosen'
              ? '放松只微增单票仓位，避免过快放大单一规则风险。'
              : '收紧时先降低单票仓位，把收益验证放在更小风险下进行。'
          ),
        ];
      case 'capital_or_lot_size':
        return [
          make(
            'min_trade_amount',
            '最低单笔交易额',
            3000,
            action === 'loosen' ? 2000 : 5000,
            '元',
            action === 'loosen'
              ? '资金/一手限制若错杀，可降低最小交易金额提高小仓位试错能力。'
              : '若小额交易噪声较高，则提高最小交易金额，减少无效订单。'
          ),
        ];
      default:
        return [
          make(
            'min_score',
            '最低推荐评分',
            72,
            action === 'loosen' ? 70 : 75,
            '分',
            '该原因暂未绑定专属参数，先用最低评分做保守预览。'
          ),
        ];
    }
  }

  private buildTuningPreviewConclusion(stableSuggestions: any[], previews: any[]) {
    const eligibleCount = stableSuggestions.filter(item => item.eligible_for_auto_tune).length;
    if (eligibleCount <= 0) {
      return '拒单后验尚未出现两个滚动窗口同向证据，继续观察，不建议自动改参数。';
    }
    return `已有 ${eligibleCount} 类规则通过稳定窗口校验，生成 ${previews.length} 条参数调整预览；当前仅展示不应用，下一步需审计确认。`;
  }

  private evaluateIntentHindsight(item: any, bars: any[]) {
    const intentDate = String(item.intent_date || '').slice(0, 10);
    const side = String(item.side || '').toUpperCase();
    const referencePrice = toNumber(item.reference_price ?? item.execute_price, 0);
    if (!intentDate || bars.length === 0) {
      return {
        intent_id: item.id,
        symbol: item.symbol,
        name: item.name,
        intent_date: intentDate,
        side,
        status: item.status,
        reason_category: item.reason_category,
        evaluation_status: 'pending',
        reason: '缺少后续K线',
      };
    }

    const normalizedBars = bars
      .map(bar => ({
        date: dateOnly(bar.time),
        close: toNumber(bar.close, 0),
      }))
      .filter(bar => bar.date && bar.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    const baseBar =
      [...normalizedBars].reverse().find(bar => bar.date <= intentDate) ||
      normalizedBars.find(bar => bar.date >= intentDate);
    const basePrice = referencePrice > 0 ? referencePrice : toNumber(baseBar?.close, 0);
    const futureBars = normalizedBars.filter(bar => bar.date > intentDate);
    if (!basePrice || futureBars.length === 0) {
      return {
        intent_id: item.id,
        symbol: item.symbol,
        name: item.name,
        intent_date: intentDate,
        side,
        status: item.status,
        reason_category: item.reason_category,
        evaluation_status: 'pending',
        reason: '后续交易日不足',
      };
    }

    const horizons: Record<string, any> = {};
    for (const horizon of HINDSIGHT_HORIZONS) {
      const targetBar = futureBars[horizon - 1];
      if (!targetBar) continue;
      const rawFutureReturnPct = roundNumber(((targetBar.close - basePrice) / basePrice) * 100, 4);
      const intendedActionReturnPct =
        side === 'SELL' ? roundNumber(-rawFutureReturnPct, 4) : rawFutureReturnPct;
      horizons[`${horizon}d`] = {
        horizon: `${horizon}d`,
        target_date: targetBar.date,
        target_price: roundNumber(targetBar.close, 4),
        base_price: roundNumber(basePrice, 4),
        raw_future_return_pct: rawFutureReturnPct,
        intended_action_return_pct: intendedActionReturnPct,
        conclusion: this.buildHindsightConclusion(side, intendedActionReturnPct, `${horizon}日`),
      };
    }

    const benchmark = horizons['5d'] || this.firstAvailableHorizon(horizons);
    return {
      intent_id: item.id,
      symbol: item.symbol,
      name: item.name,
      intent_date: intentDate,
      side,
      status: item.status,
      reason_category: item.reason_category,
      evaluation_status: Object.keys(horizons).length > 0 ? 'completed' : 'pending',
      benchmark_horizon: benchmark?.horizon,
      benchmark_conclusion: benchmark?.conclusion,
      horizons,
    };
  }

  private firstAvailableHorizon(horizons: Record<string, any>) {
    return HINDSIGHT_HORIZONS.map(horizon => horizons[`${horizon}d`]).find(Boolean);
  }

  private buildHindsightConclusion(side: string, intendedActionReturnPct: number, label: string) {
    const actionLabel = sideLabel(side);
    if (intendedActionReturnPct > 0.5) {
      return `可能错杀：若执行${actionLabel}，${label}后相对更优 ${roundNumber(
        intendedActionReturnPct,
        2
      )}%`;
    }
    if (intendedActionReturnPct < -0.5) {
      return `拦截有效：未执行${actionLabel}避免约 ${roundNumber(
        Math.abs(intendedActionReturnPct),
        2
      )}%不利结果`;
    }
    return `影响有限：执行${actionLabel}与未执行的${label}差异约 ${roundNumber(
      intendedActionReturnPct,
      2
    )}%`;
  }

  private countBy(items: any[], field: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of items) {
      const key = String(item?.[field] || 'unknown');
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  private buildConclusion(params: {
    total: number;
    executed: number;
    rejected: number;
    held: number;
    topReasonCategories: Array<{ label: string; count: number }>;
  }): string {
    if (params.total <= 0) {
      return '最近没有沉淀买卖意图，等待下一次自动荐股或风控任务运行。';
    }
    const topReason = params.topReasonCategories.find(item => item.count > 0);
    return `最近共记录 ${params.total} 条买卖意图，成交 ${params.executed} 条，未放行/跳过 ${
      params.rejected
    } 条，继续持有观察 ${params.held} 条；主要原因是 ${topReason?.label || '暂无明显集中原因'}。`;
  }

  private async resolvePortfolio(
    options: PaperTradingOrderIntentDashboardOptions
  ): Promise<PaperTradingPortfolio | null> {
    if (options.portfolio_id) {
      const portfolio = await PaperTradingPortfolio.findByPk(options.portfolio_id);
      if (portfolio) return portfolio;
    }

    const user = await this.resolveUser(options.user_id, options.username);
    if (options.portfolio_name) {
      const named = await PaperTradingPortfolio.findOne({
        where: { user_id: user.id, name: options.portfolio_name },
        order: [['id', 'ASC']],
      });
      if (named) return named;
    }

    const active = await PaperTradingPortfolio.findOne({
      where: {
        user_id: user.id,
        ...(options.portfolio_name ? { name: options.portfolio_name } : {}),
      },
      order: [
        ['is_active', 'DESC'],
        ['id', 'ASC'],
      ],
    });
    if (active) return active;
    return null;
  }

  private async resolveUser(user_id?: number, username?: string): Promise<User> {
    if (user_id) {
      const user = await User.findByPk(user_id);
      if (user) return user;
    }

    const preferredUsername = username || process.env.PAPER_TRADING_DEFAULT_USERNAME || 'lym';
    let user = await User.findOne({ where: { username: preferredUsername } });
    if (!user && preferredUsername !== 'lym') {
      user = await User.findOne({ where: { username: 'lym' } });
    }
    if (!user) {
      user = await User.findOne({
        where: { role: 'admin', is_active: true },
        order: [['id', 'ASC']],
      });
    }
    if (!user) {
      user = await User.findOne({ where: { is_active: true }, order: [['id', 'ASC']] });
    }
    if (!user) throw new Error('未找到模拟盘用户');
    return user;
  }
}

export const paperTradingOrderIntentService = new PaperTradingOrderIntentService();
