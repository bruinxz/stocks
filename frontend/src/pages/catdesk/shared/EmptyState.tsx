import React from 'react';
import { Empty } from 'antd';

interface EmptyStateProps {
  title?: string;
  variant?: 'default' | 'simple';
}

export function EmptyState({ title, variant = 'default' }: EmptyStateProps) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 300 }}>
      <Empty
        image={variant === 'simple' ? Empty.PRESENTED_IMAGE_SIMPLE : Empty.PRESENTED_IMAGE_DEFAULT}
        description={title ?? '暂无数据'}
      />
    </div>
  );
}
