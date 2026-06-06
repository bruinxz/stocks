/**
 * QuantHealthMonitor — public facade for data freshness, runtime health, and
 * the open-of-trading watchdog. Controllers MUST only import from here
 * (and the 4 other public facades).
 */
import { quantDataFreshnessService } from './internal/QuantDataFreshnessService';
import { quantRuntimeHealthService } from './internal/QuantRuntimeHealthService';
import { quantOpenWatchdogService } from './internal/QuantOpenWatchdogService';

export class QuantHealthMonitor {
  getDataFreshness(options: { trade_date?: string } = {}) {
    return quantDataFreshnessService.getSnapshot(options);
  }

  getRuntimeHealth(options: { user_id?: number } = {}) {
    return quantRuntimeHealthService.getHealth(options);
  }

  getOpenWatchdog(options: any = {}) {
    return quantOpenWatchdogService.check(options);
  }
}

export const quantHealthMonitor = new QuantHealthMonitor();
