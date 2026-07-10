import React from 'react';
import { Progress } from 'antd';

interface RelevanceComponent {
  label: string;
  value: number;
  color: string;
}

interface RelevanceBreakdownCardProps {
  components?: RelevanceComponent[];
}

const DEFAULT_COMPONENTS: RelevanceComponent[] = [
  { label: 'sector_map', value: 35, color: '#3b82f6' },
  { label: 'revenue_exposure', value: 25, color: '#22c55e' },
  { label: 'adr_parity', value: 20, color: '#f59e0b' },
  { label: 'supply_chain', value: 15, color: '#8b5cf6' },
  { label: 'historical_beta', value: 5, color: '#ec4899' },
];

const cardStyle: React.CSSProperties = {
  background: 'var(--cd-bg-surface)',
  border: '1px solid var(--cd-border)',
  borderRadius: 'var(--cd-radius-md)',
  padding: 16,
};

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--cd-text-primary)',
  marginBottom: 12,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
};

const labelStyle: React.CSSProperties = {
  width: 64,
  fontSize: 12,
  color: 'var(--cd-text-secondary)',
};

export function RelevanceBreakdownCard({ components = DEFAULT_COMPONENTS }: RelevanceBreakdownCardProps) {
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>相关性分解</div>
      {components.map((c) => (
        <div key={c.label} style={rowStyle}>
          <span style={labelStyle}>{c.label}</span>
          <Progress
            percent={c.value}
            strokeColor={c.color}
            trailColor="var(--cd-border)"
            size="small"
            style={{ flex: 1 }}
            format={(p) => `${p}%`}
          />
        </div>
      ))}
    </div>
  );
}
