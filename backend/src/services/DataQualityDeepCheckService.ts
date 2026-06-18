/**
 * DataQualityDeepCheckService — Phase 8 数据质量深度检查
 *
 * 用户优先级 #1 — 现有 DataHealthDashboard 只看 14 个 sync source 的"上次跑没跑"
 * 状态；缺真正的"数据完整性、异常、缺口、重复"检查。这个 service 跑批：
 *
 *   1. price_jump_anomaly — close 单日跳变 > 15% (排除涨跌停 ±10%)
 *   2. duplicate_pk_rows — (stock_id, time) 重复行
 *   3. negative_or_zero_close — close <= 0 或 NULL
 *   4. trading_gap_after_resumption — 停牌复牌后 close 跳变 > 30%
 *   5. stale_data — 最近 7 个交易日内 stock 缺日 K 数据 > 3 天
 *
 * 输出按 severity (critical/high/medium/low) 分级，UI 给颜色 + 数量。
 *
 * 设计:
 *   - 5 个独立 check 函数（每个一个 SQL）
 *   - 失败时返该 check error 但不阻塞其他 check
 *   - 缓存 30 分钟（深度检查重，不频繁跑）
 */

import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import { logger } from '../utils/logger';

// ============================================================
// Types
// ============================================================

export type QualitySeverity = 'critical' | 'high' | 'medium' | 'low';

export interface QualityIssue {
  check_name: string;
  severity: QualitySeverity;
  count: number;
  sample: any[]; // 样例 (最多 5 条)
  detail: string;
}

export interface DataQualityReport {
  generated_at: string;
  checked_at: string;
  total_issues: number;
  by_severity: Record<QualitySeverity, number>;
  issues: QualityIssue[];
  errors: Array<{ check_name: string; error: string }>;
  /** UI 总状态: clean / warning / critical */
  overall_status: 'clean' | 'warning' | 'critical';
}

// ============================================================
// 纯函数 (export 单测脱 DB)
// ============================================================

/**
 * 把 issue 集合 → 按 severity 计数。
 */
export function aggregateBySeverity(issues: QualityIssue[]): Record<QualitySeverity, number> {
  const map: Record<QualitySeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) {
    map[i.severity] += i.count;
  }
  return map;
}

/**
 * 根据 by_severity 决定 overall_status。
 *   - critical > 0 → critical
 *   - high > 0 → warning
 *   - 其他 → clean (只 medium/low 也算 clean，可接受)
 */
export function deriveOverallStatus(
  bySeverity: Record<QualitySeverity, number>
): DataQualityReport['overall_status'] {
  if (bySeverity.critical > 0) return 'critical';
  if (bySeverity.high > 0) return 'warning';
  return 'clean';
}

// ============================================================
// Service
// ============================================================

const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: { data: DataQualityReport; ts: number } | null = null;

export class DataQualityDeepCheckService {
  invalidateCache(): void {
    cache = null;
  }

  /**
   * 跑全部 5 个深度检查，返报告。
   *
   * @param lookbackDays 检查最近 N 天 (默认 30)
   */
  async runDeepCheck(lookbackDays = 30): Promise<DataQualityReport> {
    if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
      return cache.data;
    }

