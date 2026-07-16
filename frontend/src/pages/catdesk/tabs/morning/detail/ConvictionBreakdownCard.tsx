import React from 'react';
import { Progress, Tag } from 'antd';

interface Adjustment {
  label: string;
  delta: number;
}

interface ConvictionBreakdownCardProps {
  base?: number;
  adjustments?: Adjustment[];
  final?: number;
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
  justifyContent: 'space-between',
  fontSize: 12,
  marginBottom: 6,
};

function deltaColor(d: number): string {
  if (d > 0) return 'green';
  if (d < 0) return 'red';
  return 'default';
}

function deltaText(d: number): string {
  return d > 0 ? `+${d}` : String(d);
}

export function ConvictionBreakdownCard({
  base = 50,
  adjustments = [],
  final: finalVal,
}: ConvictionBreakdownCardProps) {
  const computed = finalVal ?? adjustments.reduce((acc, a) => acc + a.delta, base);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>确信度分解</div>
      <div style={rowStyle}>
        <span style={{ color: 'var(--cd-text-secondary)' }}>基础分</span>
        <span style={{ fontFamily: 'var(--cd-font-mono)', fontWeight: 600 }}>{base}</span>
      </div>
      {adjustments.map(a => (
        <div key={a.label} style={rowStyle}>
          <span style={{ color: 'var(--cd-text-secondary)' }}>{a.label}</span>
          <Tag color={deltaColor(a.delta)}>{deltaText(a.delta)}</Tag>
        </div>
      ))}
      <div style={{ marginTop: 8 }}>
        <div style={{ ...rowStyle, marginBottom: 4 }}>
          <span style={{ fontWeight: 600 }}>最终确信度</span>
          <span style={{ fontFamily: 'var(--cd-font-mono)', fontWeight: 600 }}>{computed}%</span>
        </div>
        <Progress
          percent={computed}
          strokeColor={
            computed >= 75
              ? 'var(--cd-up)'
              : computed >= 50
                ? 'var(--cd-accent)'
                : 'var(--cd-text-secondary)'
          }
          trailColor="var(--cd-border)"
          showInfo={false}
        />
      </div>
    </div>
  );
}
