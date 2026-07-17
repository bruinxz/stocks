import React from 'react';
import api from '../../../../services/api';
import { useAbortableRequest } from '../../../../shared/hooks/useAbortableRequest';
import { buildAShareEditorialCopy, signedPercent, type DailyMarketBrief } from './editorial';
import type { DailyReportDocument } from './types';

async function loadDailyMarketBrief(
  tradingDay: string,
  signal: AbortSignal
): Promise<DailyMarketBrief> {
  const response = await api.get('/market/daily-brief', {
    signal,
    params: { date: tradingDay },
  });
  if (!response.data?.success || !response.data?.data) {
    throw new Error(response.data?.message || 'A 股收盘简报暂不可用');
  }
  return response.data.data as DailyMarketBrief;
}

function formatPrice(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}

export function AShareEditorialSummary({ report }: { report: DailyReportDocument }) {
  const { data, loading, error, refetch } = useAbortableRequest(
    signal => loadDailyMarketBrief(report.trading_day, signal),
    [report.trading_day]
  );

  if (loading) {
    return (
      <section className="editorial-lead editorial-lead--loading" aria-busy="true">
        <span className="report-eyebrow">A 股主稿</span>
        <div className="editorial-loading-line" />
        <div className="editorial-loading-line editorial-loading-line--short" />
        <p>正在把指数、板块与个股整理成一篇收盘稿…</p>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="editorial-lead editorial-lead--unavailable">
        <span className="report-eyebrow">A 股主稿</span>
        <h1>A 股观察：先看研究线索，收盘数据稍后补齐</h1>
        <p>指数与板块收盘稿暂未就绪，不影响下方个股证据阅读。</p>
        <button type="button" onClick={refetch}>
          重新整理收盘数据
        </button>
      </section>
    );
  }

  const copy = buildAShareEditorialCopy(data, report);
  return (
    <section className="editorial-lead" data-tone={copy.tone} aria-label="A 股收盘主稿">
      <div className="editorial-byline">
        <span>九点牛研 · 收盘编辑部</span>
        <time>{data.trade_date}</time>
        <span>重点：A 股</span>
      </div>
      <h1>{copy.headline}</h1>
      <p className="editorial-deck">{copy.lead}</p>

      <figure className="index-tape">
        <figcaption>主要指数收盘</figcaption>
        <div className="index-tape__scroll">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>涨跌幅</th>
                <th>现价</th>
                <th>涨跌</th>
                <th>近 5 日</th>
              </tr>
            </thead>
            <tbody>
              {data.indices.map(index => (
                <tr key={index.symbol} data-direction={index.change_percent >= 0 ? 'up' : 'down'}>
                  <th>{index.name}</th>
                  <td>{signedPercent(index.change_percent)}</td>
                  <td>{formatPrice(index.current_price)}</td>
                  <td>
                    {index.change > 0 ? '+' : ''}
                    {index.change.toFixed(2)}
                  </td>
                  <td>
                    {index.five_day_change_percent == null
                      ? '—'
                      : signedPercent(index.five_day_change_percent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <small>采用覆盖率达到 95% 的最近完整交易日，不使用盘中残缺快照。</small>
      </figure>

      <div className="editorial-columns">
        <div>
          <span className="editorial-section-number">01</span>
          <h2>板块与市场宽度</h2>
          <p>{copy.sector_paragraph}</p>
          <p>{copy.mover_paragraph}</p>
        </div>
        <aside>
          <span>盘面温度</span>
          <strong>
            {copy.tone === 'positive' ? '偏暖' : copy.tone === 'cautious' ? '谨慎' : '均衡'}
          </strong>
          <dl>
            <div>
              <dt>上涨</dt>
              <dd>{data.breadth.advancing_count}</dd>
            </div>
            <div>
              <dt>下跌</dt>
              <dd>{data.breadth.declining_count}</dd>
            </div>
            <div>
              <dt>平盘</dt>
              <dd>{data.breadth.flat_count}</dd>
            </div>
          </dl>
        </aside>
      </div>

      <blockquote>{copy.watch_paragraph}</blockquote>
    </section>
  );
}
