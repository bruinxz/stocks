import React from 'react';
import { Tag } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';

interface Gate {
  label: string;
  passed: boolean;
}

interface AIRecommendationCardProps {
  gates?: Gate[];
  dualGate?: { label: string; status: 'pass' | 'fail' | 'warn' };
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

const gateRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 6,
  fontSize: 12,
};

const DUAL_GATE_COLORS = { pass: 'green', fail: 'red', warn: 'orange' } as const;

export function AIRecommendationCard({ gates = [], dualGate }: AIRecommendationCardProps) {
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>AI 推荐门控</div>
      {gates.length === 0 && (
        <div style={{ color: 'var(--cd-text-secondary)', fontSize: 12 }}>
          当前快照未提供推荐门控证据
        </div>
      )}
      {gates.map((g) => (
        <div key={g.label} style={gateRow}>
          {g.passed ? (
            <CheckCircleOutlined style={{ color: 'var(--cd-up)' }} />
          ) : (
            <CloseCircleOutlined style={{ color: 'var(--cd-down)' }} />
          )}
          <span style={{ color: g.passed ? 'var(--cd-text-primary)' : 'var(--cd-text-secondary)' }}>{g.label}</span>
        </div>
      ))}
      {dualGate && (
        <div style={{ marginTop: 8 }}>
          <Tag color={DUAL_GATE_COLORS[dualGate.status]}>{dualGate.label}</Tag>
        </div>
      )}
    </div>
  );
}
