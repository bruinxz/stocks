/**
 * EquityCurveGovernorService — Sprint 3 资金曲线 5 档梯度治理
 *
 * 取代既有 StrategyKillSwitchMonitor 二值（disabled/enabled）模式，把整体
 * portfolio 健康度连续映射到 Kelly 倍数 ∈ {1.0, 0.7, 0.4, 0.2, 0.0}。
 *
 * **5 档判定**（按严重程度降序检查；命中即停）:
 *
 *   1. **observe_only** (mult=0.0) — 仅观察，不下任何新单
 *      - 当前回撤 ≥ 25%
 *      - 或 30d sharpe ≤ -1.5
 *
 *   2. **critical** (mult=0.2) — 1/5 仓位
 *      - 当前回撤 ≥ 18%
 *      - 或 30d sharpe ≤ -0.8
 *      - 或 30d win_rate ≤ 0.30
 *
 *   3. **defensive** (mult=0.4) — 2/5 仓位
 *      - 当前回撤 ≥ 12%
 *      - 或 30d sharpe ≤ -0.3
 *      - 或 30d win_rate ≤ 0.40
 *
 *   4. **cautious** (mult=0.7) — 7/10 仓位
 *      - 当前回撤 ≥ 6%
 *      - 或 30d sharpe ≤ 0.5
 *      - 或 30d win_rate ≤ 0.50
 *
 *   5. **healthy** (mult=1.0) — 全仓
 *      - 任何更优情形
 *
 * **与 SizingPolicy 的集成**:
 *   - `PositionSizingPolicy.decideSizing()` 计算 rawAmount 后
 *     乘以 `equityCurveGovernorService.getCurrentMultiplier(portfolio_id)`
 *   - 退化：未启用 governor / 无 state → 返回 1.0
 *
 * **与 DrawdownCircuitBreaker 的区别**:
 *   - DrawdownCircuitBreaker 是**硬触发**（阈值=10%/15%/20% pause / sell-half / liquidate）
 *   - EquityCurveGovernor 是**软调节**（连续降权）；两者并存:
 *     - <6% 回撤：governor 健康，CircuitBreaker 不触发
 *     - 6-10%：governor cautious 但 CircuitBreaker 还没触发
 *     - 10-15%：governor defensive + CircuitBreaker LEVEL_1 (pause new buys)
 *     - 15-20%：governor critical + CircuitBreaker LEVEL_2 (sell half)
 *     - ≥20%：governor observe_only + CircuitBreaker LEVEL_3 (liquidate)
 *
 * **数据源**:
 *   - PaperTradingSnapshot (历史 30 天 total_value) → 算 sharpe + drawdown
 *   - PaperTradingTrade (closed) → 算 win_rate
 *
 * **每日 cron 触发** + 每次 close_position 后 fire-and-forget 触发。
 */

import { Op } from 'sequelize';
import {
  EquityCurveGovernorState,
  GovernorHealthTier,
} from '../../models/EquityCurveGovernorState';
import { logger } from '../../utils/logger';
import { continuousMultiplier, applyMultiplierBuffer } from './carver-extensions';

// ============================================================
// Constants
// ============================================================

export const TIER_MULTIPLIERS: Record<GovernorHealthTier, number> = {
  healthy: 1.0,
  cautious: 0.7,
  defensive: 0.4,
  critical: 0.2,
  observe_only: 0.0,
};

export const SHARPE_LOOKBACK_DAYS = 30;
export const WINRATE_LOOKBACK_DAYS = 30;

