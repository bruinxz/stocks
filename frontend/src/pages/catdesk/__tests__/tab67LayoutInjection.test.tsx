import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, jest, test } from '@jest/globals';
import type { Tab67Api } from '../tabs/daily-report/tab67Api';

jest.mock('react-router-dom', () => ({
  Outlet: () => null,
  useLocation: () => ({ pathname: '/catdesk' }),
}));
jest.mock('../useTabState', () => ({
  useTabState: () => ({ activeTab: 'daily', setTab: () => undefined }),
}));
jest.mock('../shared/KpiBar', () => ({ KpiBar: () => <div /> }));
jest.mock('../shared/TabNav', () => ({ TabNav: () => <div /> }));
jest.mock('../shared/LoadingState', () => ({ LoadingState: () => <div>loading</div> }));
jest.mock('../tabs/daily-report/DailyReportContainer', () => ({
  __esModule: true,
  default: ({ api, tradingDay }: { api: Tab67Api; tradingDay?: string }) => (
    <div data-api={api ? 'injected' : 'missing'}>{tradingDay}</div>
  ),
}));
jest.mock('../tabs/report-history/ReportHistoryContainer', () => ({
  __esModule: true,
  default: () => <div>history</div>,
}));
jest.mock('../tabs/AShareMorningBrief', () => ({ __esModule: true, default: () => null }));
jest.mock('../tabs/USStockPicks', () => ({ __esModule: true, default: () => null }));
jest.mock('../tabs/JPKRMarket', () => ({ __esModule: true, default: () => null }));
jest.mock('../tabs/HighMultipotential', () => ({ __esModule: true, default: () => null }));
jest.mock('../tabs/PortfolioOverview', () => ({ __esModule: true, default: () => null }));
jest.mock('../tabs/AIAnalysisDesk', () => ({ __esModule: true, default: () => null }));
jest.mock('../tabs/BacktestEvidence', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../components/layout/GlobalPortfolioSelector', () => ({
  __esModule: true,
  default: () => <div data-testid="portfolio-selector" />,
}));
jest.mock('../../../components/layout/AlertsBell', () => ({
  __esModule: true,
  default: () => <div data-testid="alerts-bell" />,
}));
jest.mock('../../../components/layout/CriticalAlertModal', () => ({
  __esModule: true,
  default: () => null,
}));

import CatDeskLayout from '../CatDeskLayout';

const api = {} as Tab67Api;

describe('CatDesk Tab 6/7 container injection', () => {
  test('injects the runtime API and deterministic trading day into Tab 6', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<CatDeskLayout tab67Api={api} dailyTradingDay="2026-07-10" />);
      await Promise.resolve();
    });
    expect(container.innerHTML).toContain('data-api="injected"');
    expect(container.textContent).toContain('2026-07-10');
    await act(async () => root.unmount());
  });
});
