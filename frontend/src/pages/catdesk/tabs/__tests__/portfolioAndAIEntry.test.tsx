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
        oldest_quote_at: '2026-07-21T03:00:00.000Z',
        newest_quote_at: '2026-07-21T03:00:00.000Z',
        quote_source: 'realtime_quotes',
        quote_counts: { live: 1, close: 0, delayed: 0, stale: 0, missing: 0 },
        has_stale_quotes: false,
      },
      latest_morning_brief: {
        snapshot_id: 'snap',
        trading_day: '2026-07-20',
        expected_trading_day: '2026-07-21',
        as_of: '2026-07-20T00:00:00Z',
        freshness: 'delayed',
        lag_days: 1,
        reason: 'snapshot_stale',
      },
      latest_multibagger: null,
      unread_alerts_count: 0,
      portfolio_alerts: [],
      account_alerts: [
        {
          id: 5144,
          symbol: 'SYSTEM:INDUSTRY_CONCENTRATION:电力',
          level: 'MEDIUM',
          rule_id: 'industry_concentration',
          message: '行业集中度偏高',
          is_read: false,
          metadata: {},
          created_at: '2026-07-21T00:30:00Z',
        },
      ],
      portfolio_notifications: [],
      account_notifications: [
        {
          id: 5,
          title: '模拟盘晨间体检',
          kind: 'paper_trading_morning_checkup',
          severity: 'INFO',
          status: 'sent',
          corrected: false,
          invalidated: true,
          correction_id: null,
          metadata: { portfolio_id: 65 },
          created_at: '2026-07-21T01:15:00Z',
          sent_at: '2026-07-21T01:16:00Z',
        },
      ],
      portfolio_corrections: [
        {
          id: 1,
          correction_key: 'paper_sale_447_stale_preopen_quote',
          correction_type: 'reverse_false_paper_sale',
          entity_type: 'paper_trading_trade',
          entity_id: '447',
          reason: '盘前误用旧行情',
          created_at: '2026-07-21T02:00:00Z',
        },
      ],
      latest_morning_notification: {
        id: 5,
        title: '模拟盘晨间体检',
        kind: 'paper_trading_morning_checkup',
        severity: 'INFO',
        status: 'sent',
        corrected: false,
        invalidated: true,
        correction_id: null,
        metadata: { portfolio_id: 65 },
        created_at: '2026-07-21T01:15:00Z',
        sent_at: '2026-07-21T01:16:00Z',
      },
      latest_correction_notification: {
        id: 46,
        title: '更正 · 福能股份误卖已撤销',
        kind: 'paper_trade_correction',
        severity: 'HIGH',
        status: 'sent',
        corrected: false,
        invalidated: false,
        correction_id: 1,
        metadata: { portfolio_id: 65 },
        created_at: '2026-07-21T02:00:00Z',
        sent_at: '2026-07-21T02:01:00Z',
      },
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
            freshness: 'live',
            age_minutes: 1,
            expected_trade_date: '2026-07-21',
            market_phase: 'trading',
          },
          valuation: { market_value: 12320, unrealized_pnl: 858, unrealized_pnl_pct: 7.49 },
          source_status: 'trade_origin_linked',
          source_message: '成交来源：rebalance',
          trade_origin: {
            trade_id: 437,
            source: 'rebalance',
            strategy_key: null,
            summary: '红利组合再平衡',
          },
          entry_trades: [],
          investment_signal: null,
          outcome: null,
          morning_brief: {
            matched: true,
            snapshot_id: 'snap',
            trading_day: '2026-07-20',
            expected_trading_day: '2026-07-21',
            as_of: '2026-07-20T00:00:00Z',
            freshness: 'delayed',
            lag_days: 1,
            reason: 'snapshot_stale',
            rank: 0,
            rating: 'A',
          },
          multibagger: {
            matched: false,
            as_of: null,
            available_at: null,
            freshness: 'missing',
            lag_days: null,
            reason: 'snapshot_missing',
            strategy_version: null,
          },
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
    expect(container.textContent).toContain('组合再平衡');
    expect(container.textContent).toContain('研究已过期');
    expect(container.textContent).toContain('更正 · 福能股份误卖已撤销');
    expect(container.textContent).toContain('模拟盘晨间体检（已作废）');

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