/** 触发档位的阈值表 */
export interface TierThresholds {
  drawdown_observe_only: number; // 25%
  drawdown_critical: number; // 18%
  drawdown_defensive: number; // 12%
  drawdown_cautious: number; // 6%
  sharpe_observe_only: number; // -1.5
  sharpe_critical: number; // -0.8
  sharpe_defensive: number; // -0.3
  sharpe_cautious: number; // 0.5
  winrate_critical: number; // 0.30
  winrate_defensive: number; // 0.40
  winrate_cautious: number; // 0.50
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = Object.freeze({
  drawdown_observe_only: 0.25,
  drawdown_critical: 0.18,
  drawdown_defensive: 0.12,
  drawdown_cautious: 0.06,
  sharpe_observe_only: -1.5,
  sharpe_critical: -0.8,
  sharpe_defensive: -0.3,
  sharpe_cautious: 0.5,
  winrate_critical: 0.3,
  winrate_defensive: 0.4,
  winrate_cautious: 0.5,
});

// ============================================================
// Types
// ============================================================

export interface PortfolioStats {
  /** 30 日 sharpe (annualized) */
  sharpe_30d: number | null;
  /** 当前回撤 (正数小数；e.g. 0.125 = -12.5%) */
  drawdown_current: number | null;
  /** 30 日 win_rate (0-1) */
  winrate_30d: number | null;
  /** 用于审计：30 日 trade 数 */
  trades_30d: number;
  /** 用于审计：snapshot 数 */
  snapshots_count: number;
}

export interface PortfolioInfo {
  portfolio_id: number;
  user_id: number;
}

export interface GovernorDataSource {
  loadAllPortfolios(): Promise<PortfolioInfo[]>;
  loadStats(portfolio_id: number, as_of_date: string): Promise<PortfolioStats>;
  loadPreviousTier(portfolio_id: number): Promise<GovernorHealthTier | null>;
}

export interface EvaluateOptions {
  thresholds?: TierThresholds;
  persist?: boolean;
  data_source?: GovernorDataSource;
  as_of_date?: string;
  /** v2: 启用 Carver 连续 multiplier (不分档) + buffer zone 防频繁切换 */
  use_carver_continuous?: boolean;
  /** v2 only: buffer width (默认 0.08) — multiplier 改变 < buffer 时不调整 */
  buffer_width?: number;
}

export interface EvaluateResult {
  portfolio_id: number;
  user_id: number;
  as_of_date: string;
  tier: GovernorHealthTier;
  kelly_multiplier: number;
  previous_tier: GovernorHealthTier | null;
  tier_changed: boolean;
  trigger_reason: string;
  stats: PortfolioStats;
  summary: string;
  persisted_id: number | null;
}

// ============================================================
// Pure helpers (full export)
// ============================================================

/**
 * 从 30 日 total_value snapshot 计算 30d sharpe
 *   - daily_returns = (V[i] / V[i-1]) - 1
 *   - sharpe = mean / std × sqrt(252)
 *   - < 5 个有效收益 → null
 */
export function computeRecentSharpe(
  snapshots: Array<{ date: string; total_value: number }>
): number | null {
  if (!snapshots || snapshots.length < 6) return null;
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const returns: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = Number(sorted[i - 1].total_value);
    const curr = Number(sorted[i].total_value);
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
      returns.push(curr / prev - 1);
    }
  }
  if (returns.length < 5) return null;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (returns.length - 1);
  const std = Math.sqrt(Math.max(variance, 1e-12));
  if (std === 0) return null;
  return (mean / std) * Math.sqrt(252);
}

/**
 * 计算当前回撤 = (peak - current) / peak
 *   - peak = max(snapshots.total_value)
 *   - current = 最后一条 snapshot.total_value
 *   - peak ≤ 0 → null
 *   - returns 正数（e.g. 0.125 = 12.5%）
 */
export function computeCurrentDrawdown(
  snapshots: Array<{ date: string; total_value: number }>
): number | null {
  if (!snapshots || snapshots.length === 0) return null;
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const values = sorted.map(s => Number(s.total_value)).filter(v => Number.isFinite(v) && v > 0);
  if (values.length === 0) return null;
  const peak = Math.max(...values);
  const current = values[values.length - 1];
  if (peak <= 0) return null;
  return Math.max(0, (peak - current) / peak);
}

/**
 * 算 30 日 win_rate
 *   - winning_trades / total_trades
 *   - total_trades = 0 → null
 */
export function computeRecentWinrate(trades: Array<{ pnl: number }>): number | null {
  if (!trades || trades.length === 0) return null;
  const valid = trades.filter(t => Number.isFinite(t.pnl));
  if (valid.length === 0) return null;
  const wins = valid.filter(t => t.pnl > 0).length;
  return wins / valid.length;
}

/**
 * 主决策：根据 stats + thresholds 返回 tier + trigger_reason
 */
