import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { RecommendationLoopPolicySnapshot } from '../models/RecommendationLoopPolicySnapshot';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { logger } from '../utils/logger';

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toOptionalNumber(value: any): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
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

export interface LoopPolicySnapshotQueryOptions {
  limit?: number;
  offset?: number;
  loop_run_id?: string;
  loop_run_ids?: string[];
  universe?: string;
  style?: string;
  start_date?: string;
  end_date?: string;
}

export interface LoopPolicySnapshotRefreshOptions {
  limit?: number;
  loop_run_id?: string;
  loop_run_ids?: string[];
  lookback_days?: number;
}

export class RecommendationLoopPolicySnapshotService {
  async recordFromLoopResult(
    result: any,
    options: { username?: string; execution_log_id?: number; record_type?: string } = {}
  ) {
    try {
      const loopPolicy = result?.loop_policy || {};
      const generated = result?.generated || {};
      const archive = result?.archive || {};
      const agentAnalysis = result?.agent_analysis || {};
      const paper = result?.paper_trading || {};
      const tradeOutcomes = result?.trade_outcomes || {};
      const outcomeSummary = tradeOutcomes?.summary || {};

      const archiveSignalIds = Array.isArray(archive.signal_ids) ? archive.signal_ids : [];

      const snapshot = await RecommendationLoopPolicySnapshot.create({
        generated_at: new Date(),
        loop_run_id: result?.loop_run_id,
        execution_log_id: options.execution_log_id,
        record_type: options.record_type,
        username: options.username,
        universe: result?.universe || generated?.universe || 'market',
        base_style: loopPolicy.base_style,
        effective_style: loopPolicy.effective_style || result?.style,
        candidate_limit:
          toOptionalNumber(generated.limit) || toOptionalNumber(result?.candidate_limit),
        candidate_pool_limit: toOptionalNumber(result?.candidate_pool_limit),
        archive_limit: toOptionalNumber(result?.archive_limit),
        lookback_days: toOptionalNumber(loopPolicy.lookback_days),
        base_min_score: toOptionalNumber(loopPolicy.base_min_score),
        effective_min_score: toOptionalNumber(loopPolicy.effective_min_score),
        base_default_position_pct: toOptionalNumber(loopPolicy.base_default_position_pct),
        effective_default_position_pct: toOptionalNumber(loopPolicy.effective_default_position_pct),
        base_max_position_pct: toOptionalNumber(loopPolicy.base_max_position_pct),
        effective_max_position_pct: toOptionalNumber(loopPolicy.effective_max_position_pct),
        base_paper_trade_limit: toOptionalNumber(loopPolicy.base_paper_trade_limit),
        effective_paper_trade_limit: toOptionalNumber(loopPolicy.effective_paper_trade_limit),
        closed_samples: toOptionalNumber(loopPolicy.closed_samples),
        min_closed_samples: toOptionalNumber(loopPolicy.min_closed_samples),
        policy_avg_excess_return_pct: toOptionalNumber(loopPolicy.avg_excess_return_pct),
        policy_excess_win_rate: toOptionalNumber(loopPolicy.excess_win_rate),
        position_multiplier: toOptionalNumber(loopPolicy.position_multiplier),
        generated_total_candidates: toOptionalNumber(generated.total_candidates),
        analyzed_candidates: toOptionalNumber(generated.analyzed_candidates),
        archive_total: toOptionalNumber(archive.total),
        agent_submitted: Array.isArray(agentAnalysis.submitted)
          ? agentAnalysis.submitted.length
          : undefined,
        paper_executed: toOptionalNumber(paper.executed),
        paper_planned: toOptionalNumber(paper.planned),
        paper_skipped: toOptionalNumber(paper.skipped),
        tracked_trade_count: toOptionalNumber(outcomeSummary.total_count),
        closed_trade_count: toOptionalNumber(outcomeSummary.closed_count),
        total_pnl: toOptionalNumber(outcomeSummary.total_pnl),
        avg_excess_return_pct: toOptionalNumber(outcomeSummary.avg_excess_return_pct),
        excess_win_rate: toOptionalNumber(outcomeSummary.excess_win_rate),
        policy_reason: loopPolicy.reason ? String(loopPolicy.reason).slice(0, 1000) : undefined,
        loop_policy: loopPolicy,
        best_segments: Array.isArray(loopPolicy.best_segments) ? loopPolicy.best_segments : [],
        weak_segments: Array.isArray(loopPolicy.weak_segments) ? loopPolicy.weak_segments : [],
        run_metrics: {
          generated,
          archive,
          agent_analysis: {
            enabled: agentAnalysis.enabled,
            target_date: agentAnalysis.target_date,
            agent_session: agentAnalysis.agent_session,
            auto_paper_trade: agentAnalysis.auto_paper_trade,
            submitted_count: Array.isArray(agentAnalysis.submitted)
              ? agentAnalysis.submitted.length
              : 0,
            failed_count: Array.isArray(agentAnalysis.failed) ? agentAnalysis.failed.length : 0,
          },
          paper_trading: paper
            ? {
                portfolio_id: paper.portfolio_id,
                dry_run: paper.dry_run,
                scanned: paper.scanned,
                eligible: paper.eligible,
                executed: paper.executed,
                planned: paper.planned,
                skipped: paper.skipped,
                profit_gate_policy: paper.profit_gate_policy,
                outcome_feedback_policy: paper.outcome_feedback_policy,
              }
            : null,
          trade_outcomes: tradeOutcomes,
          quality_report: result?.quality_report,
        },
        metadata: {
          result_generated_at: result?.generated_at,
          recorded_at: new Date().toISOString(),
        },
      } as any);
      if (snapshot?.id && archiveSignalIds.length > 0) {
        await this.attachSnapshotToSignals(archiveSignalIds, snapshot.id, result?.loop_run_id);
      }
      return snapshot;
    } catch (error: any) {
      logger.warn(`记录荐股闭环策略快照失败: ${error?.message || error}`);
      return null;
    }
  }

