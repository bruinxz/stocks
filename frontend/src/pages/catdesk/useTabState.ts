import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export const TAB_KEYS = [
  'market',
  'morning',
  'us',
  'jpkr',
  'multi',
  'backtest',
  'daily',
  'history',
] as const;

export type TabKey = (typeof TAB_KEYS)[number];

const DEFAULT_TAB: TabKey = 'market';

export function useTabState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const activeTab: TabKey = raw && TAB_KEYS.includes(raw as TabKey) ? (raw as TabKey) : DEFAULT_TAB;

  const setTab = useCallback(
    (key: TabKey) => {
      setSearchParams({ tab: key }, { replace: false });
    },
    [setSearchParams]
  );

  return { activeTab, setTab } as const;
}
