import React from 'react';
import type { JpKrFxKpiSnapshot, JpKrIndexKpiSnapshot, JpKrKpi, JpKrMarket } from './types';

type KpiDefinition = {
  key: keyof JpKrKpi;
  label: string;
  expected_source: string;
  kind: 'index' | 'fx';
};

const KPI_DEFINITIONS: readonly KpiDefinition[] = [
  { key: 'nikkei225', label: '日经 225', expected_source: '日本交易所', kind: 'index' },
  { key: 'topix', label: '东证指数', expected_source: '日本交易所', kind: 'index' },
  { key: 'kospi', label: '韩国综合指数', expected_source: 'Naver 公开行情', kind: 'index' },
  { key: 'usdjpy', label: '美元兑日元', expected_source: '日本央行', kind: 'fx' },
  { key: 'usdkrw', label: '美元兑韩元', expected_source: '韩国央行', kind: 'fx' },
];

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  JPX: '日本交易所',
  BOJ: '日本央行',
  BOK: '韩国央行',
  'naver-public': 'Naver 公开行情',
};

export function formatKpiSourceLabel(sourceKind: string): string {
  return SOURCE_LABELS[sourceKind] || sourceKind;
}

function formatValue(snapshot: JpKrIndexKpiSnapshot | JpKrFxKpiSnapshot): string {
  const value = 'value' in snapshot ? snapshot.value : snapshot.rate;
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 10 ? 4 : 2,
  }).format(value);
}

function formatDelta(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function JpKrKpiStrip({ kpi, market }: { kpi: JpKrKpi; market: JpKrMarket }) {
  const definitions = KPI_DEFINITIONS.filter(definition =>
    market === 'KR'
      ? definition.key === 'kospi' || definition.key === 'usdkrw'
      : definition.key === 'nikkei225' || definition.key === 'topix' || definition.key === 'usdjpy'
  );
  return (
    <section
      className={`jpkr-kpi-strip jpkr-kpi-strip--${market.toLowerCase()}`}
      aria-label={`${market === 'KR' ? '韩国' : '日本'}市场关键指标`}
    >
      {definitions.map(definition => {
        const snapshot = kpi[definition.key];
        if (!snapshot) {
          return (
            <article
              className="jpkr-kpi-card jpkr-kpi-card--unavailable"
              data-state="unavailable"
              key={definition.key}
              aria-label={`${definition.label} 暂无数据`}
            >
              <div className="jpkr-kpi-card__heading">
                <span>{definition.label}</span>
                <small>{definition.expected_source}</small>
              </div>
              <strong>暂无数据</strong>
              <span className="jpkr-kpi-card__as-of">当前数据链未提供</span>
            </article>
          );
        }

        const delta = formatDelta(snapshot.change_pct);
        const deltaState =
          snapshot.change_pct > 0 ? 'up' : snapshot.change_pct < 0 ? 'down' : 'flat';
        return (
          <article
            className="jpkr-kpi-card"
            data-state="available"
            data-kind={definition.kind}
            key={definition.key}
            aria-label={`${definition.label} ${formatValue(snapshot)}, ${delta}, 截至 ${snapshot.as_of}`}
          >
            <div className="jpkr-kpi-card__heading">
              <span>{definition.label}</span>
              <small>{formatKpiSourceLabel(snapshot.source_kind)}</small>
            </div>
            <div className="jpkr-kpi-card__quote">
              <strong>{formatValue(snapshot)}</strong>
              <span data-delta={deltaState}>{delta}</span>
            </div>
            <span className="jpkr-kpi-card__as-of">截至 {snapshot.as_of}</span>
          </article>
        );
      })}
    </section>
  );
}
