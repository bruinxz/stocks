import React, { useMemo } from 'react';
import { Tooltip } from 'antd';
import type { BacktestSnapshotSlot } from './types';

interface PitTimelineProps {
  snapshots: BacktestSnapshotSlot[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function PitTimeline({ snapshots, selectedId, onSelect }: PitTimelineProps) {
  const timeline = useMemo(
    () => [...snapshots].sort((a, b) => a.snapshot_day.localeCompare(b.snapshot_day)),
    [snapshots]
  );

  if (!timeline.length) return null;

  return (
    <section className="pit-timeline-shell" aria-label="PIT 快照时间线">
      <header className="pit-timeline-shell__header">
        <div>
          <span>PIT LEDGER</span>
          <strong>证据时间线</strong>
        </div>
        <small>选择快照，核对当时可见持仓与数据版本</small>
      </header>
      <div className="pit-timeline" role="listbox" aria-label="PIT 快照列表">
        <div className="pit-timeline__rail" aria-hidden="true" />
        {timeline.map((snapshot, index) => {
          const selected = snapshot.snapshot_id === selectedId;
          const biased = snapshot.is_survivorship_biased;
          return (
            <Tooltip
              key={snapshot.snapshot_id}
              title={`${snapshot.snapshot_day} · 净值 ${snapshot.net_value?.toFixed(4) ?? '--'}`}
            >
              <button
                type="button"
                className={[
                  'pit-timeline__node',
                  selected ? 'pit-timeline__node--selected' : '',
                  biased ? 'pit-timeline__node--biased' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                role="option"
                aria-selected={selected}
                aria-label={`${snapshot.snapshot_day} PIT 快照${biased ? '，存在幸存者偏差' : ''}`}
                onClick={() => onSelect(selected ? null : snapshot.snapshot_id)}
              >
                <span className="pit-timeline__dot" />
                <span className="pit-timeline__sequence">{String(index + 1).padStart(2, '0')}</span>
                <span className="pit-timeline__date">{snapshot.snapshot_day.slice(5)}</span>
                <span className="pit-timeline__value">
                  {snapshot.net_value?.toFixed(3) ?? '--'}
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>
    </section>
  );
}
