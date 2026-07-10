import React from 'react';
import { Tooltip } from 'antd';

export interface KpiSlot {
  label: string;
  value: string;
  delta?: string;
  tooltip?: string;
}

interface KpiBarProps {
  slots: KpiSlot[];
}

const barStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  height: 'var(--cd-kpi-h)',
  background: 'var(--cd-bg-surface)',
  borderBottom: '1px solid var(--cd-border)',
  padding: '0 16px',
  gap: 0,
};

const slotStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 16px',
};

const dividerStyle: React.CSSProperties = {
  width: 1,
  height: 24,
  background: 'var(--cd-border)',
};

const labelStyle: React.CSSProperties = {
  color: 'var(--cd-text-secondary)',
  fontSize: 12,
};

const valueStyle: React.CSSProperties = {
  fontFamily: 'var(--cd-font-mono)',
  fontWeight: 600,
};

function deltaColor(delta?: string): string | undefined {
  if (!delta) return undefined;
  if (delta.startsWith('+')) return 'var(--cd-up)';
  if (delta.startsWith('-')) return 'var(--cd-down)';
  return undefined;
}

export function KpiBar({ slots }: KpiBarProps) {
  if (slots.length === 0) return null;

  return (
    <div style={barStyle}>
      {slots.map((slot, i) => {
        const content = (
          <div key={slot.label} style={slotStyle}>
            <span style={labelStyle}>{slot.label}</span>
            <span style={valueStyle}>{slot.value}</span>
            {slot.delta && (
              <span style={{ color: deltaColor(slot.delta), fontSize: 12 }}>
                {slot.delta}
              </span>
            )}
          </div>
        );

        return (
          <React.Fragment key={slot.label}>
            {i > 0 && <div style={dividerStyle} />}
            {slot.tooltip ? (
              <Tooltip title={slot.tooltip}>{content}</Tooltip>
            ) : (
              content
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
