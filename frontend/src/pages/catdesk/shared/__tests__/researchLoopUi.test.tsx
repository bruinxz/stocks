import fs from 'fs';
import path from 'path';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { ResearchLoopStatusStrip } from '../ResearchLoopStatusStrip';
import type { ResearchTradingLoopDashboard } from 'services/researchTradingLoopService';

function dashboard(fresh = true): ResearchTradingLoopDashboard {
  return {
    research: {
      expected_research_day: '2026-07-21',
      morning: {
        snapshot_id: 'snap',
        research_day: '2026-07-21',
        as_of: '2026-07-22T01:03:00Z',
        candidate_count: 8,
        fresh,
      },
      multibagger: {
        research_day: fresh ? '2026-07-21' : '2026-07-16',
        as_of: '2026-07-22T01:04:00Z',
        candidate_count: 8,
        fresh,
      },
      merged_target_count: 6,
    },
    latest_run: {
      id: 7,
      portfolio_id: 1,
      portfolio_name: '研究闭环模拟盘',
      trading_day: '2026-07-22',
      research_day: '2026-07-21',
      status: 'completed',
      is_current: true,
      target_count: 6,
      buy_count: 2,
      hold_count: 3,
      sell_count: 1,
      skipped_count: 0,
      total_value: 200000,
      current_cash: 100000,
      completed_at: '2026-07-22T01:36:00Z',
      decisions: [],
    },
  };
}

describe('research loop shared UI', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  test.each(['morning', 'multibagger', 'portfolio'] as const)(
    'all three pages render one shared research day (%s)',
    async focus => {
      await act(async () =>
        root.render(<ResearchLoopStatusStrip dashboard={dashboard()} focus={focus} />)
      );
      expect(container.textContent).toContain('A股早报');
      expect(container.textContent).toContain('高倍潜力');
      expect(container.textContent).toContain('研究闭环盘');
      expect(container.textContent).toContain('研究日 2026-07-21 已对齐');
      expect(container.textContent).toContain('买 2 · 持 3 · 卖 1');
    }
  );

  test('stale research visibly blocks trading', async () => {
    await act(async () =>
      root.render(<ResearchLoopStatusStrip dashboard={dashboard(false)} focus="portfolio" />)
    );
    expect(container.textContent).toContain('研究数据未到齐，暂停交易');
    expect(container.textContent).toContain('2026-07-16');
  });

  test('responsive contract keeps the loop flow and decisions usable on mobile', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../catdesk.css'), 'utf8');
    expect(css).toMatch(/\.catdesk-loop-strip\s*\{/);
    expect(css).toMatch(/\.catdesk-loop-decisions\s*\{/);
    expect(css).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.catdesk-loop-decisions\s*\{[\s\S]*grid-template-columns: 1fr/
    );
  });
});
