import React, { useState } from 'react';
import { act } from 'react';
import { ConfigProvider } from 'antd';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import AIStockAnalysisModal from '../AIStockAnalysisModal';
import type { AIPriceDecisionRequest } from '../../../services/aiStockAnalysisService';

describe('AIStockAnalysisModal async handoff', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.querySelectorAll('.ant-modal-root').forEach(node => node.remove());
  });

  test('submits the request and removes the configuration modal immediately', async () => {
    const submit = jest.fn<void, [AIPriceDecisionRequest]>();
    const close = jest.fn<void, []>();

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <ConfigProvider theme={{ token: { motion: false } }}>
          <AIStockAnalysisModal
            open={open}
            stockCode="sz.002463"
            stockName="沪电股份"
            taskLabel="catdesk_ai_analysis"
            onSubmitAsync={submit}
            onClose={() => {
              close();
              setOpen(false);
            }}
          />
        </ConfigProvider>
      );
    }

    await act(async () => root.render(<Harness />));
    expect(document.body.textContent).toContain('AI 解读 · sz.002463 · 沪电股份');

    const start = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '开始分析'
    );
    await act(async () => start?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({
      stock_code: 'sz.002463',
      stock_name: '沪电股份',
      task_label: 'catdesk_ai_analysis',
      position_state: 'watching',
      refresh_quote: true,
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('AI 解读 · sz.002463 · 沪电股份');
  });
});
