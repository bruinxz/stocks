import type { CatalystKind } from '../../types';
import { CATALYST_LABELS } from '../../shared/uiLabels';

const CATALYST_KINDS: CatalystKind[] = [
  'earnings',
  'upgrade_downgrade',
  'ma_activity',
  'sector_move',
  'regulator',
  'geo_macro',
  'product',
  'leadership',
  'unclassified',
];

const CONVICTION_LEVELS = ['all', 'med', 'high'] as const;

interface MorningFilterBarProps {
  sector: string | null;
  catalystKind: string | null;
  convictionMin: (typeof CONVICTION_LEVELS)[number];
  onSectorChange: (v: string | null) => void;
  onCatalystKindChange: (v: string | null) => void;
  onConvictionChange: (v: (typeof CONVICTION_LEVELS)[number]) => void;
  sectors: string[];
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
  background: '#ffe0d5',
  borderColor: '#c96a61',
  color: '#713630',
  fontWeight: 700,
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
  const {
    sector,
    catalystKind,
    convictionMin,
    onSectorChange,
    onCatalystKindChange,
    onConvictionChange,
    sectors,
  } = props;

  return (
    <div style={barStyle}>
      <div style={groupStyle}>
        <span style={labelStyle}>板块</span>
        <button
          type="button"
          style={sector === null ? chipActive : chipBase}
          onClick={() => onSectorChange(null)}
        >
          全部
        </button>
        {sectors.map(s => (
          <button
            key={s}
            type="button"
            style={sector === s ? chipActive : chipBase}
            onClick={() => onSectorChange(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <div style={groupStyle}>
        <span style={labelStyle}>催化</span>
        <button
          type="button"
          style={catalystKind === null ? chipActive : chipBase}
          onClick={() => onCatalystKindChange(null)}
        >
          全部
        </button>
        {CATALYST_KINDS.map(k => (
          <button
            key={k}
            type="button"
            style={catalystKind === k ? chipActive : chipBase}
            onClick={() => onCatalystKindChange(k)}
          >
            {CATALYST_LABELS[k] ?? k}
          </button>
        ))}
      </div>
      <div style={groupStyle}>
        <span style={labelStyle}>确信</span>
        {CONVICTION_LEVELS.map(lv => (
          <button
            key={lv}
            type="button"
            style={convictionMin === lv ? chipActive : chipBase}
            onClick={() => onConvictionChange(lv)}
          >
            {lv === 'all' ? '全部' : lv === 'med' ? '>=50' : '>=75'}
          </button>
        ))}
      </div>
    </div>
  );
}
