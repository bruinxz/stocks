import { act } from 'react';
import { Provider } from 'react-redux';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import App from '../App';
import store from '../store/store';
import { TAB_KEYS, type TabKey } from '../pages/catdesk/useTabState';

jest.mock('../services/portfolioWorkspaceService', () => ({
  listPortfolios: async () => [],
}));
jest.mock('../contexts/PortfolioContext', () => ({
  PortfolioProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('../components/layout/GlobalPortfolioSelector', () => ({
  __esModule: true,
  default: () => <div data-testid="portfolio-selector" />,
}));
jest.mock('../components/layout/AlertsBell', () => ({
  __esModule: true,
  default: () => <div data-testid="alerts-bell" />,
}));
jest.mock('../components/layout/CriticalAlertModal', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../pages/catdesk/tabs/AShareMorningBrief', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-morning">A股早报</div>,
}));
jest.mock('../pages/catdesk/tabs/USStockPicks', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-us">美股优选</div>,
}));
jest.mock('../pages/catdesk/tabs/JPKRMarket', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-jpkr">日韩市场</div>,
}));
jest.mock('../pages/catdesk/tabs/HighMultipotential', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-multi">高倍潜力</div>,
}));
jest.mock('../pages/catdesk/tabs/BacktestEvidence', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-backtest">回测证据</div>,
}));
jest.mock('../pages/catdesk/tabs/DailyReport', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-daily">每日日报</div>,
}));
jest.mock('../pages/catdesk/tabs/ReportHistory', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-history">报告历史</div>,
}));

const TAB_LABEL: Record<TabKey, string> = {
  morning: 'A股早报',
  us: '美股优选',
  jpkr: '日韩市场',
  multi: '高倍潜力',
  backtest: '回测证据',
  daily: '每日日报',
  history: '报告历史',
};

async function flushRouteEffects() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('public App routing', () => {
  let container: HTMLDivElement;
  let root: Root;
  let warnSpy: { mockRestore: () => void };

  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    });
  });

  beforeEach(() => {
    window.localStorage.clear();
    warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation((message: unknown, ...args: unknown[]) => {
        if (String(message).includes('React Router Future Flag Warning')) return;
        console.info(message, ...args);
      });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    warnSpy.mockRestore();
    container.remove();
  });

  async function renderAt(path: string) {
    window.history.replaceState({}, '', path);
    await act(async () => {
      root.render(
        <Provider store={store}>
          <App />
        </Provider>
      );
      await flushRouteEffects();
    });
  }

  test.each(['/login', '/home'])(
    '%s redirects through the real App router to /catdesk',
    async (path: string) => {
      await renderAt(path);

      expect(window.location.pathname).toBe('/catdesk');
      expect(container.textContent).toContain('A股早报');
      expect(window.localStorage.getItem('token')).toBeNull();
    }
  );

  test.each(TAB_KEYS)('tab %s is publicly reachable without a token', async (tab: TabKey) => {
    await renderAt(`/catdesk?tab=${tab}`);

    expect(window.location.pathname).toBe('/catdesk');
    expect(window.location.pathname).not.toBe('/login');
    expect(container.textContent).toContain(TAB_LABEL[tab]);
    expect(window.localStorage.getItem('token')).toBeNull();
  });
});
