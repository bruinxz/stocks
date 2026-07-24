import { useEffect } from 'react';
import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { getResearchTradingLoopDashboard } from 'services/researchTradingLoopService';

export const RESEARCH_LOOP_AUTO_REFRESH_MS = 60_000;

export function useResearchTradingLoop() {
  const result = useAbortableRequest(signal => getResearchTradingLoopDashboard(signal), []);
  const { refetch } = result;

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refetch();
    };
    const timer = window.setInterval(refreshWhenVisible, RESEARCH_LOOP_AUTO_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refetch]);

  return result;
}
