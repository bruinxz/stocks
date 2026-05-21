import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { PaperTradingOrderIntent } from '../models/PaperTradingOrderIntent';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
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
    const visible = records.map(item => this.normalizeIntent(modelToPlain<any>(item)));
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

  private normalizeIntent(item: any) {
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
      compact_reason:
        item.reason_text ||
        executionReality.label ||
        (Array.isArray(executionReality.reasons) ? executionReality.reasons.join('；') : ''),
    };
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
