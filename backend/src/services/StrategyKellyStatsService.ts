/**
 * StrategyKellyStatsService — Phase 2 Kelly sizing 数据源
 *
 * Kelly 公式需要 3 个输入：
 *   - p = 历史胜率 (winning trades / total closed trades)
 *   - b = 平均盈利金额 / 平均亏损金额 (payoff ratio)
 *   - n = 样本量 (低于阈值不下注 Kelly)
 *
 * 数据源：RecommendationTradeOutcome (Phase 5 已落地)
 *   - 一条 outcome = 一笔完整闭环 trade（开仓 → 平仓）
 *   - 我们按 `signal.metadata.strategy_key` 聚合每个策略的统计
 *   - 只算 `status='closed'` (已平仓) 的 trade
 *   - 计算 `total_pnl_pct`：>0 算赢，<0 算输
 *
 * 缓存策略：
 *   - in-memory Map<strategy_key, {stats, computed_at}>
 *   - TTL 1 小时（Kelly 参数变化缓慢，1 小时内重复读不必反复查 DB）
 *   - 写时校验 timestamp 自动 invalidate
 *
 * 使用：
 *   const stats = await strategyKellyStatsService.getStats('multi_factor_alpha');
 *   if (stats) decideSizing(policy, { ...ctx, historical_win_rate: stats.win_rate, ... })
 */

import { Op } from 'sequelize';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { logger } from '../utils/logger';

export interface StrategyKellyStats {
  strategy_key: string;
  sample_size: number;
  win_count: number;
  loss_count: number;
  win_rate: number; // 0-1
  avg_win_pct: number; // 正数, 已涨幅%
  avg_loss_pct: number; // 正数, 已跌幅% (取 absolute value)
  payoff_ratio: number; // avg_win_pct / avg_loss_pct
  computed_at: Date;
}

interface CacheEntry {
  stats: StrategyKellyStats | null; // null = 计算后无样本，记录 null 避免反复查
  computed_at: number; // epoch ms
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const MIN_LOOKBACK_DAYS = 365; // 至少回看 1 年

export class StrategyKellyStatsService {
  private cache = new Map<string, CacheEntry>();

  /**
   * 强制 invalidate 全部缓存。新交易 outcome 写入时调用，确保 Kelly 用最新数据。
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * 强制 invalidate 某个 strategy_key 的缓存。
   */
  invalidate(strategy_key: string): void {
    this.cache.delete(strategy_key);
  }

  /**
   * 获取某策略的 Kelly 统计。
   *
   * @param strategy_key e.g. 'multi_factor_alpha'
   * @param lookbackDays 回看天数，默认 365；min=90
   * @returns null 当样本不足以计算（< 5 笔 closed trades）
   */
  async getStats(strategy_key: string, lookbackDays = MIN_LOOKBACK_DAYS): Promise<StrategyKellyStats | null> {
    if (!strategy_key) return null;

    // 缓存命中
    const cached = this.cache.get(strategy_key);
    if (cached && Date.now() - cached.computed_at < CACHE_TTL_MS) {
      return cached.stats;
    }

    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - Math.max(90, lookbackDays));
    const sinceStr = sinceDate.toISOString().slice(0, 10);

    try {
      // 读所有 closed trades 一次性聚合（避免 N 次查询）
      const rows = await RecommendationTradeOutcome.findAll({
        where: {
          trade_status: 'closed',
          entry_date: { [Op.gte]: sinceStr },
        },
        attributes: ['total_pnl_pct', 'realized_pnl_pct', 'metadata'],
        limit: 5000, // 安全上限，5000 笔已远超 Kelly 所需
      });

      // 过滤 strategy_key 匹配的（metadata.signal_metadata.strategy_key 或 metadata.strategy_key）
      const matching = rows.filter(r => {
        const md: any = r.metadata || {};
        const sm: any = md.signal_metadata || {};
        const key = md.strategy_key || sm.strategy_key || md.strategy_keys?.[0];
        return key === strategy_key;
      });

      if (matching.length < 5) {
        // 样本不足
        this.cache.set(strategy_key, { stats: null, computed_at: Date.now() });
        return null;
      }

      const stats = this.computeStats(strategy_key, matching);
      this.cache.set(strategy_key, { stats, computed_at: Date.now() });
      return stats;
    } catch (err: any) {
      logger.warn(`[KellyStats] getStats(${strategy_key}) failed: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * 纯计算函数 — 单测可独立调用。
   */
  computeStats(strategy_key: string, rows: Array<{ total_pnl_pct?: number; realized_pnl_pct?: number }>): StrategyKellyStats {
    const pnls = rows
      .map(r => Number(r.total_pnl_pct ?? r.realized_pnl_pct ?? NaN))
      .filter(v => Number.isFinite(v));

    const wins = pnls.filter(v => v > 0);
    const losses = pnls.filter(v => v < 0);
    const winCount = wins.length;
    const lossCount = losses.length;
    const totalCount = pnls.length;

    const winRate = totalCount > 0 ? winCount / totalCount : 0;
    const avgWin = winCount > 0 ? wins.reduce((s, v) => s + v, 0) / winCount : 0;
    const avgLossRaw = lossCount > 0 ? Math.abs(losses.reduce((s, v) => s + v, 0) / lossCount) : 0;
    // 兜底：如果一笔都没亏过（罕见但可能），payoff_ratio 不定义；返回保守值 1
    const payoffRatio = avgLossRaw > 0 ? avgWin / avgLossRaw : 1;

    return {
      strategy_key,
      sample_size: totalCount,
      win_count: winCount,
      loss_count: lossCount,
      win_rate: winRate,
      avg_win_pct: avgWin,
      avg_loss_pct: avgLossRaw,
      payoff_ratio: payoffRatio,
      computed_at: new Date(),
    };
  }

  /**
   * v5 集成: Thompson Sampling-augmented Kelly fraction
   *
   * 当 TS_KELLY_ENABLED=true 时:
   *   - 用 Beta-Bernoulli posterior (α=win_count+1, β=loss_count+1)
   *   - 采样 100 次 win_rate 样本, 算 90% lower bound
   *   - 用 lower bound 而非 point estimate (保守 Kelly)
   *
   * 优点: 不确定性 (low sample) 时 Kelly 降权; 高 sample 时接近 point estimate.
   *
   * @returns adjusted win_rate (90% lower CI from posterior)
   */
  async getThompsonSampledWinRate(strategy_key: string, percentile_lower: number = 0.1): Promise<number | null> {
    const stats = await this.getStats(strategy_key);
    if (!stats) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ts = require('./portfolio/thompson-sampling');
    const rng = new ts.TSRng(42);
    const alpha = stats.win_count + 1;
    const beta = stats.loss_count + 1;
    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      samples.push(ts.sampleBeta(alpha, beta, rng));
    }
    samples.sort((a, b) => a - b);
    const idx = Math.max(0, Math.floor(percentile_lower * samples.length));
    return samples[idx]; // 10th percentile = 90% lower confidence
  }
}

export const strategyKellyStatsService = new StrategyKellyStatsService();
