/**
 * SignalEngine — public facade for signal generation and fusion auditing.
 * Controllers MUST only import from here (and the 4 other public facades).
 */
import { quantSignalService } from '../engine/internal/QuantSignalService';
import { quantFusionAuditService } from '../engine/internal/QuantFusionAuditService';

export class SignalEngine {
  generate(options: any) {
    return quantSignalService.generateSignals(options);
  }

  list(query: any) {
    return quantSignalService.listSignals(query);
  }

  getRankingDashboard(options: { trade_date?: string; limit?: number }) {
    return quantSignalService.getRankingDashboard(options);
  }

  // ---- fusion audits ---------------------------------------------------
  listAudits(query: any) {
    return quantFusionAuditService.listAudits(query);
  }

  getFusionRankingDashboard(options: { signal_date?: string; limit?: number }) {
    return quantFusionAuditService.getRankingDashboard(options);
  }

  /**
   * Compose the rankings response previously assembled inline by QuantController.getRankings().
   * Kept here so the controller stays a thin adapter over the 5 public facades.
   */
  async getRankings(options: { trade_date?: string; signal_date?: string; limit?: number }) {
    const limit = options.limit ?? 30;
    const [quantDashboard, fusionDashboard] = await Promise.all([
      quantSignalService.getRankingDashboard({
        trade_date: options.trade_date,
        limit,
      }),
      quantFusionAuditService.getRankingDashboard({
        signal_date: options.signal_date || options.trade_date,
        limit,
      }),
    ]);
    const quantSummary: any = quantDashboard.summary || {};
    const fusionSummary: any = fusionDashboard.summary || {};
    return {
      generated_at: new Date().toISOString(),
      trade_date: quantDashboard.trade_date,
      signal_date: fusionDashboard.signal_date,
      quant_rankings: quantDashboard.quant_rankings,
      fusion_rankings: fusionDashboard.fusion_rankings,
      summary: {
        ...fusionSummary,
        ...quantSummary,
        fusion_count: fusionSummary.fusion_count || 0,
        fusion_buy_count: fusionSummary.fusion_buy_count ?? fusionSummary.buy_count ?? 0,
        fusion_watch_count: fusionSummary.fusion_watch_count ?? fusionSummary.watch_count ?? 0,
        fusion_avoid_count: fusionSummary.fusion_avoid_count ?? fusionSummary.avoid_count ?? 0,
        agent_rescored: Boolean(fusionSummary.agent_rescored),
        avg_quant_score: fusionSummary.avg_quant_score,
        avg_final_score: fusionSummary.avg_final_score,
        realtime_persisted: Boolean(
          quantSummary.quote_persistence?.persisted ||
            quantSummary.quote_persistence?.latest_trade_date_snapshot_count
        ),
      },
    };
  }
}

export const signalEngine = new SignalEngine();
