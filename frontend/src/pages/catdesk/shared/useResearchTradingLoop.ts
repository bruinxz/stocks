import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { getResearchTradingLoopDashboard } from 'services/researchTradingLoopService';
import { useVisibleAutoRefresh } from './useVisibleAutoRefresh';

export const RESEARCH_LOOP_AUTO_REFRESH_MS = 60_000;

export function useResearchTradingLoop() {
  const result = useAbortableRequest(signal => getResearchTradingLoopDashboard(signal), []);
  const { refetch } = result;
  useVisibleAutoRefresh(refetch, RESEARCH_LOOP_AUTO_REFRESH_MS);

  return result;
}
