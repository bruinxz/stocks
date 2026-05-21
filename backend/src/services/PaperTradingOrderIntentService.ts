import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { PaperTradingOrderIntent } from '../models/PaperTradingOrderIntent';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { User } from '../models/User';

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
        rule_suggestions: this.buildRuleSuggestions(benchmark),
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

  private evaluateIntentHindsight(item: any, bars: any[]) {
    const intentDate = String(item.intent_date || '').slice(0, 10);
    const side = String(item.side || '').toUpperCase();
    const referencePrice = toNumber(item.reference_price ?? item.execute_price, 0);
    if (!intentDate || bars.length === 0) {
      return {
        intent_id: item.id,
        symbol: item.symbol,
        name: item.name,
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
