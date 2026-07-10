import React from 'react';
import { Tag } from 'antd';

interface DataSourceBadgeProps {
  sources?: string[];
}

const DEFAULT_SOURCES = ['Alpha Vantage', 'Baostock', 'Yahoo'];

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

export function DataSourceBadge({ sources = DEFAULT_SOURCES }: DataSourceBadgeProps) {
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>数据来源</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {sources.map((s) => (
          <Tag key={s} color="default">{s}</Tag>
        ))}
      </div>
    </div>
  );
}
