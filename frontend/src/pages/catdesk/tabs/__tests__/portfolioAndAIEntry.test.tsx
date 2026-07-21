import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockGetPortfolio = jest.fn<Promise<any>, [number | undefined]>();
const mockSearchStocks = jest.fn<Promise<any>, [string, number]>();

jest.mock('../../../../contexts/PortfolioContext', () => ({
  usePortfolio: () => ({
    selectedPortfolioId: 65,
    portfolios: [{ id: 65, name: '综合策略主盘' }],
  }),
}));

jest.mock('../../../../services/portfolioWorkspaceService', () => ({
  portfolioWorkspaceService: {
    getPortfolio: (id?: number) => mockGetPortfolio(id),
  },
}));

jest.mock('../../../../services/api', () => ({
  searchStocks: (query: string, limit: number) => mockSearchStocks(query, limit),
}));

jest.mock('../../../../components/trading/AIStockAnalysisModal', () => ({
  __esModule: true,
  default: ({ open, stockCode }: { open: boolean; stockCode: string }) =>
    open ? <div data-testid="analysis-modal">分析 {stockCode}</div> : null,
}));

import AIAnalysisLauncher from '../../../../components/trading/AIAnalysisLauncher';
import PortfolioOverview from '../PortfolioOverview';

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CatDesk portfolio and AI entries', () => {
  let container: HTMLDivElement;
  let root: Root;

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
    localStorage.clear();
    mockGetPortfolio.mockReset();
    mockSearchStocks.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
  });

  test('renders the selected portfolio ledger and opens AI analysis for a position', async () => {
    mockGetPortfolio.mockResolvedValue({
      portfolio: {
        id: 65,
        name: '综合策略主盘',
        initial_capital: 200000,
        current_cash: 100000,
        total_value: 205000,
        is_active: true,
      },
      positions: [
        {
          id: 901,
          symbol: 'sh.600483',
          name: '福能股份',
          quantity: 1100,
          avg_cost: 10.42,
          current_price: 11.2,
          market_value: 12320,
          unrealized_pnl: 858,
          stop_loss_price: 9.899,
          take_profit_price: 11.462,
          created_at: '2026-07-07T05:20:00.000Z',
          updated_at: '2026-07-21T03:00:00.000Z',
        },
      ],
    });

    await act(async () => {
      root.render(<PortfolioOverview />);
      await flush();
    });

    expect(mockGetPortfolio).toHaveBeenCalledWith(65);
    expect(container.textContent).toContain('综合策略主盘');
    expect(container.textContent).toContain('¥205,000.00');
    expect(container.textContent).toContain('福能股份');
    expect(container.textContent).toContain('1,100 股');

    const button = Array.from(container.querySelectorAll('button')).find(node =>
      node.textContent?.includes('AI 解读')
    );
    expect(button).toBeDefined();
    await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('分析 sh.600483');
  });

  test('never reuses a stale search result when the user immediately analyzes a new code', async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    mockSearchStocks.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveOld = resolve;
        })
    );

    await act(async () => {
      root.render(<AIAnalysisLauncher compact />);
      await flush();
    });

    const input = container.querySelector('input[placeholder*="股票代码"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      changeInput(input, '旧查询');
      await new Promise(resolve => setTimeout(resolve, 280));
    });
    expect(mockSearchStocks).toHaveBeenCalledWith('旧查询', 20);

    await act(async () => {
      changeInput(input, '600519');
      resolveOld?.({
        data: { data: { stocks: [{ symbol: 'sz.000001', name: '旧结果' }] } },
      });
      await flush();
    });

    const button = Array.from(container.querySelectorAll('button')).find(node =>
      node.textContent?.includes('开始分析')
    );
    await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('分析 600519');
    expect(container.textContent).not.toContain('分析 sz.000001');
  });
});
