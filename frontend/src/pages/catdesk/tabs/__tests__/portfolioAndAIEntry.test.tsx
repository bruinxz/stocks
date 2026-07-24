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
    portfolios: [{ id: 65, name: '研究闭环模拟盘', position_count: 1 }],
  }),
}));

jest.mock('../../shared/useResearchTradingLoop', () => ({
  useResearchTradingLoop: () => ({
    data: {
      research: {
        expected_research_day: '2026-07-21',
        morning: {
          snapshot_id: 'snap',
          research_day: '2026-07-21',
          as_of: '2026-07-22T01:03:00Z',
          candidate_count: 8,
          fresh: true,
        },
        multibagger: {
          research_day: '2026-07-21',
          as_of: '2026-07-22T01:04:00Z',
          candidate_count: 8,
          fresh: true,
        },
        merged_target_count: 6,
        allocation_policy: {
          size_hint_multiplier: 3,
          dual_source_bonus_pct: 3,
          max_single_weight_pct: 12,
          planned_gross_weight_pct: 48,
        },
        targets: [
          {
            symbol: 'sh.600483',
            name: '福能股份',
            combined_score: 82,
            source_size_hint_pct: 3,
            target_weight_pct: 12,
            sources: ['morning_brief', 'multibagger'],
          },
        ],
      },
      execution: {
        trading_day: '2026-07-22',
        status: 'completed',
        reason_code: 'run_completed',
        message: '今日研究决策与模拟成交已完成',
        next_attempt_label: null,
        required_quote_count: 6,
        fresh_quote_count: 6,
        unavailable_symbols: [],
      },
      latest_run: {
        id: 9,
        portfolio_id: 65,
        portfolio_name: '研究闭环模拟盘',
        trading_day: '2026-07-22',
        research_day: '2026-07-21',
        status: 'completed',
        is_current: true,
        target_count: 3,
        buy_count: 1,
        hold_count: 1,
        sell_count: 1,
        skipped_count: 1,
        total_value: 205000,
        current_cash: 192680,
        completed_at: '2026-07-22T01:36:00Z',
        decisions: [
          {
            id: 1,
            symbol: 'sh.600483',
            name: '福能股份',
            action: 'HOLD',
            status: 'held',
            combined_score: 82,
            target_weight_pct: 12,
            reference_price: 11.2,
            quantity: 1100,
            sources: [],
            reason: '两个研究源继续支持，保持持仓',
            trade_id: null,
            created_at: '2026-07-22T01:35:00Z',
          },
          {
            id: 2,
            symbol: 'sh.600001',
            name: '测试涨停股',
            action: 'BUY',
            status: 'skipped',
            combined_score: 80,
            target_weight_pct: 9,
            reference_price: 11,
            quantity: null,
            sources: [],
            reason: 'A股早报新进入目标池',
            metadata: { skip_reason: 'limit_up_unfillable' },
            trade_id: null,
            created_at: '2026-07-22T01:35:01Z',
          },
        ],
      },
    },
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
        name: '研究闭环模拟盘',
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
      portfolio_notifications: [
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
      account_correction_notifications: [
        {
          id: 46,
          title: '更正 · 开盘前体检收益率无效',
          kind: 'morning_risk_checkup_correction',
          severity: 'HIGH',
          status: 'sent',
          corrected: true,
          invalidated: false,
          correction_id: null,
          metadata: {},
          created_at: '2026-07-21T02:00:00Z',
          sent_at: '2026-07-21T02:01:00Z',
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
          timeline: [
            {
              id: 'notification:6',
              type: 'notification',
              title: '已作废 · 自主卖出 · 福能股份',
              detail: 'paper_trade',
              occurred_at: '2026-07-21T01:15:00Z',
              status: 'invalidated',
              corrected: false,
              invalidated: true,
            },
          ],
        },
      ],
    });

    await act(async () => {
      root.render(<PortfolioOverview />);
      await flush();
    });

    expect(mockGetPortfolio).toHaveBeenCalledWith(65);
    expect(container.textContent).toContain('研究闭环模拟盘');
    expect(container.textContent).toContain('唯一模拟账户');
    expect(container.querySelector('[aria-label="选择模拟盘"]')).toBeNull();
    expect(container.textContent).toContain('研究日 2026-07-21 已对齐');
    expect(container.textContent).toContain('继续持有');
    expect(container.textContent).toContain('已触及涨停，买入无法可靠成交');
    expect(container.textContent).not.toContain('skipped');
    expect(container.textContent).toContain('¥205,000.00');
    expect(container.textContent).toContain('来源 实时行情库');
    expect(container.textContent).toContain('福能股份');
    expect(container.textContent).toContain('1,100 股');
    expect(container.textContent).toContain('组合再平衡');
    expect(container.textContent).toContain('研究已过期');
    expect(container.textContent).toContain('更正 · 福能股份误卖已撤销');
    expect(container.textContent).not.toContain('最近晨检通知');
    expect(container.textContent).toContain('已作废 · 自主卖出 · 福能股份');
    expect(container.textContent).not.toContain('账户级告警与通知');

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
