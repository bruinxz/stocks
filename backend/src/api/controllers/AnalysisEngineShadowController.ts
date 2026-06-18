/**
 * AnalysisEngineShadowController — GAMMA 2026-06-18
 *
 * Admin-only endpoints for analysis-engine v1 shadow dashboard.
 *
 * 仅返回 shadow rows (engine_variant='multi_dim_v1') 的统计聚合;
 * 不暴露任何 user-level / per-stock 决策细节给非 admin.
 *
 * Endpoints:
 *   GET /api/admin/analysis-engine/shadow-stats?since=YYYY-MM-DD
 *     → { consistency_rate, analyzer_health[], forward_return_5d }
 */

import { Request, Response } from 'express';
import { logger } from '../../utils/logger';

export class AnalysisEngineShadowController {
  /**
   * GET /api/admin/analysis-engine/shadow-stats
   *
   * Query:
   *   - since=YYYY-MM-DD (默认 7 天前)
   *
   * Response:
   *   {
   *     since: '2026-06-11',
   *     total_shadow_reports: number,
   *     consistency_rate: { buy_class, hold_class, sell_class, overall },
   *     analyzer_health: [{ key, error_rate, mean_confidence, data_missing_rate }],
   *     forward_return_5d: { samples: number, mean_pct: number | null }
   *   }
   */
  getShadowStats = async (req: Request, res: Response): Promise<Response> => {
    try {
      const sinceStr = (req.query.since as string) || '';
      const since = sinceStr
        ? new Date(`${sinceStr}T00:00:00.000Z`)
        : new Date(Date.now() - 7 * 24 * 3600 * 1000);
      if (Number.isNaN(since.getTime())) {
        return res.status(400).json({ ok: false, error: 'invalid since (expect YYYY-MM-DD)' });
      }

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AIStockAnalysisReport } = require('../../models/AIStockAnalysisReport');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');

      const shadowRows = (await AIStockAnalysisReport.findAll({
        where: {
          engine_variant: 'multi_dim_v1',
          generated_at: { [Op.gte]: since },
        },
        attributes: [
          'report_id',
          'stock_code',
          'recommendation',
          'confidence_score',
          'shadow_of_report_id',
          'key_points_json',
          'generated_at',
        ],
        raw: true,
        limit: 5000,
      })) as Array<{
        report_id: string;
        stock_code: string;
        recommendation: string;
        confidence_score: number | null;
        shadow_of_report_id: string | null;
        key_points_json: any;
        generated_at: Date;
      }>;

      const prodReportIds = shadowRows
        .map(r => r.shadow_of_report_id)
        .filter((s): s is string => !!s);
      const prodRows: Array<{ report_id: string; recommendation: string }> =
        prodReportIds.length === 0
          ? []
          : ((await AIStockAnalysisReport.findAll({
              where: { report_id: prodReportIds },
              attributes: ['report_id', 'recommendation'],
              raw: true,
            })) as any[]);
      const prodMap = new Map<string, string>();
      for (const p of prodRows) prodMap.set(p.report_id, p.recommendation);

      const consistency = computeConsistency(shadowRows, prodMap);
      const analyzerHealth = computeAnalyzerHealth(shadowRows);

      return res.json({
        ok: true,
        data: {
          since: since.toISOString().slice(0, 10),
          total_shadow_reports: shadowRows.length,
          consistency_rate: consistency,
          analyzer_health: analyzerHealth,
          // forward_return_5d: 需要 join AIInvestmentSignal.forward_returns (v1 不 join,
          // 因为 shadow 路径 v1 不写 signal row; 留给 hard 阶段). 暂返回占位.
          forward_return_5d: { samples: 0, mean_pct: null, note: 'requires hard-mode signals' },
        },
      });
    } catch (e: any) {
      logger.warn(`[analysis-engine.shadow-stats] failed: ${e?.message || e}`);
      return res.status(500).json({ ok: false, error: e?.message || 'internal' });
    }
  };
}

const BUY_CLASS = new Set(['strong_buy', 'buy', 'add', 'buy_class']);
const SELL_CLASS = new Set(['sell', 'strong_sell', 'reduce']);

function bucket(action: string): 'buy_class' | 'sell_class' | 'hold_class' {
  if (BUY_CLASS.has(action)) return 'buy_class';
  if (SELL_CLASS.has(action)) return 'sell_class';
  return 'hold_class';
}

function computeConsistency(
  shadow: Array<{ recommendation: string; shadow_of_report_id: string | null }>,
  prodMap: Map<string, string>
): { buy_class: number; sell_class: number; hold_class: number; overall: number } {
  const buckets: Record<
    'buy_class' | 'sell_class' | 'hold_class',
    { total: number; match: number }
  > = {
    buy_class: { total: 0, match: 0 },
    sell_class: { total: 0, match: 0 },
    hold_class: { total: 0, match: 0 },
  };
  let totalMatch = 0;
  let totalCompared = 0;
  for (const s of shadow) {
    if (!s.shadow_of_report_id) continue;
    const prod = prodMap.get(s.shadow_of_report_id);
    if (!prod) continue;
    const sb = bucket(s.recommendation);
    const pb = bucket(prod);
    buckets[sb].total += 1;
    if (sb === pb) buckets[sb].match += 1;
    totalCompared += 1;
    if (sb === pb) totalMatch += 1;
  }
  const ratio = (b: { total: number; match: number }): number =>
    b.total > 0 ? Math.round((b.match / b.total) * 1000) / 1000 : 0;
  return {
    buy_class: ratio(buckets.buy_class),
    sell_class: ratio(buckets.sell_class),
    hold_class: ratio(buckets.hold_class),
    overall: totalCompared > 0 ? Math.round((totalMatch / totalCompared) * 1000) / 1000 : 0,
  };
}

function computeAnalyzerHealth(shadow: Array<{ key_points_json: any }>): Array<{
  key: string;
  error_rate: number;
  mean_confidence: number;
  data_missing_rate: number;
  samples: number;
}> {
  const stats = new Map<
    string,
    { samples: number; errors: number; confidence_sum: number; missing_sum: number }
  >();
  for (const r of shadow) {
    const dims = r.key_points_json?.per_dimension;
    if (!Array.isArray(dims)) continue;
    for (const d of dims as Array<{
      analyzer_key?: string;
      confidence?: number;
      error?: { code: string } | null;
      data_missing?: string[];
    }>) {
      if (!d.analyzer_key) continue;
      const cur = stats.get(d.analyzer_key) || {
        samples: 0,
        errors: 0,
        confidence_sum: 0,
        missing_sum: 0,
      };
      cur.samples += 1;
      if (d.error) cur.errors += 1;
      cur.confidence_sum += Number(d.confidence) || 0;
      cur.missing_sum += Array.isArray(d.data_missing) ? d.data_missing.length : 0;
      stats.set(d.analyzer_key, cur);
    }
  }
  const out: Array<{
    key: string;
    error_rate: number;
    mean_confidence: number;
    data_missing_rate: number;
    samples: number;
  }> = [];
  for (const [key, s] of stats.entries()) {
    out.push({
      key,
      samples: s.samples,
      error_rate: s.samples > 0 ? Math.round((s.errors / s.samples) * 1000) / 1000 : 0,
      mean_confidence: s.samples > 0 ? Math.round((s.confidence_sum / s.samples) * 1000) / 1000 : 0,
      data_missing_rate: s.samples > 0 ? Math.round((s.missing_sum / s.samples) * 1000) / 1000 : 0,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export const analysisEngineShadowController = new AnalysisEngineShadowController();
