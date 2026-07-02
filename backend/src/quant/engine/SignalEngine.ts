/**
 * SignalEngine — public facade for signal generation.
 * Controllers MUST only import from here (and the 4 other public facades).
 */
import { quantSignalService } from '../engine/internal/QuantSignalService';

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
}

export const signalEngine = new SignalEngine();