export function deriveTier(
  stats: PortfolioStats,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS
): { tier: GovernorHealthTier; trigger_reason: string } {
  const { drawdown_current, sharpe_30d, winrate_30d } = stats;

  // observe_only
  if (drawdown_current !== null && drawdown_current >= thresholds.drawdown_observe_only) {
    return {
      tier: 'observe_only',
      trigger_reason: `drawdown=${(drawdown_current * 100).toFixed(1)}% ≥ ${(
        thresholds.drawdown_observe_only * 100
      ).toFixed(0)}%`,
    };
  }
  if (sharpe_30d !== null && sharpe_30d <= thresholds.sharpe_observe_only) {
    return {
      tier: 'observe_only',
      trigger_reason: `30d sharpe=${sharpe_30d.toFixed(2)} ≤ ${thresholds.sharpe_observe_only}`,
    };
  }

  // critical
  if (drawdown_current !== null && drawdown_current >= thresholds.drawdown_critical) {
    return {
      tier: 'critical',
      trigger_reason: `drawdown=${(drawdown_current * 100).toFixed(1)}% ≥ ${(
        thresholds.drawdown_critical * 100
      ).toFixed(0)}%`,
    };
  }
  if (sharpe_30d !== null && sharpe_30d <= thresholds.sharpe_critical) {
    return {
      tier: 'critical',
      trigger_reason: `30d sharpe=${sharpe_30d.toFixed(2)} ≤ ${thresholds.sharpe_critical}`,
    };
  }
  if (winrate_30d !== null && winrate_30d <= thresholds.winrate_critical) {
    return {
      tier: 'critical',
      trigger_reason: `30d win_rate=${(winrate_30d * 100).toFixed(0)}% ≤ ${(
        thresholds.winrate_critical * 100
      ).toFixed(0)}%`,
    };
  }

  // defensive
  if (drawdown_current !== null && drawdown_current >= thresholds.drawdown_defensive) {
    return {
      tier: 'defensive',
      trigger_reason: `drawdown=${(drawdown_current * 100).toFixed(1)}% ≥ ${(
        thresholds.drawdown_defensive * 100
      ).toFixed(0)}%`,
    };
  }
  if (sharpe_30d !== null && sharpe_30d <= thresholds.sharpe_defensive) {
    return {
      tier: 'defensive',
      trigger_reason: `30d sharpe=${sharpe_30d.toFixed(2)} ≤ ${thresholds.sharpe_defensive}`,
    };
  }
  if (winrate_30d !== null && winrate_30d <= thresholds.winrate_defensive) {
    return {
      tier: 'defensive',
      trigger_reason: `30d win_rate=${(winrate_30d * 100).toFixed(0)}% ≤ ${(
        thresholds.winrate_defensive * 100
      ).toFixed(0)}%`,
    };
  }

  // cautious
  if (drawdown_current !== null && drawdown_current >= thresholds.drawdown_cautious) {
    return {
      tier: 'cautious',
      trigger_reason: `drawdown=${(drawdown_current * 100).toFixed(1)}% ≥ ${(
        thresholds.drawdown_cautious * 100
      ).toFixed(0)}%`,
    };
  }
  if (sharpe_30d !== null && sharpe_30d <= thresholds.sharpe_cautious) {
    return {
      tier: 'cautious',
      trigger_reason: `30d sharpe=${sharpe_30d.toFixed(2)} ≤ ${thresholds.sharpe_cautious}`,
    };
  }
  if (winrate_30d !== null && winrate_30d <= thresholds.winrate_cautious) {
    return {
      tier: 'cautious',
      trigger_reason: `30d win_rate=${(winrate_30d * 100).toFixed(0)}% ≤ ${(
        thresholds.winrate_cautious * 100
      ).toFixed(0)}%`,
    };
  }

  return {
    tier: 'healthy',
    trigger_reason: '所有指标在健康范围',
  };
}

/**
 * 生成自然语言总结
 */
export function buildGovernorSummary(input: {
  tier: GovernorHealthTier;
  multiplier: number;
  trigger_reason: string;
  tier_changed: boolean;
  previous_tier: GovernorHealthTier | null;
  stats: PortfolioStats;
}): string {
  const { tier, multiplier, trigger_reason, tier_changed, previous_tier, stats } = input;
  const icon =
    tier === 'healthy'
      ? '✅'
      : tier === 'cautious'
      ? '🟢'
      : tier === 'defensive'
      ? '🟡'
      : tier === 'critical'
      ? '🟠'
      : '🔴';
  const change = tier_changed && previous_tier ? ` (从 ${previous_tier} 切换)` : '';
  const statsPart: string[] = [];
  if (stats.sharpe_30d !== null) statsPart.push(`sharpe30d=${stats.sharpe_30d.toFixed(2)}`);
  if (stats.drawdown_current !== null)
    statsPart.push(`dd=${(stats.drawdown_current * 100).toFixed(1)}%`);
  if (stats.winrate_30d !== null) statsPart.push(`wr30d=${(stats.winrate_30d * 100).toFixed(0)}%`);
  return `${icon} ${tier} (×${multiplier})${change} — ${trigger_reason} | ${statsPart.join(' / ')}`;
}

