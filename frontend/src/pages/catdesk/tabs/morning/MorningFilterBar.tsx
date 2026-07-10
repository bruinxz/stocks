import React from 'react';

const SECTORS = ['科技', '医药', '消费', '金融', '能源', '材料', '工业'] as const;
const CATALYST_KINDS = ['policy', 'earnings', 'sector_rotation', 'insider', 'technical', 'macro', 'news', 'institutional', 'unclassified'] as const;
const CONVICTION_LEVELS = ['all', 'med', 'high'] as const;

interface MorningFilterBarProps {
  sector: string | null;
  catalystKind: string | null;
  convictionMin: (typeof CONVICTION_LEVELS)[number];
  onSectorChange: (v: string | null) => void;
  onCatalystKindChange: (v: string | null) => void;
  onConvictionChange: (v: (typeof CONVICTION_LEVELS)[number]) => void;
}

const chipBase: React.CSSProperties = {
  padding: '4px 12px',
  border: '1px solid var(--cd-border)',
  borderRadius: 'var(--cd-radius-md)',
  background: 'transparent',
  color: 'var(--cd-text-secondary)',
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'var(--cd-font-sans)',
};

const chipActive: React.CSSProperties = {
  ...chipBase,
  background: 'var(--cd-accent)',
  borderColor: 'var(--cd-accent)',
  color: '#fff',
};

const groupStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
  alignItems: 'center',
};

const barStyle: React.CSSProperties = {
  display: 'flex',
  gap: 24,
  padding: '8px 0',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--cd-text-secondary)',
  minWidth: 48,
  lineHeight: '28px',
};

export function MorningFilterBar(props: MorningFilterBarProps) {
  const { sector, catalystKind, convictionMin, onSectorChange, onCatalystKindChange, onConvictionChange } = props;

  return (
    <div style={barStyle}>
      <div style={groupStyle}>
        <span style={labelStyle}>板块</span>
        <button type="button" style={sector === null ? chipActive : chipBase} onClick={() => onSectorChange(null)}>全部</button>
        {SECTORS.map((s) => (
          <button key={s} type="button" style={sector === s ? chipActive : chipBase} onClick={() => onSectorChange(s)}>{s}</button>
        ))}
      </div>
      <div style={groupStyle}>
        <span style={labelStyle}>催化</span>
        <button type="button" style={catalystKind === null ? chipActive : chipBase} onClick={() => onCatalystKindChange(null)}>全部</button>
        {CATALYST_KINDS.map((k) => (
          <button key={k} type="button" style={catalystKind === k ? chipActive : chipBase} onClick={() => onCatalystKindChange(k)}>{k}</button>
        ))}
      </div>
      <div style={groupStyle}>
        <span style={labelStyle}>确信</span>
        {CONVICTION_LEVELS.map((lv) => (
          <button key={lv} type="button" style={convictionMin === lv ? chipActive : chipBase} onClick={() => onConvictionChange(lv)}>
            {lv === 'all' ? '全部' : lv === 'med' ? '>=50' : '>=75'}
          </button>
        ))}
      </div>
    </div>
  );
}