  private async attachSnapshotToSignals(
    signalIds: number[],
    snapshotId: number,
    loopRunId?: string
  ) {
    try {
      const { AIInvestmentSignal } = await import('../models/AIInvestmentSignal');
      const signals = await AIInvestmentSignal.findAll({ where: { id: { [Op.in]: signalIds } } });
      for (const signal of signals) {
        const metadata =
          signal.metadata && typeof signal.metadata === 'object' ? signal.metadata : {};
        await signal.update({
          loop_run_id: signal.loop_run_id || loopRunId,
          metadata: {
            ...metadata,
            loop_run_id: metadata.loop_run_id || loopRunId,
            loop_policy_snapshot_id: snapshotId,
          },
        });
      }
    } catch (error: any) {
      logger.warn(`回填荐股闭环快照ID到信号失败: ${error?.message || error}`);
    }
  }

  async getDashboard(options: LoopPolicySnapshotQueryOptions = {}) {
    const limit = toPositiveInt(options.limit, 100, 1000);
    const offset = Math.max(0, Number(options.offset || 0));
    const where: any = {};
    if (options.loop_run_id) where.loop_run_id = options.loop_run_id;
    if (options.universe && options.universe !== 'all') where.universe = options.universe;
    if (options.style && options.style !== 'all') where.effective_style = options.style;
    if (options.start_date || options.end_date) {
      where.generated_at = {};
      if (options.start_date)
        where.generated_at[Op.gte] = new Date(`${options.start_date}T00:00:00.000Z`);
      if (options.end_date)
        where.generated_at[Op.lte] = new Date(`${options.end_date}T23:59:59.999Z`);
    }

    const { rows, count } = await RecommendationLoopPolicySnapshot.findAndCountAll({
      where,
      order: [['generated_at', 'DESC']],
      limit,
      offset,
    });
    const plain = rows.map(row => modelToPlain<any>(row));
    const summary = this.buildSummary(plain);
    const groups = {
      by_style: this.buildBuckets(plain, item => item.effective_style || 'unknown'),
      by_universe: this.buildBuckets(plain, item => item.universe || 'unknown'),
      by_score_bucket: this.buildBuckets(plain, item => this.scoreBucket(item.effective_min_score)),
      by_position_bucket: this.buildBuckets(plain, item =>
        this.positionBucket(item.effective_default_position_pct)
      ),
    };

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      filters: options,
      count,
      limit,
      offset,
      summary,
      groups,
      snapshots: plain,
      insights: this.buildInsights(summary, groups, plain),
    };
  }

  async refreshOutcomeMetrics(options: LoopPolicySnapshotRefreshOptions = {}) {
    const limit = toPositiveInt(options.limit, 200, 1000);
    const loopRunIds = Array.isArray(options.loop_run_ids)
      ? options.loop_run_ids.map(item => String(item || '').trim()).filter(Boolean)
      : [];
    const where: any = { loop_run_id: { [Op.ne]: null } };
    if (options.loop_run_id) {
      where.loop_run_id = options.loop_run_id;
    } else if (loopRunIds.length > 0) {
      where.loop_run_id = { [Op.in]: loopRunIds };
    }
    if (options.lookback_days) {
      where.generated_at = {
        [Op.gte]: moment()
          .tz('Asia/Shanghai')
          .subtract(toPositiveInt(options.lookback_days, 365, 3650), 'days')
          .toDate(),
      };
    }

    const snapshots = await RecommendationLoopPolicySnapshot.findAll({
      where,
      order: [['generated_at', 'DESC']],
      limit,
    });

    const refreshed: any[] = [];
    for (const snapshot of snapshots) {
      if (!snapshot.loop_run_id) continue;
      const outcomes = await RecommendationTradeOutcome.findAll({
        where: { loop_run_id: snapshot.loop_run_id },
        raw: true,
      });
      const summary = this.summarizeOutcomes(outcomes);
      const runMetrics =
        snapshot.run_metrics && typeof snapshot.run_metrics === 'object'
          ? snapshot.run_metrics
          : {};
      const metadata =
        snapshot.metadata && typeof snapshot.metadata === 'object' ? snapshot.metadata : {};
      const refreshedAt = new Date().toISOString();

      await snapshot.update({
        tracked_trade_count: summary.tracked_trade_count,
        closed_trade_count: summary.closed_trade_count,
        total_pnl: summary.total_pnl,
        avg_excess_return_pct: summary.avg_excess_return_pct,
        excess_win_rate: summary.excess_win_rate,
        run_metrics: {
          ...runMetrics,
          outcome_refresh: {
            ...summary,
            refreshed_at: refreshedAt,
          },
        },
        metadata: {
          ...metadata,
          outcome_refreshed_at: refreshedAt,
        },
      } as any);

      refreshed.push({
        id: snapshot.id,
        loop_run_id: snapshot.loop_run_id,
        generated_at: snapshot.generated_at,
        effective_style: snapshot.effective_style,
        ...summary,
      });
    }

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      requested: {
        loop_run_id: options.loop_run_id,
        loop_run_ids: loopRunIds,
        limit,
        lookback_days: options.lookback_days,
      },
      matched_snapshots: snapshots.length,
      refreshed_count: refreshed.length,
      summary: this.summarizeOutcomeRefresh(refreshed),
      refreshed,
    };
  }

  private buildSummary(records: any[]) {
    const latest = records[0];
    const runs = records.length;
    const executedRuns = records.filter(
      item => toNumber(item.paper_executed) > 0 || toNumber(item.paper_planned) > 0
    );
    const totalExecuted = records.reduce((sum, item) => sum + toNumber(item.paper_executed), 0);
    const totalPlanned = records.reduce((sum, item) => sum + toNumber(item.paper_planned), 0);
    const avgMinScore = records.length
      ? records.reduce((sum, item) => sum + toNumber(item.effective_min_score), 0) / records.length
      : 0;
    const avgPosition = records.length
      ? records.reduce((sum, item) => sum + toNumber(item.effective_default_position_pct), 0) /
        records.length
      : 0;
    const avgPolicyExcess = records.length
      ? records.reduce((sum, item) => sum + toNumber(item.policy_avg_excess_return_pct), 0) /
        records.length
      : 0;
    const avgOutcomeExcess = records.length
      ? records.reduce((sum, item) => sum + toNumber(item.avg_excess_return_pct), 0) /
        records.length
      : 0;

    return {
      run_count: runs,
      executed_run_count: executedRuns.length,
      total_executed: totalExecuted,
      total_planned: totalPlanned,
      avg_effective_min_score: roundNumber(avgMinScore, 2),
      avg_default_position_pct: roundNumber(avgPosition, 2),
      avg_policy_excess_return_pct: roundNumber(avgPolicyExcess, 4),
      avg_outcome_excess_return_pct: roundNumber(avgOutcomeExcess, 4),
      latest_policy: latest,
      best_snapshot: [...records].sort(
        (a, b) => toNumber(b.avg_excess_return_pct) - toNumber(a.avg_excess_return_pct)
      )[0],
      most_active_snapshot: [...records].sort(
        (a, b) => toNumber(b.paper_executed) - toNumber(a.paper_executed)
      )[0],
    };
  }

  private buildBuckets(records: any[], keySelector: (record: any) => string) {
    const grouped = new Map<string, any[]>();
    for (const record of records) {
      const key = keySelector(record) || 'unknown';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(record);
    }

    return [...grouped.entries()]
      .map(([key, items]) => ({
        key,
        label: this.bucketLabel(key),
        count: items.length,
        executed: items.reduce((sum, item) => sum + toNumber(item.paper_executed), 0),
        planned: items.reduce((sum, item) => sum + toNumber(item.paper_planned), 0),
        avg_min_score: roundNumber(
          items.reduce((sum, item) => sum + toNumber(item.effective_min_score), 0) / items.length,
          2
        ),
        avg_position_pct: roundNumber(
          items.reduce((sum, item) => sum + toNumber(item.effective_default_position_pct), 0) /
            items.length,
          2
        ),
        avg_policy_excess_return_pct: roundNumber(
          items.reduce((sum, item) => sum + toNumber(item.policy_avg_excess_return_pct), 0) /
            items.length,
          4
        ),
        avg_outcome_excess_return_pct: roundNumber(
          items.reduce((sum, item) => sum + toNumber(item.avg_excess_return_pct), 0) / items.length,
          4
        ),
        latest_generated_at: items
          .map(item => item.generated_at)
          .sort()
          .reverse()[0],
      }))
      .sort(
        (a, b) =>
          b.avg_outcome_excess_return_pct - a.avg_outcome_excess_return_pct || b.count - a.count
      );
  }

  private buildInsights(summary: any, groups: any, records: any[]) {
    const insights: string[] = [];
    if (!records.length) {
      return ['暂无策略参数快照。下一次全市场荐股闭环执行后会自动生成快照。'];
    }
    insights.push(
      `已沉淀 ${summary.run_count} 次策略参数快照，累计自动成交 ${summary.total_executed} 笔。`
    );
    if (groups.by_style?.[0]) {
      insights.push(
        `当前表现最好的风格是 ${groups.by_style[0].label}，平均闭环超额 ${groups.by_style[0].avg_outcome_excess_return_pct}%。`
      );
    }
    if (summary.latest_policy?.policy_reason) {
      insights.push(`最近一次参数原因：${summary.latest_policy.policy_reason}`);
    }
    return insights;
  }

  private summarizeOutcomes(outcomes: any[]) {
    const closed = outcomes.filter(item => item.trade_status === 'closed');
    const open = outcomes.filter(item => item.trade_status !== 'closed');
    const excessValues = closed.map(item => Number(item.excess_return_pct)).filter(Number.isFinite);
    const totalPnl = outcomes.reduce((sum, item) => sum + toNumber(item.total_pnl), 0);
    const excessWins = excessValues.filter(value => value > 0);

    return {
      tracked_trade_count: outcomes.length,
      open_trade_count: open.length,
      closed_trade_count: closed.length,
      total_pnl: roundNumber(totalPnl, 2),
      avg_excess_return_pct: roundNumber(
        excessValues.length
          ? excessValues.reduce((sum, value) => sum + value, 0) / excessValues.length
          : 0,
        4
      ),
      excess_win_rate: excessValues.length
        ? roundNumber((excessWins.length / excessValues.length) * 100, 2)
        : 0,
    };
  }

  private summarizeOutcomeRefresh(refreshed: any[]) {
    const totalTracked = refreshed.reduce(
      (sum, item) => sum + toNumber(item.tracked_trade_count),
      0
    );
    const totalClosed = refreshed.reduce((sum, item) => sum + toNumber(item.closed_trade_count), 0);
    const totalPnl = refreshed.reduce((sum, item) => sum + toNumber(item.total_pnl), 0);
    const avgExcessValues = refreshed
      .filter(item => toNumber(item.closed_trade_count) > 0)
      .map(item => Number(item.avg_excess_return_pct))
      .filter(Number.isFinite);

    return {
      snapshot_count: refreshed.length,
      tracked_trade_count: totalTracked,
      closed_trade_count: totalClosed,
      total_pnl: roundNumber(totalPnl, 2),
      avg_excess_return_pct: roundNumber(
        avgExcessValues.length
          ? avgExcessValues.reduce((sum, value) => sum + value, 0) / avgExcessValues.length
          : 0,
        4
      ),
    };
  }

  private scoreBucket(value: any) {
    const score = toNumber(value);
    if (score >= 85) return 'score_85_plus';
    if (score >= 78) return 'score_78_84';
    if (score >= 72) return 'score_72_77';
    return 'score_below_72';
  }

  private positionBucket(value: any) {
    const pct = toNumber(value);
    if (pct >= 8) return 'position_8_plus';
    if (pct >= 5) return 'position_5_8';
    if (pct >= 3) return 'position_3_5';
    return 'position_below_3';
  }

  private bucketLabel(key: string) {
    const labels: Record<string, string> = {
      balanced: '均衡',
      momentum: '动量',
      value: '价值',
      low_risk: '低风险',
      market: '全市场',
      favorites: '自选池',
      score_85_plus: '评分≥85',
      score_78_84: '评分78-84',
      score_72_77: '评分72-77',
      score_below_72: '评分<72',
      position_8_plus: '仓位≥8%',
      position_5_8: '仓位5-8%',
      position_3_5: '仓位3-5%',
      position_below_3: '仓位<3%',
    };
    return labels[key] || key || '未标注';
  }
}

export const recommendationLoopPolicySnapshotService =
  new RecommendationLoopPolicySnapshotService();
