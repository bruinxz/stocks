import React from 'react';
import { Badge, Tooltip } from 'antd';

type Band = 'A' | 'B' | 'C' | 'D' | 'F';

interface Dimension {
  label: string;
  band: Band;
}

interface ScoreBreakdownCardProps {
  scoringId?: string;
  snapshotHash?: string;
  dimensions?: Dimension[];
  totalBand?: Band;
}

const BAND_COLORS: Record<Band, string> = {
  A: '#22c55e',
  B: '#3b82f6',
  C: '#eab308',
  D: '#f97316',
  F: '#ef4444',
};

const cardStyle: React.CSSProperties = {
  background: 'var(--cd-bg-surface)',
  border: '1px solid var(--cd-border)',
  borderRadius: 'var(--cd-radius-md)',
  padding: 16,
};

const titleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--cd-text-primary)',
};

const gridStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
};

const bandBadge = (band: Band, label: string) => (
  <span
    key={label}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 10px',
      borderRadius: 4,
      background: `${BAND_COLORS[band]}22`,
      color: BAND_COLORS[band],
      fontSize: 12,
      fontWeight: 600,
    }}
  >
    {label}: {band}
  </span>
);

export function ScoreBreakdownCard({
  scoringId = '--',
  snapshotHash = '--',
  dimensions = [],
  totalBand,
}: ScoreBreakdownCardProps) {
  if (dimensions.length === 0 || !totalBand) {
    return (
      <div style={cardStyle}>
        <div style={titleStyle}>评分分解</div>
        <div style={{ color: 'var(--cd-text-secondary)', fontSize: 12 }}>暂无评分快照</div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={titleRow}>
        <span style={titleStyle}>评分分解</span>
        <Badge count={scoringId} style={{ backgroundColor: 'var(--cd-accent)', fontSize: 10 }} />
        <Tooltip title={`snapshot: ${snapshotHash}`}>
          <span style={{ fontSize: 10, color: 'var(--cd-text-secondary)', cursor: 'help' }}>
            #{snapshotHash.slice(0, 8)}
          </span>
        </Tooltip>
      </div>
      <div style={gridStyle}>
        {dimensions.map(d => bandBadge(d.band, d.label))}
        {bandBadge(totalBand, '综合')}
      </div>
    </div>
  );
}
