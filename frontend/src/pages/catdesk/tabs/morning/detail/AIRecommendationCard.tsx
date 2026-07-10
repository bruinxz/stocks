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

const DEFAULT_GATES: Gate[] = [
  { label: 'trigger_signals ≥ 1', passed: true },
  { label: 'weights ∑ = 1.0', passed: true },
  { label: 'explanation non-empty', passed: true },
  { label: 'evidence_refs ≥ 1', passed: true },
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

const gateRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 6,
  fontSize: 12,
};

const DUAL_GATE_COLORS = { pass: 'green', fail: 'red', warn: 'orange' } as const;

export function AIRecommendationCard({ gates = DEFAULT_GATES, dualGate }: AIRecommendationCardProps) {
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>AI 推荐门控</div>
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
