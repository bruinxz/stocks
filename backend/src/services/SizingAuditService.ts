/**
 * SizingAuditService — Phase 2+ A/B 比较报告
 *
 * 聚合 sizing_decision_audits 表，回答用户："如果我切到 Kelly，
 * 过去 30 天的下单会是什么样？" + "目前 method=kelly shadow 跑了 N 笔，
 * 平均 delta 是多少？最大 delta 是哪笔？"
 *
 * 输出指标:
 *   - count: 决策行数
 *   - avg_delta_pct: 平均 (decision - actual)，>0 说明 sizing 倾向加仓
 *   - max_abs_delta_pct: 最大绝对差异 (找异常)
 *   - capped_by_max_pct: max_position_pct cap 触发率
 *   - capped_by_cash_pct: cash cap 触发率
 *   - by_strategy: 按 strategy_key 分组明细
 */
import { Op } from 'sequelize';
import { SizingDecisionAudit } from '../models/SizingDecisionAudit';
import { logger } from '../utils/logger';

export interface SizingAuditSummary {
  count: number;
  hard_cutover_count: number;
  shadow_count: number;
  avg_actual_pct: number;
  avg_decision_pct: number;
  avg_delta_pct: number;
  max_abs_delta_pct: number;
  max_abs_delta_symbol?: string;
  capped_by_max_pct: number;
  capped_by_cash_pct: number;
}

export interface SizingAuditByStrategy {
  strategy_key: string;
  count: number;
  avg_actual_pct: number;
  avg_decision_pct: number;
  avg_delta_pct: number;
  method_breakdown: Record<string, number>;
}

export interface SizingAuditReport {
  generated_at: string;
  user_id: number;
  filter: {
    portfolio_id?: number;
    method?: string;
    lookback_days: number;
    start_date: string;
  };
  summary: SizingAuditSummary;
  by_strategy: SizingAuditByStrategy[];
  recent_rows: Array<{
    id: number;
    symbol: string;
    strategy_key?: string;
    method: string;
    hard_cutover: boolean;
    actual_pct: number;
    decision_pct: number;
    delta: number;
    reason?: string;
    created_at: string;
  }>;
}

export class SizingAuditService {
  /**
   * 拉取 user 在 [lookback_days] 内的所有 sizing decisions 并聚合。
   */
  async getReport(
    user_id: number,
    options: {
      portfolio_id?: number;
      method?: string; // equal_pct / vol_target / atr_based / kelly
      lookback_days?: number; // 默认 30
    } = {}
  ): Promise<SizingAuditReport> {
    const lookback = Math.max(1, Math.min(365, options.lookback_days || 30));
    const since = new Date();
    since.setDate(since.getDate() - lookback);

    const where: any = {
      user_id,
      created_at: { [Op.gte]: since },
    };
    if (options.portfolio_id) where.portfolio_id = options.portfolio_id;
    if (options.method && options.method !== 'all') where.method = options.method;

    const rows = await SizingDecisionAudit.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: 2000, // 上限保护
    });

    const summary = this.computeSummary(rows);
    const byStrategy = this.computeByStrategy(rows);
    const recentRows = rows.slice(0, 50).map(r => ({
      id: r.id,
      symbol: r.symbol,
      strategy_key: r.strategy_key,
      method: r.method,
      hard_cutover: r.hard_cutover,
      actual_pct: Number(r.actual_pct),
      decision_pct: Number(r.decision_pct),
      delta: Number(r.delta),
      reason: r.reason,
      created_at: r.created_at.toISOString(),
    }));

    return {
      generated_at: new Date().toISOString(),
      user_id,
      filter: {
        portfolio_id: options.portfolio_id,
        method: options.method,
        lookback_days: lookback,
        start_date: since.toISOString().slice(0, 10),
      },
      summary,
      by_strategy: byStrategy,
      recent_rows: recentRows,
    };
  }

  /**
   * 纯计算 — 单测可独立调用。
   */
  computeSummary(rows: SizingDecisionAudit[]): SizingAuditSummary {
    if (rows.length === 0) {
      return {
        count: 0,
        hard_cutover_count: 0,
        shadow_count: 0,
        avg_actual_pct: 0,
        avg_decision_pct: 0,
        avg_delta_pct: 0,
        max_abs_delta_pct: 0,
        capped_by_max_pct: 0,
        capped_by_cash_pct: 0,
      };
    }
    const n = rows.length;
    let sumActual = 0;
    let sumDecision = 0;
    let sumDelta = 0;
    let maxAbsDelta = 0;
    let maxAbsDeltaSymbol: string | undefined;
    let cappedMax = 0;
    let cappedCash = 0;
    let hardCount = 0;
    for (const r of rows) {
      const actual = Number(r.actual_pct);
      const decision = Number(r.decision_pct);
      const delta = Number(r.delta);
      sumActual += actual;
      sumDecision += decision;
      sumDelta += delta;
      if (Math.abs(delta) > maxAbsDelta) {
        maxAbsDelta = Math.abs(delta);
        maxAbsDeltaSymbol = r.symbol;
      }
      if (r.capped_by_max) cappedMax++;
      if (r.capped_by_cash) cappedCash++;
      if (r.hard_cutover) hardCount++;
    }
    return {
      count: n,
      hard_cutover_count: hardCount,
      shadow_count: n - hardCount,
      avg_actual_pct: this.round(sumActual / n, 3),
      avg_decision_pct: this.round(sumDecision / n, 3),
      avg_delta_pct: this.round(sumDelta / n, 3),
      max_abs_delta_pct: this.round(maxAbsDelta, 3),
      max_abs_delta_symbol: maxAbsDeltaSymbol,
      capped_by_max_pct: this.round((cappedMax / n) * 100, 1),
      capped_by_cash_pct: this.round((cappedCash / n) * 100, 1),
    };
  }

  computeByStrategy(rows: SizingDecisionAudit[]): SizingAuditByStrategy[] {
    const grouped = new Map<string, SizingDecisionAudit[]>();
    for (const r of rows) {
      const key = r.strategy_key || 'unknown';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(r);
    }
    return Array.from(grouped.entries())
      .map(([strategy_key, items]) => {
        const n = items.length;
        const sumActual = items.reduce((s, r) => s + Number(r.actual_pct), 0);
        const sumDecision = items.reduce((s, r) => s + Number(r.decision_pct), 0);
        const sumDelta = items.reduce((s, r) => s + Number(r.delta), 0);
        const methodBreakdown: Record<string, number> = {};
        for (const r of items) {
          methodBreakdown[r.method] = (methodBreakdown[r.method] || 0) + 1;
        }
        return {
          strategy_key,
          count: n,
          avg_actual_pct: this.round(sumActual / n, 3),
          avg_decision_pct: this.round(sumDecision / n, 3),
          avg_delta_pct: this.round(sumDelta / n, 3),
          method_breakdown: methodBreakdown,
        };
      })
      .sort((a, b) => b.count - a.count);
  }

  private round(n: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(n * factor) / factor;
  }
}

export const sizingAuditService = new SizingAuditService();
