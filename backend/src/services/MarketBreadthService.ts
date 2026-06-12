/**
 * MarketBreadthService — Phase 8 全市场宽度指标
 *
 * 用户优先级 #8 — 市场"涨家数/跌家数/上涨占比"等 breadth 指标，让用户在
 * 入场前快速判断全市场情绪（不只是指数）。
 *
 * 数据源: 所有 A 股 daily bar，按 trade_date 聚合，计算：
 *
 *   1. advancers_count: 当日收涨股票数 (close > prev_close)
 *   2. decliners_count: 当日收跌股票数 (close < prev_close)
 *   3. unchanged_count: 持平股票数
 *   4. advance_decline_ratio: advancers / decliners (>1 偏强, <0.5 偏弱)
 *   5. advancer_pct: advancers / total (% 上涨占比)
 *   6. limit_up_count: 涨停板股票数 (从 limit_up_stocks 表)
 *   7. limit_down_count: 跌停板股票数
 *   8. new_60d_high_count: 突破 60d 高股票数
 *   9. new_60d_low_count: 跌破 60d 低股票数
 *   10. median_return_pct: 全市场中位数收益（防 outlier 误导平均）
 *
 * 设计:
 *   - 1 个 SQL 聚合查询（避免 5000+ 股票 in-memory 循环）
 *   - 缓存 5 分钟（breadth 一天内不会快速变化）
 *   - 返回 7 日序列 (用户可看 trend)
 */

