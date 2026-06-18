/**
 * DataQualityVerdict — 数据质量判定 (Phase 1 末尾运行, aggregator 用其 coefficient).
 *
 * 规则:
 *   - critical: 缺 daily_bars 或 daily_bars.length < 20 → 不参与, action='hold'.
 *   - degraded: 缺 realtime_quote, 或 factor_snapshot keys < 5.
 *   - partial:  缺 1-2 个 non-critical 字段 (market_env / realtime_quote 等).
 *   - good:     全部齐全.
 *
 * coefficient 乘到 overall_confidence:
 *   good=1.0 / partial=0.85 / degraded=0.7 / critical=0.0
 */

import type { AnalyzerContext, DataQualityLevel, DataQualityVerdict } from './AnalyzerTypes';

export const DATA_QUALITY_COEFFICIENT: Readonly<Record<DataQualityLevel, number>> = Object.freeze({
  good: 1.0,
  partial: 0.85,
  degraded: 0.7,
  critical: 0,
});

export function evaluateDataQuality(ctx: AnalyzerContext): DataQualityVerdict {
  const missing_critical: string[] = [];
  const missing_optional: string[] = [];
  const notes: string[] = [];

  // Critical signals
  if (!Array.isArray(ctx.daily_bars) || ctx.daily_bars.length < 20) {
    missing_critical.push('daily_bars (<20 根)');
  }
  if (!ctx.stock || !ctx.stock.code) {
    missing_critical.push('stock.code');
  }

  // Optional / soft signals
  if (!ctx.realtime_quote) {
    missing_optional.push('realtime_quote');
  }
  if (!ctx.market_env) {
    missing_optional.push('market_env');
  }
  const factorKeys = Object.keys(ctx.factor_snapshot || {});
  if (factorKeys.length === 0) {
    missing_optional.push('factor_snapshot (empty)');
  } else if (factorKeys.length < 5) {
    missing_optional.push(`factor_snapshot (only ${factorKeys.length} factors)`);
  }
  if (!ctx.stock?.industry) {
    missing_optional.push('stock.industry');
  }

  let level: DataQualityLevel;
  if (missing_critical.length > 0) {
    level = 'critical';
    notes.push('关键数据缺失, 引擎仅返回 hold');
  } else if (missing_optional.length >= 3) {
    level = 'degraded';
  } else if (missing_optional.length >= 1) {
    level = 'partial';
  } else {
    level = 'good';
  }

  return {
    level,
    missing_critical,
    missing_optional,
    notes,
    coefficient: DATA_QUALITY_COEFFICIENT[level],
  };
}