    const issues: QualityIssue[] = [];
    const errors: Array<{ check_name: string; error: string }> = [];
    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);

    // ----- 1. price_jump_anomaly -----
    try {
      const rows = (await sequelize.query(
        `
        WITH lagged AS (
          SELECT
            stock_id,
            time::date AS d,
            close,
            LAG(close) OVER (PARTITION BY stock_id ORDER BY time) AS prev_close
          FROM daily_bars
          WHERE time >= :since
        )
        SELECT stock_id, d::date AS trade_date, close, prev_close,
               ABS((close - prev_close) / NULLIF(prev_close, 0)) AS jump_pct
        FROM lagged
        WHERE prev_close > 0
          AND ABS((close - prev_close) / prev_close) > 0.15
        ORDER BY jump_pct DESC
        LIMIT 100
        `,
        { replacements: { since }, type: QueryTypes.SELECT }
      )) as any[];
      if (rows.length > 0) {
        issues.push({
          check_name: 'price_jump_anomaly',
          severity: 'high',
          count: rows.length,
          sample: rows.slice(0, 5).map(r => ({
            stock_id: r.stock_id,
            trade_date:
              typeof r.trade_date === 'string'
                ? r.trade_date
                : new Date(r.trade_date).toISOString().slice(0, 10),
            close: Number(r.close),
            prev_close: Number(r.prev_close),
            jump_pct: Math.round(Number(r.jump_pct) * 10000) / 100,
          })),
          detail: `${rows.length} 条 daily_bar 出现单日 close 跳变 > 15% (排除常规涨跌停)`,
        });
      }
    } catch (err: any) {
      errors.push({ check_name: 'price_jump_anomaly', error: err?.message || String(err) });
    }

    // ----- 2. duplicate_pk_rows -----
    try {
      const rows = (await sequelize.query(
        `
        SELECT stock_id, time, COUNT(*)::int AS cnt
        FROM daily_bars
        WHERE time >= :since
        GROUP BY stock_id, time
        HAVING COUNT(*) > 1
        LIMIT 50
        `,
        { replacements: { since }, type: QueryTypes.SELECT }
      )) as any[];
      if (rows.length > 0) {
        issues.push({
          check_name: 'duplicate_pk_rows',
          severity: 'critical',
          count: rows.length,
          sample: rows.slice(0, 5),
          detail: `${rows.length} 个 (stock_id, time) 组合在 daily_bars 表中重复 (违反 PK 唯一性预期)`,
        });
      }
    } catch (err: any) {
      errors.push({ check_name: 'duplicate_pk_rows', error: err?.message || String(err) });
    }

    // ----- 3. negative_or_zero_close -----
    try {
      const rows = (await sequelize.query(
        `
        SELECT stock_id, time, close
        FROM daily_bars
        WHERE time >= :since AND (close <= 0 OR close IS NULL)
        LIMIT 50
        `,
        { replacements: { since }, type: QueryTypes.SELECT }
      )) as any[];
      if (rows.length > 0) {
        issues.push({
          check_name: 'negative_or_zero_close',
          severity: 'critical',
          count: rows.length,
          sample: rows.slice(0, 5),
          detail: `${rows.length} 条 close <= 0 或 NULL 的非法 bar`,
        });
      }
    } catch (err: any) {
      errors.push({ check_name: 'negative_or_zero_close', error: err?.message || String(err) });
    }

    // ----- 4. trading_gap_after_resumption -----
    // 简化定义: 同 stock 相邻两条 bar 时间间隔 > 7 天 且 close 跳变 > 30%
    try {
      const rows = (await sequelize.query(
        `
        WITH lagged AS (
          SELECT
            stock_id,
            time,
            close,
            LAG(time) OVER (PARTITION BY stock_id ORDER BY time) AS prev_time,
            LAG(close) OVER (PARTITION BY stock_id ORDER BY time) AS prev_close
          FROM daily_bars
          WHERE time >= :since
        )
        SELECT stock_id, time::date AS trade_date, close, prev_close, prev_time::date AS prev_date,
               EXTRACT(DAY FROM (time - prev_time)) AS gap_days
        FROM lagged
        WHERE prev_close > 0
          AND prev_time IS NOT NULL
          AND EXTRACT(DAY FROM (time - prev_time)) > 7
          AND ABS((close - prev_close) / prev_close) > 0.30
        ORDER BY ABS((close - prev_close) / prev_close) DESC
        LIMIT 50
        `,
        { replacements: { since }, type: QueryTypes.SELECT }
      )) as any[];
      if (rows.length > 0) {
        issues.push({
          check_name: 'trading_gap_after_resumption',
          severity: 'medium',
          count: rows.length,
          sample: rows.slice(0, 5).map(r => ({
            stock_id: r.stock_id,
            resumed_date:
              typeof r.trade_date === 'string'
                ? r.trade_date
                : new Date(r.trade_date).toISOString().slice(0, 10),
            gap_days: Number(r.gap_days),
            close: Number(r.close),
            prev_close: Number(r.prev_close),
            jump_pct: Math.round(((r.close - r.prev_close) / r.prev_close) * 10000) / 100,
          })),
          detail: `${rows.length} 只股票停牌复牌 (> 7 日) 且复牌后 close 跳变 > 30%`,
        });
      }
    } catch (err: any) {
      errors.push({
        check_name: 'trading_gap_after_resumption',
        error: err?.message || String(err),
      });
    }

    // ----- 5. stale_data -----
    // 最近 7 个交易日内, 某 stock 缺日 K > 3 天 (说明同步问题或长期停牌)
    try {
      const recentSince = new Date();
      recentSince.setDate(recentSince.getDate() - 7);
      const rows = (await sequelize.query(
        `
        WITH active_stocks AS (
          SELECT DISTINCT s.id, s.symbol, s.name
          FROM stocks s
          WHERE s.is_listed = true
        ),
        trading_days AS (
          SELECT DISTINCT time::date AS d
          FROM daily_bars
          WHERE time >= :since
        ),
        stock_days AS (
          SELECT DISTINCT db.stock_id, db.time::date AS d
          FROM daily_bars db
          WHERE db.time >= :since
        ),
        expected AS (
          SELECT (SELECT COUNT(*) FROM trading_days)::int AS total_days
        ),
        per_stock AS (
          SELECT
            s.id AS stock_id,
            s.symbol,
            s.name,
            COUNT(sd.d)::int AS days_present,
            (SELECT total_days FROM expected) AS total_days
          FROM active_stocks s
          LEFT JOIN stock_days sd ON sd.stock_id = s.id
          GROUP BY s.id, s.symbol, s.name
        )
        SELECT stock_id, symbol, name, days_present, total_days,
               (total_days - days_present) AS missing_days
        FROM per_stock
        WHERE total_days - days_present > 3
          AND total_days > 0
        ORDER BY (total_days - days_present) DESC
        LIMIT 50
        `,
        { replacements: { since: recentSince }, type: QueryTypes.SELECT }
      )) as any[];
      if (rows.length > 0) {
        issues.push({
          check_name: 'stale_data',
          severity: 'low',
          count: rows.length,
          sample: rows.slice(0, 5).map(r => ({
            stock_id: r.stock_id,
            symbol: r.symbol,
            name: r.name,
            missing_days: Number(r.missing_days),
            days_present: Number(r.days_present),
            total_days: Number(r.total_days),
          })),
          detail: `${rows.length} 只 listed stock 在最近 7 个交易日内缺 K 线数据 > 3 天 (可能停牌或同步遗漏)`,
        });
      }
    } catch (err: any) {
      errors.push({ check_name: 'stale_data', error: err?.message || String(err) });
    }

    const bySeverity = aggregateBySeverity(issues);
    const overallStatus = deriveOverallStatus(bySeverity);
    const totalIssues = issues.reduce((s, i) => s + i.count, 0);

    const report: DataQualityReport = {
      generated_at: new Date().toISOString(),
      checked_at: new Date().toISOString(),
      total_issues: totalIssues,
      by_severity: bySeverity,
      issues,
      errors,
      overall_status: overallStatus,
    };

    cache = { data: report, ts: Date.now() };
    return report;
  }
}

export const dataQualityDeepCheckService = new DataQualityDeepCheckService();
