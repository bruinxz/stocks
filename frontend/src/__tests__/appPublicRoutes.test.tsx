import { act } from 'react';
import { Provider } from 'react-redux';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { SpyInstance } from 'jest-mock';
import App, { settleAppLogout } from '../App';
import store from '../store/store';
import { loginSuccess, logout } from '../store/authSlice';
import { authService } from '../services/authService';
import { TAB_KEYS, type TabKey } from '../pages/catdesk/useTabState';
import {
  USER_SCOPED_LOCAL_STORAGE_KEYS,
  USER_SCOPED_SESSION_STORAGE_KEYS,
} from '../utils/sessionCleanup';

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
jest.mock('../pages/Login', () => ({
  __esModule: true,
  default: () => <div data-testid="login-page">登录系统</div>,
}));

jest.mock('../pages/catdesk/tabs/AShareMorningBrief', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-morning">A股早报</div>,
}));
jest.mock('../pages/catdesk/tabs/a-share-market/AShareMarket', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-market">A股市场</div>,
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
jest.mock('../pages/catdesk/tabs/PortfolioOverview', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-portfolio">我的持仓</div>,
}));
jest.mock('../pages/catdesk/tabs/AIAnalysisDesk', () => ({
  __esModule: true,
  default: () => <div data-testid="tab-ai">AI 分析</div>,
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
  market: 'A股市场',
  morning: 'A股早报',
  us: '美股优选',
  jpkr: '日韩市场',
  multi: '高倍潜力',
  portfolio: '我的持仓',
  ai: 'AI 分析',
  backtest: '回测证据',
  daily: '每日日报',
  history: '报告历史',
};

async function flushRouteEffects() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('authenticated App routing', () => {
  let container: HTMLDivElement;
  let root: Root;
  let warnSpy: { mockRestore: () => void };
  let defaultLoginSpy: SpyInstance<
    ReturnType<typeof authService.defaultLogin>,
    Parameters<typeof authService.defaultLogin>
  >;

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
    window.sessionStorage.clear();
    store.dispatch(logout());
    defaultLoginSpy = jest
      .spyOn(authService, 'defaultLogin')
      .mockRejectedValue(new Error('default login disabled'));
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
    defaultLoginSpy.mockRestore();
    window.localStorage.clear();
    window.sessionStorage.clear();
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

  test('/login remains reachable without credentials', async () => {
    await renderAt('/login');
    expect(window.location.pathname).toBe('/login');
    expect(container.textContent).toContain('登录系统');
  });

  test.each(['/home', '/catdesk', '/workspace/lab'])(
    '%s redirects anonymous viewers to /login',
    async (path: string) => {
      await renderAt(path);
      expect(window.location.pathname).toBe('/login');
      expect(container.textContent).toContain('登录系统');
      expect(window.localStorage.getItem('token')).toBeNull();
    }
  );

  test('enabled default administrator session enters CatDesk without a login form', async () => {
    const accessToken = ['default-admin', 'access-token'].join('-');
    defaultLoginSpy.mockReset().mockImplementation(async () => {
      window.localStorage.setItem('token', accessToken);
      window.localStorage.setItem('username', 'stocks');
      return {
        success: true,
        data: {
          user: { id: 9, username: 'stocks', email: 'stocks@example.com', role: 'admin' },
          tokens: { accessToken },
        },
      };
    });

    await renderAt('/catdesk');

    expect(window.location.pathname).toBe('/catdesk');
    expect(container.textContent).toContain('A股市场');
    expect(container.textContent).not.toContain('登录系统');
    expect(defaultLoginSpy).toHaveBeenCalledTimes(1);
  });

  test.each(TAB_KEYS)('tab %s is reachable with an authenticated identity', async (tab: TabKey) => {
    const token = 'app-routing-token';
    window.localStorage.setItem('token', token);
    store.dispatch(
      loginSuccess({
        token,
        user: { id: 7, username: 'owner', email: 'owner@example.com', role: 'admin' },
      })
    );
    await renderAt(`/catdesk?tab=${tab}`);

    expect(window.location.pathname).toBe('/catdesk');
    expect(window.location.pathname).not.toBe('/login');
    expect(container.textContent).toContain(TAB_LABEL[tab]);
    expect(window.localStorage.getItem('token')).toBe(token);
  });

  test.each(['success', 'failure'] as const)(
    'the App logout boundary clears user-scoped storage after request %s',
    async outcome => {
      for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) localStorage.setItem(key, 'private');
      for (const key of USER_SCOPED_SESSION_STORAGE_KEYS) sessionStorage.setItem(key, 'private');
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const request = jest.fn<Promise<void>, []>();
      if (outcome === 'success') request.mockResolvedValueOnce(undefined);
      else request.mockRejectedValueOnce(new Error('logout failed'));

      await expect(settleAppLogout(request)).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledTimes(1);
      for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) {
        expect(localStorage.getItem(key)).toBeNull();
      }
      for (const key of USER_SCOPED_SESSION_STORAGE_KEYS) {
        expect(sessionStorage.getItem(key)).toBeNull();
      }
      expect(errorLog).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
      errorLog.mockRestore();
    }
  );
});