// ============================================================
// DataSource
// ============================================================

export const PRODUCTION_GOVERNOR_DATA_SOURCE: GovernorDataSource = {
  async loadAllPortfolios() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPortfolio } = require('../../models/PaperTradingPortfolio');
      const rows = await PaperTradingPortfolio.findAll({ attributes: ['id', 'user_id'] });
      return rows.map((r: any) => ({ portfolio_id: r.id, user_id: r.user_id }));
    } catch (err: any) {
      logger.warn(`[governor] loadAllPortfolios failed: ${err?.message}`);
      return [];
    }
  },
  async loadStats(portfolio_id, as_of_date) {
    const result: PortfolioStats = {
      sharpe_30d: null,
      drawdown_current: null,
      winrate_30d: null,
      trades_30d: 0,
      snapshots_count: 0,
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingSnapshot } = require('../../models/PaperTradingSnapshot');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingTrade } = require('../../models/PaperTradingTrade');

      // snapshots
      const sinceSnapshot = new Date();
      sinceSnapshot.setDate(sinceSnapshot.getDate() - SHARPE_LOOKBACK_DAYS - 5);
      const sinceStrSnap = sinceSnapshot.toISOString().slice(0, 10);

      const snaps = await PaperTradingSnapshot.findAll({
        where: {
          portfolio_id,
          snapshot_date: { [Op.gte]: sinceStrSnap, [Op.lte]: as_of_date },
        },
        order: [['snapshot_date', 'ASC']],
      });
      const snapshotInput = snaps.map((s: any) => ({
        date: s.snapshot_date,
        total_value: Number(s.total_value),
      }));
      result.snapshots_count = snapshotInput.length;
      result.sharpe_30d = computeRecentSharpe(snapshotInput);
      result.drawdown_current = computeCurrentDrawdown(snapshotInput);

      // trades
      const sinceTrade = new Date();
      sinceTrade.setDate(sinceTrade.getDate() - WINRATE_LOOKBACK_DAYS);
      const trades = await PaperTradingTrade.findAll({
        where: {
          portfolio_id,
          side: 'SELL',
          trade_date: { [Op.gte]: sinceTrade.toISOString().slice(0, 10), [Op.lte]: as_of_date },
        },
        attributes: ['pnl'],
      });
      const tradeInput = trades
        .map((t: any) => ({ pnl: Number(t.pnl) }))
        .filter(t => Number.isFinite(t.pnl));
      result.trades_30d = tradeInput.length;
      result.winrate_30d = computeRecentWinrate(tradeInput);
    } catch (err: any) {
      logger.warn(`[governor] loadStats(${portfolio_id}) failed: ${err?.message}`);
    }
    return result;
  },
  async loadPreviousTier(portfolio_id) {
    try {
      const row = await EquityCurveGovernorState.findOne({
        where: { portfolio_id },
        order: [['created_at', 'DESC']],
      });
      return row ? (row.tier as GovernorHealthTier) : null;
    } catch (err: any) {
      logger.warn(`[governor] loadPreviousTier failed: ${err?.message}`);
      return null;
    }
  },
};

// ============================================================
// Service
// ============================================================

export class EquityCurveGovernorService {
  /** in-process cache: portfolio_id → current tier (for fast multiplier lookup) */
  private tierCache = new Map<number, { tier: GovernorHealthTier; cachedAt: number }>();
  private cacheTtlMs = 300_000; // 5 分钟

  constructor(private dataSource: GovernorDataSource = PRODUCTION_GOVERNOR_DATA_SOURCE) {}

