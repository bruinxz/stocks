interface USFilterBarProps {
  sector: string | null;
  ratingMin: string | null;
  onSectorChange: (v: string | null) => void;
  onRatingChange: (v: string | null) => void;
}

const RATING_OPTIONS: { label: string; value: string | null }[] = [
  { label: '全部', value: null },
  { label: '≥A', value: 'A' },
  { label: '≥B', value: 'B' },
  { label: '≥C', value: 'C' },
];

const chipBase: React.CSSProperties = {
  padding: '4px 12px',
  border: '1px solid var(--cd-border)',
  borderRadius: 'var(--cd-radius-md)',
  background: 'transparent',
  color: 'var(--cd-text-secondary)',
  fontSize: 12,
  cursor: 'pointer',
};

const chipActive: React.CSSProperties = {
  ...chipBase,
  background: 'var(--cd-accent)',
  borderColor: 'var(--cd-accent)',
  color: '#fff',
};

export function USFilterBar({ sector, ratingMin, onSectorChange, onRatingChange }: USFilterBarProps) {
  return (
    <div style={{ display: 'flex', gap: 24, padding: '8px 0', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--cd-text-secondary)', minWidth: 48 }}>Rating</span>
        {RATING_OPTIONS.map((o) => (
          <button
            key={o.label}
            type="button"
            style={ratingMin === o.value ? chipActive : chipBase}
            onClick={() => onRatingChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