import { Op, QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import { logger } from '../utils/logger';

// ============================================================
// Types
// ============================================================

export interface BreadthSnapshot {
  trade_date: string;
  advancers_count: number;
  decliners_count: number;
  unchanged_count: number;
  total_count: number;
  advance_decline_ratio: number | null;
  advancer_pct: number;
  limit_up_count: number;
  limit_down_count: number;
  new_60d_high_count: number;
  new_60d_low_count: number;
  median_return_pct: number | null;
  /** 综合 breadth 健康度: -100 (极弱) ~ 100 (极强) */
  breadth_score: number;
  /** UI 标签 */
  level: 'strong' | 'mild_strong' | 'neutral' | 'mild_weak' | 'weak';
}

export interface MarketBreadthReport {
  generated_at: string;
  /** 最新一日 snapshot */
  latest: BreadthSnapshot;
  /** 最近 N 日序列（按日期升序） */
  trend: BreadthSnapshot[];
  /** 用户可读的 1 句汇总 */
  summary_message: string;
}

// ============================================================
// 纯函数 (export 单测脱 DB)
// ============================================================

/**
 * 算 advance/decline ratio。decliners=0 时返大数 (>10 表示完全单边)，
 * 双 0 时 null。
 */
export function computeAdvanceDeclineRatio(
  advancers: number,
  decliners: number
): number | null {
  if (advancers === 0 && decliners === 0) return null;
  if (decliners === 0) return advancers > 0 ? 99 : null;
  return advancers / decliners;
}

/**
 * 计算 breadth_score (-100 ~ 100)。
 *
 * 加权:
 *   - 50% advancer_pct (50% 中性, > 60% 强, < 40% 弱)
 *   - 25% advance_decline_ratio (1 中性, > 2 强, < 0.5 弱)
 *   - 15% 60d_high vs 60d_low (新高家数远大于新低 → +)
 *   - 10% 涨停 vs 跌停
 */
export function computeBreadthScore(snap: {
  advancer_pct: number;
  advance_decline_ratio: number | null;
  new_60d_high_count: number;
  new_60d_low_count: number;
  limit_up_count: number;
  limit_down_count: number;
}): number {
  // (1) advancer_pct (50%)
  // map [0.4, 0.6] → [-30, 30]，外面线性
  const advanceScore = Math.max(-50, Math.min(50, (snap.advancer_pct - 0.5) * 250));

  // (2) AD ratio (25%)
  let adScore = 0;
  if (snap.advance_decline_ratio !== null) {
    if (snap.advance_decline_ratio >= 1) {
      // 1 → 0, 2 → 12.5, ≥3 → 25
      adScore = Math.min(25, (snap.advance_decline_ratio - 1) * 12.5);
    } else {
      // 0.5 → -12.5, 0.25 → -18, 0 → -25
      adScore = Math.max(-25, (snap.advance_decline_ratio - 1) * 50);
    }
  }

  // (3) new_high vs new_low (15%)
  const hlDiff = snap.new_60d_high_count - snap.new_60d_low_count;
  const hlScore = Math.max(-15, Math.min(15, hlDiff / 4));

  // (4) limit_up vs limit_down (10%)
  const luDiff = snap.limit_up_count - snap.limit_down_count;
  const luScore = Math.max(-10, Math.min(10, luDiff / 3));

  return Math.round(advanceScore + adScore + hlScore + luScore);
}

/**
 * 根据 breadth_score 决定标签 level。
 */
export function scoreToLevel(score: number): BreadthSnapshot['level'] {
  if (score >= 50) return 'strong';
  if (score >= 20) return 'mild_strong';
  if (score >= -20) return 'neutral';
  if (score >= -50) return 'mild_weak';
  return 'weak';
}

/**
 * 生成 1 句中文 summary。
 */
export function buildSummaryMessage(latest: BreadthSnapshot): string {
  const advPct = (latest.advancer_pct * 100).toFixed(1);
  const adRatio = latest.advance_decline_ratio?.toFixed(2) || '—';
  const luLd = `涨停 ${latest.limit_up_count} / 跌停 ${latest.limit_down_count}`;
  const newHL = `新高 ${latest.new_60d_high_count} / 新低 ${latest.new_60d_low_count}`;
  const levelTag: Record<string, string> = {
    strong: '🟢 全市场强势',
    mild_strong: '🟢 偏强',
    neutral: '⚪ 中性',
    mild_weak: '🟠 偏弱',
    weak: '🔴 全市场弱势',
  };
  return (
    `${levelTag[latest.level] || '—'} (score=${latest.breadth_score}) · ` +
    `${latest.trade_date}: 上涨占比 ${advPct}% · A/D=${adRatio} · ` +
    `${luLd} · ${newHL}`
  );
}

// ============================================================
// Service
// ============================================================

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { data: MarketBreadthReport; ts: number } | null = null;

export class MarketBreadthService {
  /** 强制清缓存 */
  invalidateCache(): void {
    cache = null;
  }

  /**
   * 拉最近 N 天的全市场 breadth 报告。
   *
   * @param days 回看天数（默认 7，max 30）
   */
  async getReport(days = 7): Promise<MarketBreadthReport> {
    const lookback = Math.max(1, Math.min(30, Math.floor(days)));

    // 缓存命中
    if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
      return cache.data;
    }

    const since = new Date();
    since.setDate(since.getDate() - lookback - 5); // 多 5 天 buffer 算 60d_high

    try {
      // 1. 聚合 advance/decline + median 一次 SQL 拿出
      //    用 LAG 拿 prev_close 算 daily return + 涨跌判定
      const rows = (await sequelize.query(
        `
        WITH daily_returns AS (
          SELECT
            time::date AS trade_date,
            stock_id,
            close,
            LAG(close) OVER (PARTITION BY stock_id ORDER BY time) AS prev_close
          FROM daily_bars
          WHERE time >= :since
        ),
        classified AS (
          SELECT
            trade_date,
            stock_id,
            close,
            prev_close,
            CASE
              WHEN prev_close IS NULL OR prev_close <= 0 THEN NULL
              ELSE (close - prev_close) / prev_close
            END AS return_pct
          FROM daily_returns
        )
        SELECT
          trade_date,
          COUNT(*) FILTER (WHERE return_pct > 0)::int AS advancers,
          COUNT(*) FILTER (WHERE return_pct < 0)::int AS decliners,
          COUNT(*) FILTER (WHERE return_pct = 0)::int AS unchanged,
          COUNT(*) FILTER (WHERE return_pct IS NOT NULL)::int AS total,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY return_pct) AS median_return
        FROM classified
        WHERE return_pct IS NOT NULL
        GROUP BY trade_date
        ORDER BY trade_date DESC
        LIMIT :lookback
        `,
        {
          replacements: { since, lookback },
          type: QueryTypes.SELECT,
        }
      )) as any[];

      if (rows.length === 0) {
        // 数据空 → 返保守报告
        const empty: BreadthSnapshot = {
          trade_date: new Date().toISOString().slice(0, 10),
          advancers_count: 0,
          decliners_count: 0,
          unchanged_count: 0,
          total_count: 0,
          advance_decline_ratio: null,
          advancer_pct: 0,
          limit_up_count: 0,
          limit_down_count: 0,
          new_60d_high_count: 0,
          new_60d_low_count: 0,
          median_return_pct: null,
          breadth_score: 0,
          level: 'neutral',
        };
        return {
          generated_at: new Date().toISOString(),
          latest: empty,
          trend: [],
          summary_message: '⚪ 中性 (无数据)',
        };
      }

      // 2. 涨停 / 跌停 / new_60d_high / new_60d_low 单独查 (limit_up_stocks 表 + 60d 数据)
      const tradeDates = rows.map(r => r.trade_date);
      const limitUpRows = (await sequelize.query(
        `SELECT trade_date::date AS trade_date,
                COUNT(*) FILTER (WHERE type = 'up')::int AS limit_up,
                COUNT(*) FILTER (WHERE type = 'down')::int AS limit_down
         FROM limit_up_stocks
         WHERE trade_date::date = ANY(:dates)
         GROUP BY trade_date`,
        { replacements: { dates: tradeDates }, type: QueryTypes.SELECT }
      ).catch(() => [])) as any[];
      const luMap = new Map<string, { up: number; down: number }>();
      for (const r of limitUpRows) {
        const dateStr = typeof r.trade_date === 'string'
          ? r.trade_date
          : new Date(r.trade_date).toISOString().slice(0, 10);
        luMap.set(dateStr, { up: Number(r.limit_up || 0), down: Number(r.limit_down || 0) });
      }

      // 3. 60-day new high / new low (粗略：count(close = max(close in last 60d)))
      // 简化：只对最近日算 (避免 60×N 复杂度)；trend 中其他日新高新低留 0
      const latestDate = rows[0].trade_date;
      const since60 = new Date(latestDate);
      since60.setDate(since60.getDate() - 90); // 60d trading days ≈ 90 calendar
      const hlRows = (await sequelize.query(
        `
        WITH bars60 AS (
          SELECT stock_id, time::date AS d, close
          FROM daily_bars
          WHERE time >= :since60 AND time::date <= :latest
        ),
        ranks AS (
          SELECT stock_id, d, close,
                 ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY close DESC) AS rk_high,
                 ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY close ASC) AS rk_low,
                 ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY d DESC) AS rk_latest
          FROM bars60
        )
        SELECT
          COUNT(*) FILTER (WHERE rk_latest = 1 AND rk_high = 1)::int AS new_high,
          COUNT(*) FILTER (WHERE rk_latest = 1 AND rk_low = 1)::int AS new_low
        FROM ranks
        `,
        { replacements: { since60, latest: latestDate }, type: QueryTypes.SELECT }
      ).catch(() => [{ new_high: 0, new_low: 0 }])) as any[];
      const newHigh = Number(hlRows[0]?.new_high || 0);
      const newLow = Number(hlRows[0]?.new_low || 0);

      // 4. 组装 snapshots
      const snapshots: BreadthSnapshot[] = rows.map((r, idx) => {
        const tradeDateStr = typeof r.trade_date === 'string'
          ? r.trade_date
          : new Date(r.trade_date).toISOString().slice(0, 10);
        const advancers = Number(r.advancers || 0);
        const decliners = Number(r.decliners || 0);
        const unchanged = Number(r.unchanged || 0);
        const total = Number(r.total || 0);
        const ad = computeAdvanceDeclineRatio(advancers, decliners);
        const advPct = total > 0 ? advancers / total : 0;
        const lu = luMap.get(tradeDateStr) || { up: 0, down: 0 };
        // new_high/low 只算最新日 (idx=0)；其他日 留 0
        const nh = idx === 0 ? newHigh : 0;
        const nl = idx === 0 ? newLow : 0;
        const score = computeBreadthScore({
          advancer_pct: advPct,
          advance_decline_ratio: ad,
          new_60d_high_count: nh,
          new_60d_low_count: nl,
          limit_up_count: lu.up,
          limit_down_count: lu.down,
        });
        return {
          trade_date: tradeDateStr,
          advancers_count: advancers,
          decliners_count: decliners,
          unchanged_count: unchanged,
          total_count: total,
          advance_decline_ratio: ad ? Math.round(ad * 100) / 100 : null,
          advancer_pct: Math.round(advPct * 1000) / 1000,
          limit_up_count: lu.up,
          limit_down_count: lu.down,
          new_60d_high_count: nh,
          new_60d_low_count: nl,
          median_return_pct:
            r.median_return !== null && Number.isFinite(Number(r.median_return))
              ? Math.round(Number(r.median_return) * 10000) / 100 // → %
              : null,
          breadth_score: score,
          level: scoreToLevel(score),
        };
      });

      // trend ASC + latest 是最近一日
      const trend = snapshots.slice().reverse();
      const latest = snapshots[0];

      const report: MarketBreadthReport = {
        generated_at: new Date().toISOString(),
        latest,
        trend,
        summary_message: buildSummaryMessage(latest),
      };

      cache = { data: report, ts: Date.now() };
      return report;
    } catch (err: any) {
      logger.error(`[MarketBreadth] getReport failed: ${err?.message || err}`);
      throw err;
    }
  }
}

export const marketBreadthService = new MarketBreadthService();
