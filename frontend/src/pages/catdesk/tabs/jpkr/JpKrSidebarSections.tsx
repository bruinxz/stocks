import React from 'react';
import { DataSourceBadge } from 'shared/components/DetailSidebar';
import type { DetailSection } from 'shared/components/DetailSidebar';
import type { JpKrMarketRow } from './types';
import { FxSensitivityCard } from './FxSensitivityCard';
import { DisclosureTimeline } from './DisclosureTimeline';

export function buildJpKrSections(row: JpKrMarketRow): DetailSection[] {
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
          ariaLabel={`${row.symbol} 汇率 beta 详情`}
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
    {
      key: 'score_breakdown',
      title: '评分拆解',
      ariaLabel: `${row.symbol} 6 维评分拆解`,
      content: (
        <div style={{ color: '#999' }}>
          Sprint 3 起消费 Strategy 6 维评分
        </div>
      ),
      collapsible: true,
      defaultCollapsed: true,
    },
    {
      key: 'entry_plan',
      title: '入场计划',
      ariaLabel: `${row.symbol} 入场计划`,
      content: (
        <div style={{ color: '#999' }}>
          Sprint 3 起消费 EntryPlan
        </div>
      ),
      collapsible: true,
      defaultCollapsed: true,
    },
    {
      key: 'data_sources',
      title: '数据来源',
      ariaLabel: `${row.symbol} 数据来源`,
      content: (
        <DataSourceBadge
          sources={row.data_sources}
          ariaLabel={`${row.symbol} 免费数据源标签`}
        />
      ),
    },
  ];

  return sections;
}
