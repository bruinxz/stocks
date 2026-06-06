/**
 * PerformanceReporter — public facade for performance dashboards and indicator catalogs.
 * Controllers MUST only import from here (and the 4 other public facades).
 */
import { quantPerformanceDashboardService } from './internal/QuantPerformanceDashboardService';

export class PerformanceReporter {
  getIndicatorCatalog() {
    return quantPerformanceDashboardService.getIndicatorCatalog();
  }

  getDashboard(options: { user_id?: number; username?: string } = {}) {
    return quantPerformanceDashboardService.getDashboard(options);
  }
}

export const performanceReporter = new PerformanceReporter();
