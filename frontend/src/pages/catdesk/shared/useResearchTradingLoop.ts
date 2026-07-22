import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { getResearchTradingLoopDashboard } from 'services/researchTradingLoopService';

export function useResearchTradingLoop() {
  return useAbortableRequest(signal => getResearchTradingLoopDashboard(signal), []);
}
