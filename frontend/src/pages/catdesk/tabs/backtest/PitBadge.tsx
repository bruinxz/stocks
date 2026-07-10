import React from 'react';
import { Tag, Tooltip } from 'antd';
import type { BacktestSnapshotSlot } from './types';

interface PitBadgeProps {
  snapshot: BacktestSnapshotSlot;
}

export function PitBadge({ snapshot }: PitBadgeProps) {
  return (
    <div className="pit-badge">
      <Tag color="blue">PIT · as_of {snapshot.as_of_utc}</Tag>

      {snapshot.is_survivorship_biased && (
        <Tooltip title="此快照可能存在幸存者偏差 · 已退市标的在回测期间仍被纳入">
          <Tag color="red">幸存者偏差</Tag>
        </Tooltip>
      )}

      {snapshot.is_delisted_at_as_of && (
        <Tooltip title="此标的在 as_of 时刻已退市">
          <Tag color="orange">已退市</Tag>
        </Tooltip>
      )}
    </div>
  );
}
