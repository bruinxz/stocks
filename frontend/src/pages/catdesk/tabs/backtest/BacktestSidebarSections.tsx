import React from 'react';
import type { DetailSection } from 'shared/components/DetailSidebar';
import type { BacktestSnapshotSlot, BacktestHolding } from './types';
import { HoldingsTable } from './HoldingsTable';
import { Tag } from 'antd';
import { MARKET_SCOPE_LABELS, PROFILE_LABELS } from '../../shared/uiLabels';

export function buildBacktestSidebarSections(
  snapshot: BacktestSnapshotSlot,
  holdings: BacktestHolding[],
  holdingsLoading: boolean,
  holdingsError: Error | null
): DetailSection[] {
  return [
    {
      key: 'pit-metadata',
      title: '历史时点元数据',
      ariaLabel: '历史时点元数据信息',
      content: (
        <div>
          <p>
            <strong>快照日</strong>: {snapshot.snapshot_day}
          </p>
          <p>
            <strong>冻结时间</strong>: {snapshot.as_of_utc}
          </p>
          <p>
            <strong>策略</strong>：{PROFILE_LABELS[snapshot.strategy] ?? snapshot.strategy}
          </p>
          <p>
            <strong>市场范围</strong>：
            {MARKET_SCOPE_LABELS[snapshot.market_scope] ?? snapshot.market_scope}
          </p>
          <p>
            <strong>事实指纹</strong>：<code>{snapshot.fact_hash || '--'}</code>
          </p>
          <p>
            <strong>幸存者偏差</strong>:{' '}
            {snapshot.is_survivorship_biased ? (
              <Tag color="red">是</Tag>
            ) : (
              <Tag color="green">否</Tag>
            )}
          </p>
          {snapshot.is_delisted_at_as_of && (
            <p>
              <Tag color="orange">标的在 as_of 时刻已退市</Tag>
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'metrics-detail',
      title: '指标明细',
      ariaLabel: '回测指标明细',
      content: (
        <div>
          <p>
            <strong>累计净值</strong>: {snapshot.net_value?.toFixed(4) ?? '--'}
          </p>
          <p>
            <strong>累计收益</strong>:{' '}
            {snapshot.cumulative_return != null
              ? `${(snapshot.cumulative_return * 100).toFixed(2)}%`
              : '--'}
          </p>
          <p>
            <strong>最大回撤</strong>:{' '}
            {snapshot.drawdown != null ? `${(snapshot.drawdown * 100).toFixed(2)}%` : '--'}
          </p>
          <p>
            <strong>夏普比率（6个月）</strong>：{snapshot.sharpe_ratio_6m?.toFixed(2) ?? '--'}
          </p>
          <p>
            <strong>胜率（6个月）</strong>：{' '}
            {snapshot.win_rate_6m != null ? `${(snapshot.win_rate_6m * 100).toFixed(1)}%` : '--'}
          </p>
        </div>
      ),
    },
    {
      key: 'holdings',
      title: `持仓明细 (${holdings.length})`,
      ariaLabel: '回测持仓明细列表',
      content: holdingsError ? (
        <div role="alert">持仓明细加载失败：{holdingsError.message}</div>
      ) : (
        <HoldingsTable holdings={holdings} loading={holdingsLoading} />
      ),
    },
  ];
}
