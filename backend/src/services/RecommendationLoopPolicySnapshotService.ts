import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { RecommendationLoopPolicySnapshot } from '../models/RecommendationLoopPolicySnapshot';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { logger } from '../utils/logger';
import {
  buildRecommendationStrategyVariant,
  recommendationBucketLabel,
  recommendationPositionBucket,
  recommendationScoreBucket,
  recommendationScorePositionKey,
  recommendationScorePositionLabel,
  recommendationStrategyKeyLabel,
} from '../utils/recommendationStrategyVariant';

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
  username?: string;
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
      const strategyVariant =
        loopPolicy.strategy_variant ||
        buildRecommendationStrategyVariant(loopPolicy, {
          loop_run_id: result?.loop_run_id,
          source: 'automated_recommendation_loop',
          generated_at: result?.generated_at,
        });
      const strategyKey = loopPolicy.strategy_key || strategyVariant.strategy_key;

      const archiveSignalIds = Array.isArray(archive.signal_ids) ? archive.signal_ids : [];
      const strategyExperiment = loopPolicy?.strategy_experiment || null;
      const consensusOverlapCount =
        toOptionalNumber(generated.consensus_overlap_count) ??
        toOptionalNumber(strategyExperiment?.overlap_count);
      const consensusTopSymbols = Array.isArray(generated.recommendations)
        ? generated.recommendations
            .filter(
              (item: any) =>
                Number(item?.consensus_count || 0) > 1 || Number(item?.consensus_bonus || 0) > 0
            )
            .slice(0, 10)
            .map((item: any) => ({
              symbol: item.symbol,
              name: item.name,
              score: roundNumber(item.score, 2),
              original_score:
                item.original_score !== undefined ? roundNumber(item.original_score, 2) : undefined,
              consensus_count: toOptionalNumber(item.consensus_count),
              consensus_bonus: toOptionalNumber(item.consensus_bonus),
              consensus_variants: Array.isArray(item.consensus_variants)
                ? item.consensus_variants.slice(0, 8)
                : [],
              recommendation_tier: item.recommendation_tier,
              recommendation_tier_label: item.recommendation_tier_label,
            }))
        : [];
      const consensusSummary = {
        ranked: Boolean(generated.consensus_ranked),
        overlap_count: consensusOverlapCount,
        top_symbols: consensusTopSymbols,
      };

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
          strategy_experiment: strategyExperiment,
          consensus: consensusSummary,
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
                consensus_executed: paper.consensus_executed,
                consensus_planned: paper.consensus_planned,
                consensus_top_trades: Array.isArray(paper.consensus_top_trades)
                  ? paper.consensus_top_trades
                  : [],
                skip_reason_summary: paper.skip_reason_summary || {
                  total: paper.skipped || 0,
                  top_reasons: [],
                  categories: {},
                },
                profit_gate_policy: paper.profit_gate_policy,
                outcome_feedback_policy: paper.outcome_feedback_policy,
              }
            : null,
          trade_outcomes: tradeOutcomes,
          quality_report: result?.quality_report,
          strategy_variant: strategyVariant,
        },
        metadata: {
          result_generated_at: result?.generated_at,
          recorded_at: new Date().toISOString(),
          consensus_ranked: consensusSummary.ranked,
          consensus_overlap_count: consensusSummary.overlap_count,
          strategy_key: strategyKey,
          strategy_variant: strategyVariant,
          strategy_bucket_label: strategyVariant.strategy_bucket_label,
        },
      } as any);
      if (snapshot?.id && archiveSignalIds.length > 0) {
        await this.attachSnapshotToSignals(
          archiveSignalIds,
          snapshot.id,
          result?.loop_run_id,
          strategyVariant
        );
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
    loopRunId?: string,
    strategyVariant?: any
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
            strategy_key: metadata.strategy_key || strategyVariant?.strategy_key,
            strategy_variant: metadata.strategy_variant || strategyVariant,
            strategy_bucket_label:
              metadata.strategy_bucket_label || strategyVariant?.strategy_bucket_label,
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
    if (options.username) where.username = options.username;
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
      by_score_position_bucket: this.buildBuckets(plain, item =>
        recommendationScorePositionKey(
          item.effective_min_score,
          item.effective_default_position_pct
        )
      ),
      by_strategy_key: this.buildBuckets(plain, item => this.strategyKeyFromSnapshot(item)),
    };

    const rankings = this.buildPolicyRankings(plain, groups);
    const promotion = this.buildPromotionAdvice(summary, rankings, plain);

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      filters: options,
      count,
      limit,
      offset,
      summary,
      groups,
      rankings,
      promotion,
      snapshots: plain,
      insights: this.buildInsights(summary, groups, plain, promotion),
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

  private buildPolicyRankings(records: any[], groups: any) {
    const scoreSnapshot = (item: any) => {
      const closed = toNumber(item.closed_trade_count);
      const tracked = toNumber(item.tracked_trade_count);
      const avgExcess = toNumber(item.avg_excess_return_pct);
      const winRate = toNumber(item.excess_win_rate);
      const totalPnl = toNumber(item.total_pnl);
      const activity = Math.log1p(Math.max(closed, tracked));
      const samplePenalty = closed < 3 ? (3 - closed) * 4 : 0;
      return roundNumber(
        avgExcess * 7 + (winRate - 50) * 0.18 + activity * 2 + totalPnl / 15000 - samplePenalty,
        2
      );
    };

    const snapshots = [...records]
      .map(item => ({
        id: item.id,
        loop_run_id: item.loop_run_id,
        generated_at: item.generated_at,
        universe: item.universe,
        effective_style: item.effective_style,
        effective_min_score: toNumber(item.effective_min_score),
        effective_default_position_pct: toNumber(item.effective_default_position_pct),
        effective_max_position_pct: toNumber(item.effective_max_position_pct),
        effective_paper_trade_limit: toNumber(item.effective_paper_trade_limit),
        tracked_trade_count: toNumber(item.tracked_trade_count),
        closed_trade_count: toNumber(item.closed_trade_count),
        total_pnl: roundNumber(item.total_pnl, 2),
        avg_excess_return_pct: roundNumber(item.avg_excess_return_pct, 4),
        excess_win_rate: roundNumber(item.excess_win_rate, 2),
        promotion_score: scoreSnapshot(item),
      }))
      .sort(
        (a, b) =>
          b.promotion_score - a.promotion_score || b.closed_trade_count - a.closed_trade_count
      )
      .slice(0, 12);

    const rankBucket = (items: any[]) =>
      [...(items || [])]
        .map(item => ({
          ...item,
          promotion_score: roundNumber(
            (item.robust_score !== undefined
              ? toNumber(item.robust_score)
              : toNumber(item.avg_outcome_excess_return_pct) * 7) +
              (toNumber(item.executed) + toNumber(item.planned)) * 0.8 +
              Math.log1p(toNumber(item.count)) * 2,
            2
          ),
        }))
        .sort((a, b) => b.promotion_score - a.promotion_score)
        .slice(0, 8);

    return {
      snapshots,
      by_style: rankBucket(groups.by_style),
      by_score_bucket: rankBucket(groups.by_score_bucket),
      by_position_bucket: rankBucket(groups.by_position_bucket),
      by_universe: rankBucket(groups.by_universe),
      by_score_position_bucket: rankBucket(groups.by_score_position_bucket),
      by_strategy_key: rankBucket(groups.by_strategy_key),
    };
  }

  private buildPromotionAdvice(summary: any, rankings: any, records: any[]) {
    const latest = summary.latest_policy || {};
    const best = rankings.snapshots?.[0];
    const bestStyle = rankings.by_style?.find((item: any) => item.key && item.key !== 'unknown');
    const bestScoreBucket = rankings.by_score_bucket?.[0];
    const bestPositionBucket = rankings.by_position_bucket?.[0];
    const bestStrategyKey = rankings.by_strategy_key?.find(
      (item: any) => item.key && item.key !== 'unknown'
    );
    const latestScore = toNumber(latest.effective_min_score, 72);
    const latestDefaultPosition = toNumber(latest.effective_default_position_pct, 5);
    const latestMaxPosition = toNumber(latest.effective_max_position_pct, 10);
    const latestTradeLimit = toNumber(latest.effective_paper_trade_limit, 3);
    const closedSamples = toNumber(summary.best_snapshot?.closed_trade_count);
    const avgExcess = toNumber(summary.avg_outcome_excess_return_pct);

    let recommendedStyle = latest.effective_style || bestStyle?.key || 'balanced';
    if (
      bestStyle &&
      toNumber(bestStyle.avg_outcome_excess_return_pct) > Math.max(0.8, avgExcess + 0.5)
    ) {
      recommendedStyle = bestStyle.key;
    }

    let recommendedMinScore = latestScore || 72;
    if (bestScoreBucket?.key === 'score_85_plus')
      recommendedMinScore = Math.max(recommendedMinScore, 85);
    else if (bestScoreBucket?.key === 'score_78_84')
      recommendedMinScore = Math.max(78, Math.min(recommendedMinScore, 84));
    else if (bestScoreBucket?.key === 'score_72_77')
      recommendedMinScore = Math.max(72, Math.min(recommendedMinScore, 77));
    if (avgExcess < -1) recommendedMinScore += 3;
    if (avgExcess > 2 && toNumber(summary.total_executed) >= 3) recommendedMinScore -= 1;
    recommendedMinScore = Math.max(62, Math.min(94, Math.round(recommendedMinScore)));

    let positionMultiplier = 0.65;
    if (closedSamples >= 3 && avgExcess > 1.5) positionMultiplier = 1.1;
    else if (closedSamples >= 3 && avgExcess >= 0) positionMultiplier = 0.9;
    else if (closedSamples < 3) positionMultiplier = 0.55;
    if (bestPositionBucket?.key === 'position_8_plus' && avgExcess > 1.5) {
      positionMultiplier = Math.max(positionMultiplier, 1.05);
    }
    if (bestPositionBucket?.key === 'position_below_3') {
      positionMultiplier = Math.min(positionMultiplier, 0.65);
    }

    const recommendedDefaultPositionPct = roundNumber(
      Math.max(1, Math.min(12, latestDefaultPosition * positionMultiplier)),
      2
    );
    const recommendedMaxPositionPct = roundNumber(
      Math.max(
        recommendedDefaultPositionPct,
        Math.min(15, latestMaxPosition * Math.max(positionMultiplier, 0.6))
      ),
      2
    );
    const recommendedPaperTradeLimit =
      closedSamples >= 5 && avgExcess > 1.5
        ? Math.min(6, Math.max(3, latestTradeLimit + 1))
        : avgExcess < -1
        ? Math.max(1, Math.min(2, latestTradeLimit))
        : Math.max(1, Math.min(4, latestTradeLimit || 3));

    const action =
      records.length === 0
        ? 'wait_for_snapshots'
        : closedSamples < 3
        ? 'collect_samples'
        : avgExcess > 1.5
        ? 'scale_up'
        : avgExcess < -1
        ? 'tighten'
        : 'hold_and_compare';

    const reasons = [
      records.length === 0 ? '暂无策略版本样本，等待下一次全市场闭环自动生成。' : '',
      best
        ? `当前最高晋级分版本 #${best.id}，平均超额 ${best.avg_excess_return_pct}%、闭环样本 ${best.closed_trade_count}。`
        : '',
      bestStyle
        ? `风格排名第一：${this.bucketLabel(bestStyle.key)}，平均超额 ${
            bestStyle.avg_outcome_excess_return_pct
          }%。`
        : '',
      bestStrategyKey
        ? `参数组合冠军：${bestStrategyKey.label}，平均超额 ${bestStrategyKey.avg_outcome_excess_return_pct}%、版本 ${bestStrategyKey.count} 次。`
        : '',
      closedSamples < 3 ? '闭环平仓样本仍不足，建议小仓继续采样，避免过早放大。' : '',
      avgExcess < -1 ? '版本平均超额为负，下一轮应提高评分阈值并降低仓位。' : '',
      avgExcess > 1.5 ? '版本平均超额为正且具备放量验证条件，可小幅放大跟单数量。' : '',
    ].filter(Boolean);

    return {
      action,
      confidence:
        records.length === 0 ? 0 : closedSamples >= 5 ? 0.72 : closedSamples >= 3 ? 0.58 : 0.35,
      recommended_style: recommendedStyle,
      recommended_min_score: recommendedMinScore,
      recommended_default_position_pct: recommendedDefaultPositionPct,
      recommended_max_position_pct: recommendedMaxPositionPct,
      recommended_paper_trade_limit: recommendedPaperTradeLimit,
      position_multiplier: roundNumber(positionMultiplier, 2),
      best_snapshot: best || null,
      best_style: bestStyle || null,
      best_score_bucket: bestScoreBucket || null,
      best_position_bucket: bestPositionBucket || null,
      best_strategy_key: bestStrategyKey || null,
      reasons,
    };
  }

  private buildInsights(summary: any, groups: any, records: any[], promotion?: any) {
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
    if (groups.by_strategy_key?.[0]) {
      insights.push(
        `当前表现最好的参数组合是 ${groups.by_strategy_key[0].label}，平均闭环超额 ${groups.by_strategy_key[0].avg_outcome_excess_return_pct}%。`
      );
    }
    if (promotion?.action) {
      const actionLabels: Record<string, string> = {
        wait_for_snapshots: '等待版本样本',
        collect_samples: '继续小仓采样',
        scale_up: '小幅放大验证',
        tighten: '收紧评分/仓位',
        hold_and_compare: '保持参数继续对比',
      };
      insights.push(
        `下一轮建议：${actionLabels[promotion.action] || promotion.action}，风格 ${this.bucketLabel(
          promotion.recommended_style
        )}，评分≥${promotion.recommended_min_score}，默认仓位 ${
          promotion.recommended_default_position_pct
        }%。`
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
    return recommendationScoreBucket(value);
  }

  private positionBucket(value: any) {
    return recommendationPositionBucket(value);
  }

  private bucketLabel(key: string) {
    if (String(key || '').includes('|')) {
      if (String(key).startsWith('score:')) return recommendationScorePositionLabel(key);
      return recommendationStrategyKeyLabel(key);
    }
    return recommendationBucketLabel(key);
  }

  private strategyKeyFromSnapshot(record: any): string {
    const metadata = record?.metadata && typeof record.metadata === 'object' ? record.metadata : {};
    const loopPolicy =
      record?.loop_policy && typeof record.loop_policy === 'object' ? record.loop_policy : {};
    return (
      metadata.strategy_key ||
      loopPolicy.strategy_key ||
      loopPolicy.strategy_variant?.strategy_key ||
      buildRecommendationStrategyVariant(
        {
          ...record,
          ...loopPolicy,
        },
        {
          loop_run_id: record?.loop_run_id,
          source: 'policy_snapshot_backfill',
        }
      ).strategy_key ||
      'unknown'
    );
  }
}

export const recommendationLoopPolicySnapshotService =
  new RecommendationLoopPolicySnapshotService();
