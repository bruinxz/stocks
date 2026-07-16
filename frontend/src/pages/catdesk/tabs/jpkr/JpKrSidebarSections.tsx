import React from 'react';
import { DataSourceBadge } from 'shared/components/DetailSidebar';
import type { DetailSection } from 'shared/components/DetailSidebar';
import type { JpKrMarketRow } from './types';
import { FxSensitivityCard } from './FxSensitivityCard';
import { DisclosureTimeline } from './DisclosureTimeline';
import { buildUSSections } from '../us/detail/buildUSSections';

export function buildJpKrSections(row: JpKrMarketRow): DetailSection[] {
  const recommendationSections = row.recommendation
    ? buildUSSections(row.recommendation).filter(section => section.key !== 'data_sources')
    : [
        {
          key: 'recommendation_unavailable',
          title: '策略推荐',
          ariaLabel: `${row.symbol} 策略推荐不可用`,
          content: (
            <div style={{ color: 'var(--cd-text-secondary)' }}>
              当前交易日尚未生成该标的的推荐快照；不展示占位评分或入场计划。
            </div>
          ),
        },
      ];
  const sections: DetailSection[] = [
    {
      key: 'fx_sensitivity',
      title: '汇率敏感度',
      ariaLabel: `${row.symbol} 汇率敏感度`,
      content: (
        <FxSensitivityCard
          fxBeta={row.fx_beta}
          currency={row.currency}
          revenueByRegion={row.revenue_by_region}
          ariaLabel={`${row.symbol} 汇率敏感度详情`}
        />
      ),
    },
    {
      key: 'disclosure',
      title: '披露事件',
      ariaLabel: `${row.symbol} 披露事件时间轴`,
      content: (
        <DisclosureTimeline
          events={row.disclosure_events}
          ariaLabel={`${row.symbol} 披露事件列表`}
        />
      ),
      collapsible: true,
      defaultCollapsed: row.disclosure_events.length > 5,
    },
    ...recommendationSections,
    {
      key: 'data_sources',
      title: '数据来源',
      ariaLabel: `${row.symbol} 数据来源`,
      content: (
        <DataSourceBadge
          sources={Array.from(
            new Set([...row.data_sources, ...(row.recommendation?.data_sources ?? [])])
          )}
          ariaLabel={`${row.symbol} 免费数据源标签`}
        />
      ),
    },
  ];

  return sections;
}
