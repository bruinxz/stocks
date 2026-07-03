/**
 * SignalEngine — public facade for signal generation.
 * Controllers MUST only import from here (and the 4 other public facades).
 */


// Stub for deleted QuantSignalService
const quantSignalService = {
  generateSignals: async (_opts?: any) => ({ signals: [], generated: 0 }),
  listSignals: async (_opts?: any) => [],
  getRankingDashboard: async (_opts?: any) => ({ entries: [] }),
};
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
