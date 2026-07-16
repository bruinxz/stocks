import React, { useState } from 'react';
import { Tag } from 'antd';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { RISK_GATE_LABELS } from '../../../shared/uiLabels';

type Severity = 'info' | 'warn' | 'block';

interface RiskTrigger {
  id: string;
  label: string;
  severity: Severity;
  detail?: string;
}

interface RiskGateDetailCardProps {
  triggers?: RiskTrigger[];
  gate?: 'GREEN' | 'YELLOW' | 'RED';
  okToEnter?: boolean;
}

const SEVERITY_COLORS: Record<Severity, string> = {
  info: 'blue',
  warn: 'gold',
  block: 'red',
};

const SEVERITY_LABELS: Record<Severity, string> = {
  info: '信息',
  warn: '警告',
  block: '阻断',
};

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
  padding: '4px 0',
  fontSize: 12,
  cursor: 'pointer',
};

const detailStyle: React.CSSProperties = {
  padding: '4px 0 8px 20px',
  fontSize: 11,
  color: 'var(--cd-text-secondary)',
};

export function RiskGateDetailCard({ triggers = [], gate, okToEnter }: RiskGateDetailCardProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>风控门控详情</div>
      {gate ? (
        <div style={{ ...rowStyle, cursor: 'default', marginBottom: 8 }}>
          <span style={{ color: 'var(--cd-text-secondary)' }}>门禁结论</span>
          <Tag color={gate === 'GREEN' ? 'green' : gate === 'YELLOW' ? 'gold' : 'red'}>
            {RISK_GATE_LABELS[gate] ?? gate} · {okToEnter ? '可入场' : '不可入场'}
          </Tag>
        </div>
      ) : null}
      {triggers.length === 0 ? (
        <div style={{ color: 'var(--cd-text-secondary)', fontSize: 12 }}>无风险触发项</div>
      ) : null}
      {triggers.map(t => (
        <div key={t.id}>
          <div style={rowStyle} onClick={() => toggle(t.id)}>
            {expanded.has(t.id) ? (
              <DownOutlined style={{ fontSize: 10 }} />
            ) : (
              <RightOutlined style={{ fontSize: 10 }} />
            )}
            <span style={{ color: 'var(--cd-text-primary)', flex: 1 }}>{t.label}</span>
            <Tag color={SEVERITY_COLORS[t.severity]}>{SEVERITY_LABELS[t.severity]}</Tag>
          </div>
          {expanded.has(t.id) && t.detail && <div style={detailStyle}>{t.detail}</div>}
        </div>
      ))}
    </div>
  );
}
