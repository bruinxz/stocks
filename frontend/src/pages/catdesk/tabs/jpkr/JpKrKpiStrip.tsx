import React from 'react';
import type { JpKrFxKpiSnapshot, JpKrIndexKpiSnapshot, JpKrKpi } from './types';

type KpiDefinition = {
  key: keyof JpKrKpi;
  label: string;
  source: string;
  kind: 'index' | 'fx';
};

const KPI_DEFINITIONS: readonly KpiDefinition[] = [
  { key: 'nikkei225', label: '日经 225', source: '时点指数快照', kind: 'index' },
  { key: 'topix', label: '东证指数', source: '时点指数快照', kind: 'index' },
  { key: 'kospi', label: '韩国综合指数', source: '时点指数快照', kind: 'index' },
  { key: 'usdjpy', label: '美元兑日元', source: '日本央行', kind: 'fx' },
  { key: 'usdkrw', label: '美元兑韩元', source: '韩国央行', kind: 'fx' },
];

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

export function JpKrKpiStrip({ kpi }: { kpi: JpKrKpi }) {
  return (
    <section className="jpkr-kpi-strip" aria-label="日韩市场关键指标">
      {KPI_DEFINITIONS.map(definition => {
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
                <small>{definition.source}</small>
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
              <small>{definition.source}</small>
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
