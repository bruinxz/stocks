import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import api from 'services/api';
import { useStockNameHydration } from '../useStockNameHydration';

jest.mock('services/api', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

const apiGet = api.get as jest.MockedFunction<typeof api.get>;
const ROWS = [{ symbol: '000777', name: '000777' }];

function Harness() {
  const [catalyst, setCatalyst] = useState('all');
  const rows = useStockNameHydration(ROWS);

  return (
    <div>
      {['all', 'earnings', 'product', 'regulator'].map(value => (
        <button key={value} type="button" onClick={() => setCatalyst(value)}>
          {value}
        </button>
      ))}
      <span data-testid="selected-catalyst">{catalyst}</span>
      <span data-testid="stock-name">{rows[0].name}</span>
    </div>
  );
}

async function settle() {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('useStockNameHydration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiGet.mockResolvedValue({
      data: {
        data: {
          stocks: [{ symbol: 'sz.000777', name: '中核科技' }],
        },
      },
    } as never);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.clearAllMocks();
  });

  test('切换催化筛选时不会重启名称补全循环', async () => {
    await act(async () => {
      root.render(<Harness />);
      await settle();
    });

    expect(container.querySelector('[data-testid="stock-name"]')?.textContent).toBe('中核科技');
    expect(apiGet).toHaveBeenCalledTimes(1);

    for (const label of ['earnings', 'product', 'regulator']) {
      await act(async () => {
        (
          Array.from(container.querySelectorAll('button')).find(
            button => button.textContent === label
          ) as HTMLButtonElement
        ).click();
        await settle();
      });
      expect(container.querySelector('[data-testid="selected-catalyst"]')?.textContent).toBe(label);
    }

    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});
