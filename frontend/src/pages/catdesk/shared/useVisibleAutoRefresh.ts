import { useEffect } from 'react';

export function useVisibleAutoRefresh(refetch: () => void, interval_ms: number) {
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refetch();
    };
    const timer = window.setInterval(refreshWhenVisible, interval_ms);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [interval_ms, refetch]);
}
