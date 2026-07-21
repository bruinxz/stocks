import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { LoadingState } from '../shared/LoadingState';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { DisclaimerFooter } from '../shared/DisclaimerFooter';
import { loadUsTechMarket, type UsTechInstrument } from './us/techMarket';
import './us/us-tech.css';

function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function delta(value: number | null): string {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function deltaDirection(value: number | null): 'up' | 'down' | 'flat' {
  if (value == null || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

function compactUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function InstrumentRows({ rows }: { rows: UsTechInstrument[] }) {
  return (
    <div className="us-tech-table" role="table" aria-label="美股科技代表股">
      <div className="us-tech-table__row us-tech-table__head" role="row">
        <span role="columnheader">标的</span>
        <span role="columnheader">科技主题</span>
        <span role="columnheader">收盘价</span>
        <span role="columnheader">单日</span>
        <span role="columnheader">近 5 日</span>
      </div>
      {rows.map(row => (
        <div className="us-tech-table__row" role="row" key={row.symbol}>
          <span className="us-tech-table__identity" role="cell">
            <strong>{row.symbol}</strong>
            <small>{row.name}</small>
          </span>
          <span role="cell">{row.sector_label}</span>
          <span className="us-tech-table__number" role="cell">
            ${row.close.toFixed(2)}
          </span>
          <span data-delta={deltaDirection(row.change_pct)} role="cell">
            {delta(row.change_pct)}
          </span>
          <span data-delta={deltaDirection(row.change_5d_pct)} role="cell">
            {delta(row.change_5d_pct)}
          </span>
        </div>
      ))}
    </div>
  );
}

export type USStockPicksProps = { tradingDay?: string };

export default function USStockPicks({ tradingDay }: USStockPicksProps = {}) {
  const date = tradingDay ?? todayInShanghai();
  const { data, loading, error } = useAbortableRequest(
    signal => loadUsTechMarket(signal, date),
    [date]
  );

  if (loading && !data) {
    return (
      <LoadingState
        title="正在整理美股科技盘面"
        description="按板块代理 ETF、代表股与成交关注度归档…"
        mood="curious"
      />
    );
  }
  if (error && !data) return <ErrorState message="美股科技行情暂时不可用" />;
  if (!data || data.sector_performance.length === 0) {
    return <EmptyState title="当前尚无可用的美股科技行情" variant="simple" />;
  }

  return (
    <div className="us-tech-market">
      <header className="us-tech-hero">
        <div>
          <span className="us-tech-eyebrow">US TECHNOLOGY TAPE · {data.as_of ?? date}</span>
          <h2>先看科技板块，再看代表标的</h2>
          <p>板块按代理 ETF 单日涨幅排序；个股与 ETF 只保留高辨识度科技标的。</p>
        </div>
        <div className="us-tech-summary" aria-label="美股科技盘面摘要">
          <span>
            领涨 <strong>{data.market_summary.leader_sector_label ?? '—'}</strong>
          </span>
          <span data-delta={deltaDirection(data.market_summary.leader_change_pct)}>
            {delta(data.market_summary.leader_change_pct)}
          </span>
          <span>
            上涨板块 {data.market_summary.advancing_sectors}/{data.market_summary.sector_count}
          </span>
        </div>
      </header>

      <section className="us-tech-section" aria-labelledby="us-sector-title">
        <div className="us-tech-section__heading">
          <div>
            <span>01 / SECTOR FIRST</span>
            <h3 id="us-sector-title">科技板块涨幅</h3>
          </div>
          <p>代理 ETF 口径 · 从强到弱</p>
        </div>
        <div className="us-sector-board">
          {data.sector_performance.map((sector, index) => (
            <article className="us-sector-card" key={sector.sector}>
              <span className="us-sector-card__rank">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <h4>{sector.sector_label}</h4>
                <small>{sector.proxy_symbol} · 板块代理</small>
              </div>
              <strong data-delta={deltaDirection(sector.change_pct)}>
                {delta(sector.change_pct)}
              </strong>
              <span className="us-sector-card__five-day">
                近 5 日 {delta(sector.change_5d_pct)}
              </span>
            </article>
          ))}
        </div>
      </section>

      <section className="us-tech-section" aria-labelledby="us-stock-title">
        <div className="us-tech-section__heading">
          <div>
            <span>02 / REPRESENTATIVES</span>
            <h3 id="us-stock-title">突出科技股</h3>
          </div>
          <p>{data.representative_tech_stocks.length} 只固定代表股 · 随领涨板块排序</p>
        </div>
        <InstrumentRows rows={data.representative_tech_stocks} />
      </section>

      <section className="us-tech-section" aria-labelledby="us-etf-title">
        <div className="us-tech-section__heading">
          <div>
            <span>03 / ETF ATTENTION</span>
            <h3 id="us-etf-title">高关注科技 ETF</h3>
          </div>
          <p>按最新日成交额排序</p>
        </div>
        <div className="us-etf-list">
          {data.focus_etfs.map(etf => (
            <article className="us-etf-card" key={etf.symbol}>
              <span className="us-etf-card__rank">#{etf.attention_rank}</span>
              <div>
                <strong>{etf.symbol}</strong>
                <small>{etf.name}</small>
              </div>
              <span>{etf.sector_label}</span>
              <span className="us-etf-card__turnover">{compactUsd(etf.notional_volume)}</span>
              <strong data-delta={deltaDirection(etf.change_pct)}>{delta(etf.change_pct)}</strong>
            </article>
          ))}
        </div>
      </section>

      <p className="us-tech-source-note">
        行情来源：Yahoo Finance 公开 chart 数据。
        <br />
        “关注度”仅指最新交易日成交额，不代表推荐或资金流向。
      </p>
      <DisclaimerFooter disclaimerKey="size_hint_advisory" />
    </div>
  );
}
