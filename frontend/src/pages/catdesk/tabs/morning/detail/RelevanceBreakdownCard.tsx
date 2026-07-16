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

export function RelevanceBreakdownCard({ components = [] }: RelevanceBreakdownCardProps) {
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>相关性分解</div>
      {components.length === 0 && (
        <div style={{ color: 'var(--cd-text-secondary)', fontSize: 12 }}>
          当前快照未提供 catalyst_relevance
        </div>
      )}
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
