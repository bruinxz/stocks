import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AIAnalysisProvider } from '../../../contexts/AIAnalysisContext';
import { aiStockAnalysisService } from '../../../services/aiStockAnalysisService';

const mockSearchStocks = jest.fn<Promise<any>, [string, number]>();

jest.mock('../../../services/api', () => ({
  searchStocks: (query: string, limit: number) => mockSearchStocks(query, limit),
}));

jest.mock('../AIStockAnalysisModal', () => ({
  __esModule: true,
  default: ({ open, stockCode, stockName, taskLabel, onClose, onSubmitAsync }: any) =>
    open ? (
      <div data-testid="analysis-modal">
        <span>配置 {stockCode}</span>
        <button
          data-testid="modal-start"
          onClick={() => {
            onSubmitAsync({
              stock_code: stockCode,
              stock_name: stockName,
              task_label: taskLabel,
              dimensions: ['fundamental', 'technical'],
              position_state: 'watching',
              refresh_quote: true,
            });
            onClose();
          }}
        >
          开始分析
        </button>
      </div>
    ) : null,
}));

import AIAnalysisLauncher from '../AIAnalysisLauncher';

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function App({ show_ai, user_id = 23 }: { show_ai: boolean; user_id?: number | null }) {
  return (
    <AIAnalysisProvider current_user_id={user_id}>
      {show_ai ? (
        <AIAnalysisLauncher compact taskLabel="catdesk_ai_analysis" />
      ) : (
        <div>其他页签</div>
      )}
    </AIAnalysisProvider>
  );
}

describe('AI async workspace', () => {
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
    jest.useFakeTimers();
    localStorage.clear();
    mockSearchStocks.mockReset();
    mockSearchStocks.mockResolvedValue({ data: { data: { stocks: [] } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    jest.useRealTimers();
  });

  test('closes the config modal, keeps polling across tabs, and renders the result on return', async () => {
    jest.spyOn(aiStockAnalysisService, 'submitPriceDecisionAsync').mockResolvedValue({
      report_id: 'AI-600519-async',
      stock_code: 'sh.600519',
      stock_name: '贵州茅台',
      dimensions: ['fundamental', 'technical'],
      summary: '',
      recommendation: 'unknown',
      confidence_score: null,
      risk_level: null,
      key_points: {},
      status: 'pending',
      task_id: 'task-async-1',
      target_date: '2026-07-21',
      error: null,
      generated_at: '2026-07-21T02:00:00.000Z',
      metadata: {},
      persisted: true,
      market_snapshot: null,
      price_decision: null,
      task_phase: 'pending',
      elapsed_time: 0,
    });
    const poll = jest.spyOn(aiStockAnalysisService, 'getPriceDecisionTask').mockResolvedValue({
      report_id: 'AI-600519-async',
      stock_code: 'sh.600519',
      stock_name: '贵州茅台',
      dimensions: ['fundamental', 'technical'],
      summary: '基本面与技术面共同改善。',
      recommendation: 'buy',
      confidence_score: 82,
      risk_level: '中',
      key_points: { fundamental: ['盈利质量改善'], technical: ['趋势向上'] },
      status: 'completed',
      task_id: 'task-async-1',
      target_date: '2026-07-21',
      error: null,
      generated_at: '2026-07-21T02:14:02.000Z',
      metadata: {},
      persisted: true,
      market_snapshot: null,
      price_decision: null,
      task_phase: 'completed',
      elapsed_time: 842,
    });

    await act(async () => {
      root.render(<App show_ai />);
      await flush();
    });
    const input = container.querySelector('input[placeholder*="股票代码"]') as HTMLInputElement;
    await act(async () => changeInput(input, '600519'));
    const launch = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('开始分析')
    );
    await act(async () => launch?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[data-testid="analysis-modal"]')).not.toBeNull();

    const modalStart = container.querySelector('[data-testid="modal-start"]');
    await act(async () => {
      modalStart?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    expect(container.querySelector('[data-testid="analysis-modal"]')).toBeNull();
    expect(container.textContent).toContain('任务在页面之外持续运行');

    await act(async () => {
      root.render(<App show_ai={false} />);
      jest.advanceTimersByTime(3100);
      await flush();
    });
    expect(container.textContent).toContain('其他页签');
    expect(poll).toHaveBeenCalledWith('task-async-1');

    await act(async () => {
      root.render(<App show_ai />);
      await flush();
    });
    expect(container.textContent).toContain('会审完成，结果已归档');
    expect(container.textContent).toContain('基本面与技术面共同改善');
    expect(container.textContent).toContain('14 分 2 秒');
  });

  test('drops the in-memory recovery task when the authenticated user changes', async () => {
    jest.spyOn(aiStockAnalysisService, 'submitPriceDecisionAsync').mockResolvedValue({
      report_id: 'AI-600519-owned',
      stock_code: 'sh.600519',
      stock_name: '贵州茅台',
      dimensions: ['technical'],
      summary: '',
      recommendation: 'unknown',
      confidence_score: null,
      risk_level: null,
      key_points: {},
      status: 'pending',
      task_id: 'task-owned-by-23',
      target_date: '2026-07-21',
      error: null,
      generated_at: '2026-07-21T02:00:00.000Z',
      metadata: {},
      persisted: true,
      market_snapshot: null,
      price_decision: null,
      task_phase: 'pending',
      elapsed_time: 0,
    });
    jest
      .spyOn(aiStockAnalysisService, 'getPriceDecisionTask')
      .mockImplementation(() => new Promise(() => undefined));

    await act(async () => {
      root.render(<App show_ai user_id={23} />);
      await flush();
    });
    const input = container.querySelector('input[placeholder*="股票代码"]') as HTMLInputElement;
    await act(async () => changeInput(input, '600519'));
    const launch = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('开始分析')
    );
    await act(async () => launch?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      container
        .querySelector('[data-testid="modal-start"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    expect(container.textContent).toContain('任务在页面之外持续运行');
    expect(localStorage.getItem('ai_price_analysis_job_v1')).not.toBeNull();

    await act(async () => {
      root.render(<App show_ai user_id={24} />);
      await flush();
    });
    expect(container.textContent).not.toContain('任务在页面之外持续运行');
    expect(localStorage.getItem('ai_price_analysis_job_v1')).toBeNull();
  });
});
