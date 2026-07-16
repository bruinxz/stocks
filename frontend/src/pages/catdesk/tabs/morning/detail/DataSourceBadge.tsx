import React from 'react';
import { Tag } from 'antd';

interface DataSourceBadgeProps {
  sources?: string[];
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

export function DataSourceBadge({ sources = [] }: DataSourceBadgeProps) {
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>数据来源</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {sources.length === 0 && (
          <span style={{ color: 'var(--cd-text-secondary)', fontSize: 12 }}>
            当前快照未提供来源引用
          </span>
        )}
        {sources.map(s => (
          <Tag key={s} color="default">
            {s}
          </Tag>
        ))}
      </div>
    </div>
  );
}
