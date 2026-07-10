import type { EntryPlan, Price } from 'shared/scoring/types';

interface EntryPlanDetailsProps {
  plan: EntryPlan;
}

function formatPrice(price: Price): string {
  return `${price.value.toFixed(2)} ${price.currency}`;
}

const labelStyle = {
  color: 'var(--cd-text-secondary)',
  fontSize: 11,
} as const;

const valueStyle = {
  fontFamily: 'var(--cd-font-mono)',
} as const;

export function EntryPlanDetails({ plan }: EntryPlanDetailsProps) {
  return (
    <div
      data-disclaimer-key={plan.size_hint.disclaimer_key}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '10px 16px',
        fontSize: 13,
      }}
    >
      <div>
        <div style={labelStyle}>价格区间</div>
        <div style={valueStyle}>
          {plan.entry.low.toFixed(2)}-{plan.entry.high.toFixed(2)} {plan.entry.currency}
        </div>
      </div>
      <div>
        <div style={labelStyle}>止损</div>
        <div style={{ ...valueStyle, color: 'var(--cd-down)' }}>{formatPrice(plan.stop)}</div>
      </div>
      <div>
        <div style={labelStyle}>目标价</div>
        <div style={valueStyle}>{plan.targets.map(formatPrice).join(' / ')}</div>
      </div>
      <div>
        <div style={labelStyle}>时间窗口</div>
        <div>{plan.time_horizon}</div>
      </div>
      <div>
        <div style={labelStyle}>仓位建议</div>
        <div style={valueStyle}>
          {plan.size_hint.tier} ≤{plan.size_hint.pct}%
        </div>
      </div>
      <div>
        <div style={labelStyle}>确信度引用</div>
        <div style={valueStyle}>{plan.conviction_ref.toFixed(1)}</div>
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <div style={labelStyle}>失效条件</div>
        <div>{plan.invalidation}</div>
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <div style={labelStyle}>审计引用</div>
        <div style={{ ...valueStyle, fontSize: 11, color: 'var(--cd-text-secondary)' }}>
          score {plan.score_ref.scoring_id} · snapshot {plan.score_ref.snapshot_hash.slice(0, 8)}
        </div>
      </div>
    </div>
  );
}
