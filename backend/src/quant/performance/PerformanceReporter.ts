/**
 * PerformanceReporter — public facade for performance dashboards and indicator catalogs.
 * Controllers MUST only import from here (and the 4 other public facades).
 */
import { quantPerformanceDashboardService } from './internal/QuantPerformanceDashboardService';
import {
  benchmarkAttributionService,
  BenchmarkAttributionInput,
  BenchmarkAttributionOptions,
  BenchmarkAttributionRunResult,
} from './BenchmarkAttributionService';

export class PerformanceReporter {
  getIndicatorCatalog() {
    return quantPerformanceDashboardService.getIndicatorCatalog();
  }

  getDashboard(options: { user_id?: number; username?: string } = {}) {
    return quantPerformanceDashboardService.getDashboard(options);
  }

  /**
   * US-045：对一次完成的回测做基准归因（默认 HS300 + CSI500 + CSI1000）。
   * 返回每个基准的 alpha / beta / IR / excess_return / excess_drawdown。
   */
  computeBenchmarkAttribution(
    input: BenchmarkAttributionInput,
    options?: BenchmarkAttributionOptions
  ): Promise<BenchmarkAttributionRunResult> {
    return benchmarkAttributionService.computeAttribution(input, options);
  }

  /** US-045：按 run_id 查某次回测的全部基准归因结果（一次回测对 N 个基准 → N 行）。 */
  getBenchmarkAttributionResultsForRun(run_id: number) {
    return benchmarkAttributionService.getResultsForRun(run_id);
  }
}

export const performanceReporter = new PerformanceReporter();
