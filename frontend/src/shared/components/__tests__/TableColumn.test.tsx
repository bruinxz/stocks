import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { TableColumn, type TableColumnDef } from '../TableColumn';

interface ScoreRow {
  symbol: string;
  score: number;
}

const rows: ScoreRow[] = [
  { symbol: 'A', score: 62 },
  { symbol: 'B', score: 91 },
  { symbol: 'C', score: 76 },
];

const columns: TableColumnDef<ScoreRow>[] = [
  { key: 'symbol', title: '代码', ariaLabel: '股票代码', sortable: true },
  {
    key: 'score',
    title: '评分',
    ariaLabel: '综合评分',
    sortable: (left, right) => left.score - right.score,
  },
];

function renderedSymbols(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.ant-table-tbody > tr'))
    .map(row => row.querySelector('td')?.textContent ?? '')
    .filter(Boolean);
}

describe('TableColumn sorting', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  test('点击可排序表头会真正改变行顺序', async () => {
    await act(async () => {
      root.render(
        <TableColumn<ScoreRow> rows={rows} columns={columns} rowKey="symbol" pagination={false} />
      );
    });

    const scoreHeader = Array.from(container.querySelectorAll('th')).find(header =>
      header.textContent?.includes('评分')
    ) as HTMLTableCellElement;

    await act(async () => scoreHeader.click());
    expect(renderedSymbols(container)).toEqual(['A', 'C', 'B']);

    await act(async () => scoreHeader.click());
    expect(renderedSymbols(container)).toEqual(['B', 'C', 'A']);
  });
});