  /**
   * 单 portfolio evaluate
   */
  async evaluatePortfolio(
    portfolio: PortfolioInfo,
    options: EvaluateOptions = {}
  ): Promise<EvaluateResult> {
    const thresholds = options.thresholds ?? DEFAULT_TIER_THRESHOLDS;
    const persist = options.persist !== false;
    const ds = options.data_source ?? this.dataSource;
    const as_of_date = options.as_of_date ?? new Date().toISOString().slice(0, 10);

    const stats = await ds.loadStats(portfolio.portfolio_id, as_of_date);
    const { tier, trigger_reason } = deriveTier(stats, thresholds);
    const previous_tier = await ds.loadPreviousTier(portfolio.portfolio_id);
    const tier_changed = previous_tier !== null && previous_tier !== tier;
    let multiplier = TIER_MULTIPLIERS[tier];

    // v2: Carver 连续 multiplier + buffer zone
    if (options.use_carver_continuous) {
      const rawMult = continuousMultiplier(stats.drawdown_current ?? 0, stats.sharpe_30d);
      // 找上次实际生效的 multiplier (从最近 state row)
      const prevMult = previous_tier ? TIER_MULTIPLIERS[previous_tier] : 1.0;
      multiplier = applyMultiplierBuffer(prevMult, rawMult, options.buffer_width ?? 0.08);
      // 反向推 tier (展示用)：根据 continuous multiplier 落在哪档
      // 不影响 multiplier 值本身
    }

    const summary = buildGovernorSummary({
      tier,
      multiplier,
      trigger_reason,
      tier_changed,
      previous_tier,
      stats,
    });

    const result: EvaluateResult = {
      portfolio_id: portfolio.portfolio_id,
      user_id: portfolio.user_id,
      as_of_date,
      tier,
      kelly_multiplier: multiplier,
      previous_tier,
      tier_changed,
      trigger_reason,
      stats,
      summary,
      persisted_id: null,
    };

    if (persist) {
      try {
        const row = await EquityCurveGovernorState.create({
          portfolio_id: portfolio.portfolio_id,
          user_id: portfolio.user_id,
          as_of_date,
          tier,
          kelly_multiplier: multiplier,
          recent_sharpe_30d: stats.sharpe_30d,
          current_drawdown_pct:
            stats.drawdown_current !== null ? stats.drawdown_current * 100 : null,
          recent_winrate_30d: stats.winrate_30d,
          trigger_reason,
          previous_tier,
          tier_changed,
          summary,
          metadata: {
            trades_30d: stats.trades_30d,
            snapshots_count: stats.snapshots_count,
            thresholds,
          },
        });
        result.persisted_id = row.id;
        // 更新缓存
        this.tierCache.set(portfolio.portfolio_id, { tier, cachedAt: Date.now() });
      } catch (err: any) {
        logger.warn(`[governor] persist failed: ${err?.message}`);
      }
    } else {
      this.tierCache.set(portfolio.portfolio_id, { tier, cachedAt: Date.now() });
    }

    if (tier_changed) {
      logger.info(`[governor] portfolio=${portfolio.portfolio_id} tier ${previous_tier} → ${tier}`);
    }

    return result;
  }

  /**
   * 全部 portfolio evaluate (cron 用)
   */
  async evaluateAll(options: EvaluateOptions = {}): Promise<EvaluateResult[]> {
    const ds = options.data_source ?? this.dataSource;
    const portfolios = await ds.loadAllPortfolios();
    const out: EvaluateResult[] = [];
    for (const p of portfolios) {
      try {
        const r = await this.evaluatePortfolio(p, options);
        out.push(r);
      } catch (err: any) {
        logger.warn(`[governor] evaluatePortfolio(${p.portfolio_id}) failed: ${err?.message}`);
      }
    }
    return out;
  }

  /**
   * Sizing policy 调用入口：返回 Kelly 倍数 ∈ [0, 1]
   *   - 缓存命中 → 直接返回
   *   - 缓存未命中 → 查最新 state row；无 row → 默认 1.0
   */
  async getCurrentMultiplier(portfolio_id: number): Promise<number> {
    const cached = this.tierCache.get(portfolio_id);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return TIER_MULTIPLIERS[cached.tier];
    }
    try {
      const row = await EquityCurveGovernorState.findOne({
        where: { portfolio_id },
        order: [['created_at', 'DESC']],
      });
      if (!row) return 1.0;
      const tier = row.tier as GovernorHealthTier;
      this.tierCache.set(portfolio_id, { tier, cachedAt: Date.now() });
      return TIER_MULTIPLIERS[tier];
    } catch (err: any) {
      logger.warn(`[governor] getCurrentMultiplier(${portfolio_id}) failed: ${err?.message}`);
      return 1.0;
    }
  }

  /**
   * 历史时间序列（UI 用）
   */
  async getHistory(portfolio_id: number, days = 90): Promise<EquityCurveGovernorState[]> {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    return EquityCurveGovernorState.findAll({
      where: { portfolio_id, created_at: { [Op.gte]: since } },
      order: [['created_at', 'ASC']],
      limit: 365,
    });
  }

  async cleanupOlderThan(days: number) {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const deleted = await EquityCurveGovernorState.destroy({
      where: { created_at: { [Op.lt]: cutoff } },
    });
    return { deleted };
  }

  /** 测试用 — 清缓存 */
  clearCache(): void {
    this.tierCache.clear();
  }
}

export const equityCurveGovernorService = new EquityCurveGovernorService();
