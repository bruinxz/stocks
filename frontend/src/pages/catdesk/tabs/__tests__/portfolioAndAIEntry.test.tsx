import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockGetPortfolio = jest.fn<Promise<any>, [number]>();
const mockSearchStocks = jest.fn<Promise<any>, [string, number]>();

jest.mock('../../../../contexts/PortfolioContext', () => ({
  usePortfolio: () => ({
    selectedPortfolioId: 65,
    setSelectedPortfolioId: () => undefined,
    loading: false,
    portfolios: [{ id: 65, name: '综合策略主盘', position_count: 1 }],
  }),
}));

jest.mock('../../../../services/portfolioWorkspaceService', () => ({
  portfolioWorkspaceService: {
    getPortfolioLedger: (id: number) => mockGetPortfolio(id),
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
import { AIAnalysisProvider } from '../../../../contexts/AIAnalysisContext';
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
        is_active: true,
        auto_trade_enabled: true,
        strategy_keys: [],
        description: null,
      },
      valuation: {
        initial_capital: 200000,
        current_cash: 192680,
        position_value: 12320,
        total_value: 205000,
        total_pnl: 5000,
        total_pnl_pct: 2.5,
        valued_at: '2026-07-21T03:00:00.000Z',
        quote_source: 'realtime_quotes',
        has_stale_quotes: false,
      },
      latest_morning_brief: {
        snapshot_id: 'snap',
        trading_day: '2026-07-21',
        as_of: '2026-07-21T00:00:00Z',
      },
      latest_multibagger: null,
      unread_alerts_count: 0,
      positions: [
        {
          position: {
            id: 901,
            symbol: 'sh.600483',
            name: '福能股份',
            quantity: 1100,
            avg_cost: 10.42,
            stop_loss_price: 9.899,
            take_profit_price: 11.462,
            highest_price: 11.3,
            trailing_stop_price: 10.17,
            created_at: '2026-07-07T05:20:00.000Z',
          },
          quote: {
            price: 11.2,
            source: 'tencent',
            quote_time: '2026-07-21T03:00:00.000Z',
            trade_date: '2026-07-21',
            freshness: 'fresh',
            age_minutes: 1,
          },
          valuation: { market_value: 12320, unrealized_pnl: 858, unrealized_pnl_pct: 7.49 },
          source_status: 'linked',
          source_message: null,
          entry_trades: [],
          investment_signal: {
            id: 959,
            source_type: 'recommendation_snapshot',
            source_id: 'item',
            signal_date: '2026-07-21',
            decision: '推荐',
            normalized_decision: 'buy',
            confidence_score: 88,
            rationale: '验证',
            metadata: {},
          },
          outcome: null,
          morning_brief: {
            matched: true,
            snapshot_id: 'snap',
            trading_day: '2026-07-21',
            rank: 0,
            rating: 'A',
          },
          multibagger: { matched: false, as_of: null },
          alerts: [],
          notifications: [],
          corrections: [],
          timeline: [],
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
      root.render(
        <AIAnalysisProvider>
          <AIAnalysisLauncher compact />
        </AIAnalysisProvider>
      );
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
