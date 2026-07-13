import React, { Suspense, useState } from 'react';
import { ConfigProvider } from 'antd';
import { Outlet, useLocation } from 'react-router-dom';
import { CSS_VARS, CATDESK_TOKENS } from './tokens';
import { useTabState, type TabKey } from './useTabState';
import { KpiBar } from './shared/KpiBar';
import { TabNav } from './shared/TabNav';
import { LoadingState } from './shared/LoadingState';
import { createTab67HttpApi, type Tab67Api } from './tabs/daily-report/tab67Api';

const AShareMorningBrief = React.lazy(() => import('./tabs/AShareMorningBrief'));
const USStockPicks = React.lazy(() => import('./tabs/USStockPicks'));
const JPKRMarket = React.lazy(() => import('./tabs/JPKRMarket'));
const HighMultipotential = React.lazy(() => import('./tabs/HighMultipotential'));
const BacktestEvidence = React.lazy(() => import('./tabs/BacktestEvidence'));
const DailyReportContainer = React.lazy(() => import('./tabs/daily-report/DailyReportContainer'));
const ReportHistoryContainer = React.lazy(
  () => import('./tabs/report-history/ReportHistoryContainer')
);
const DEFAULT_TAB67_API = createTab67HttpApi();

const TAB_COMPONENTS: Record<
  Exclude<TabKey, 'daily' | 'history'>,
  React.LazyExoticComponent<React.ComponentType>
> = {
  morning: AShareMorningBrief,
  us: USStockPicks,
  jpkr: JPKRMarket,
  multi: HighMultipotential,
  backtest: BacktestEvidence,
};

export interface CatDeskOutletContext {
  selectedRow: string | null;
  setSelectedRow: (id: string | null) => void;
}

const rootStyle: React.CSSProperties = {
  ...CSS_VARS,
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  background: 'var(--cd-bg-base)',
  color: 'var(--cd-text-primary)',
  fontFamily: 'var(--cd-font-sans)',
  fontSize: 'var(--cd-font-md)',
} as React.CSSProperties;

const bodyStyle: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  overflow: 'hidden',
};

const mainStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  padding: 16,
};

export interface CatDeskLayoutProps {
  tab67Api?: Tab67Api;
  dailyTradingDay?: string;
}

export default function CatDeskLayout({
  tab67Api = DEFAULT_TAB67_API,
  dailyTradingDay,
}: CatDeskLayoutProps) {
  const { activeTab, setTab } = useTabState();
  const [selectedRow, setSelectedRow] = useState<string | null>(null);
  const location = useLocation();

  const ActiveTab = TAB_COMPONENTS[activeTab as Exclude<TabKey, 'daily' | 'history'>];
  const outletContext: CatDeskOutletContext = { selectedRow, setSelectedRow };
  const isNestedPage = location.pathname !== '/catdesk' && location.pathname !== '/catdesk/';

  return (
    <ConfigProvider theme={{ token: { colorPrimary: CATDESK_TOKENS.accent } }}>
      <div style={rootStyle}>
        <KpiBar slots={[]} />
        <div style={bodyStyle}>
          <TabNav activeTab={activeTab} onTabChange={setTab} />
          <main style={mainStyle}>
            <Suspense fallback={<LoadingState />}>
              {isNestedPage ? (
                <Outlet context={outletContext} />
              ) : activeTab === 'daily' ? (
                <DailyReportContainer api={tab67Api} tradingDay={dailyTradingDay} />
              ) : activeTab === 'history' ? (
                <ReportHistoryContainer api={tab67Api} />
              ) : (
                <ActiveTab />
              )}
            </Suspense>
          </main>
        </div>
      </div>
    </ConfigProvider>
  );
}
