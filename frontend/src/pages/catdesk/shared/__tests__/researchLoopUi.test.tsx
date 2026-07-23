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
      targets: [
        {
          symbol: 'sh.600001',
          name: '目标股票',
          combined_score: 82,
          target_weight_pct: 12,
          sources: ['morning_brief', 'multibagger'],
        },
      ],
    },
    execution: {
      trading_day: '2026-07-22',
      status: fresh ? 'completed' : 'research_blocked',
      reason_code: fresh ? 'run_completed' : 'research_not_fresh',
      message: fresh
        ? '今日研究决策与模拟成交已完成'
        : '两份研究尚未同时到达上一完整交易日，今日自动模拟交易已暂停',
      next_attempt_label: null,
      required_quote_count: null,
      fresh_quote_count: null,
      unavailable_symbols: [],
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
      expect(container.textContent).toContain('今日目标池');
      expect(container.textContent).toContain('目标股票');
      expect(container.textContent).toContain('12% · 双源');
    }
  );

  test('stale research visibly blocks trading', async () => {
    await act(async () =>
      root.render(<ResearchLoopStatusStrip dashboard={dashboard(false)} focus="portfolio" />)
    );
    expect(container.textContent).toContain('今日自动模拟交易已暂停');
    expect(container.textContent).toContain('2026-07-16');
  });

  test('pre-open state names the real execution time instead of implying background work', async () => {
    const value = dashboard();
    value.latest_run = null;
    value.execution = {
      trading_day: '2026-07-22',
      status: 'scheduled',
      reason_code: 'NON_TRADING_HOURS_PRE_OPEN',
      message: '研究已就绪；09:35 将在今日行情齐全后执行模拟交易',
      next_attempt_label: '今日 09:35',
      required_quote_count: null,
      fresh_quote_count: null,
      unavailable_symbols: [],
    };
    await act(async () =>
      root.render(<ResearchLoopStatusStrip dashboard={value} focus="portfolio" />)
    );
    expect(container.textContent).toContain('6 只目标 · 09:35 执行');
    expect(container.textContent).toContain('今日尚未生成交易记录');
    expect(container.textContent).toContain('下次尝试 今日 09:35');
  });

  test('quote waiting state exposes coverage and the no-fabrication guarantee', async () => {
    const value = dashboard();
    value.latest_run = null;
    value.execution = {
      trading_day: '2026-07-22',
      status: 'waiting_for_quotes',
      reason_code: 'waiting_for_quotes',
      message: '正在等待目标池行情：4/6 只已就绪；不会使用昨日收盘价伪造成交',
      next_attempt_label: '今日 09:50',
      required_quote_count: 6,
      fresh_quote_count: 4,
      unavailable_symbols: ['sh.600001', 'sz.000001'],
    };
    await act(async () =>
      root.render(<ResearchLoopStatusStrip dashboard={value} focus="portfolio" />)
    );
    expect(container.textContent).toContain('6 只目标 · 行情 4/6');
    expect(container.textContent).toContain('不会使用昨日收盘价伪造成交');
  });

  test('infrastructure failures are visible and suspend automatic trading', async () => {
    await act(async () =>
      root.render(
        <ResearchLoopStatusStrip
          dashboard={null}
          error={new Error('研究交易闭环尚未完成初始化，已暂停自动模拟交易')}
          focus="portfolio"
        />
      )
    );
    expect(container.textContent).toContain('研究闭环未就绪');
    expect(container.textContent).toContain('已暂停自动模拟交易');
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
