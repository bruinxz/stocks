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
import {
  industryAttributionService,
  IndustryAttributionInput,
  IndustryAttributionOptions,
  IndustryAttributionRunResult,
} from './IndustryAttributionService';

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

  /**
   * US-046：对一次完成的回测做行业归因（按行业拆解 contribution / win_rate / avg_hold_days）。
   * 返回每个行业的贡献百分比、胜率、平均持仓天数、交易数；按 |contribution_pct| 降序。
   */
  computeIndustryAttribution(
    input: IndustryAttributionInput,
    options?: IndustryAttributionOptions
  ): Promise<IndustryAttributionRunResult> {
    return industryAttributionService.computeAttribution(input, options);
  }

  /** US-046：按 run_id 查某次回测的全部行业归因结果（一次回测 → N 个行业 → N 行）。 */
  getIndustryAttributionResultsForRun(run_id: number) {
    return industryAttributionService.getResultsForRun(run_id);
  }
}

export const performanceReporter = new PerformanceReporter();
