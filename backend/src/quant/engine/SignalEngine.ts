/**
 * SignalEngine — public facade for signal generation.
 * Controllers MUST only import from here (and the 4 other public facades).
 */


// ⚠️ DEPRECATED STUB — 以下"服务"是 批3/批8 精简量化 pipeline 时已删除的 service
// 的占位替身,仅为让依赖它们的历史代码路径继续编译。方法恒返回空结果 (no-op),
// 即对应能力已永久下线、优雅降级。请勿基于此扩展逻辑;应改接真实实现或移除调用方。
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
