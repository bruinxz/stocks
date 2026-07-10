import React from 'react';
import { Collapse, Drawer, Progress, Skeleton, Tag, Tooltip, Typography } from 'antd';
import type {
  Band,
  Conviction,
  EntryPlan,
  RiskGate,
  Score,
} from '../types/catdesk';

const { Text } = Typography;

export type DetailSection = {
  key: string;
  title: string;
  ariaLabel: string;
  content: React.ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
};

export type DetailSidebarProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  ariaLabel: string;
  sections: DetailSection[];
  loading?: boolean;
  errorText?: React.ReactNode;
  emptyText?: React.ReactNode;
  width?: number | string;
  className?: string;
};

export function DetailSidebar({
  open,
  onClose,
  title,
  subtitle,
  ariaLabel,
  sections,
  loading,
  errorText,
  emptyText,
  width = 480,
  className,
}: DetailSidebarProps) {
  const renderBody = () => {
    if (loading) {
      return <Skeleton active paragraph={{ rows: 8 }} />;
    }
    if (errorText) {
      return <div role="alert" aria-live="polite">{errorText}</div>;
    }
    if (sections.length === 0) {
      return (
        <div style={{ color: '#999', textAlign: 'center', padding: 24 }}>
          {emptyText ?? '暂无详情'}
        </div>
      );
    }

    const collapsibleSections = sections.filter((s) => s.collapsible);
    const fixedSections = sections.filter((s) => !s.collapsible);

    return (
      <>
        {fixedSections.map((section) => (
          <div
            key={section.key}
            aria-label={section.ariaLabel}
            style={{ marginBottom: 16 }}
          >
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              {section.title}
            </Text>
            {section.content}
          </div>
        ))}
        {collapsibleSections.length > 0 && (
          <Collapse
            defaultActiveKey={collapsibleSections
              .filter((s) => !s.defaultCollapsed)
              .map((s) => s.key)}
            ghost
            items={collapsibleSections.map((section) => ({
              key: section.key,
              label: section.title,
              children: (
                <div aria-label={section.ariaLabel}>{section.content}</div>
              ),
            }))}
          />
        )}
      </>
    );
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        <div>
          <div>{title}</div>
          {subtitle && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {subtitle}
            </Text>
          )}
        </div>
      }
      width={width}
      aria-label={ariaLabel}
      className={className}
      destroyOnClose
    >
      {renderBody()}
    </Drawer>
  );
}

// --- Embedded cards ---

const BAND_COLOR: Record<Band, string> = {
  A: '#389e0d',
  B: '#52c41a',
  C: '#faad14',
  D: '#fa8c16',
  F: '#cf1322',
};

const DIM_LABELS: Record<string, string> = {
  quality: '质量',
  growth: '成长',
  valuation: '估值',
  moat: '护城河',
  trend: '趋势',
  risk: '风险',
};

type ScoreBreakdownCardProps = {
  scores: Record<string, { score: number; band: string }>;
  ariaLabel: string;
  weights?: Record<string, number>;
};

export function ScoreBreakdownCard({
  scores,
  ariaLabel,
  weights,
}: ScoreBreakdownCardProps) {
  return (
    <div aria-label={ariaLabel}>
      {Object.entries(scores).map(([dim, val]) => (
        <div key={dim} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Text>{DIM_LABELS[dim] ?? dim}</Text>
            <span>
              <Tag color={BAND_COLOR[val.band as Band] ?? undefined} style={{ marginRight: 4 }}>
                {val.band}
              </Tag>
              <Text>{val.score}</Text>
              {weights?.[dim] != null && (
                <Text type="secondary" style={{ marginLeft: 4, fontSize: 11 }}>
                  w={weights[dim]}
                </Text>
              )}
            </span>
          </div>
          <Progress
            percent={val.score}
            size="small"
            showInfo={false}
            strokeColor={BAND_COLOR[val.band as Band] ?? '#1890ff'}
          />
        </div>
      ))}
    </div>
  );
}

const DISCLAIMER_TEXT = '仅供参考，非投资建议或下单指令';

type EntryPlanCardProps = {
  plan: EntryPlan;
  ariaLabel: string;
};

export function EntryPlanCard({ plan, ariaLabel }: EntryPlanCardProps) {
  const { tier, pct } = plan.size_hint;
  const tierLabel = tier === 'SKIP' ? 'SKIP' : `${pct}%`;

  return (
    <div aria-label={ariaLabel}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <Text type="secondary">价格区间</Text>
          <div>
            {plan.price_band.low} – {plan.price_band.high} {plan.price_band.currency}
          </div>
        </div>
        <div>
          <Text type="secondary">止损</Text>
          <div>{plan.stop} {plan.price_band.currency}</div>
        </div>
        <div>
          <Text type="secondary">目标价</Text>
          <div>{plan.targets.map((t) => t.toString()).join(' / ')}</div>
        </div>
        <div>
          <Text type="secondary">时间维度</Text>
          <div>{plan.time_horizon}</div>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <Text type="secondary">建议仓位</Text>
        <div>
          <Tag>{tierLabel}</Tag>
          {tier !== 'SKIP' && (
            <Progress
              percent={(pct / 5) * 100}
              size="small"
              showInfo={false}
              style={{ width: 100, display: 'inline-block', marginLeft: 8 }}
            />
          )}
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <Text type="secondary">失效条件</Text>
        <div>{plan.invalidation}</div>
      </div>
      <Tooltip title={DISCLAIMER_TEXT}>
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: '#999',
            cursor: 'help',
          }}
        >
          {DISCLAIMER_TEXT}
        </div>
      </Tooltip>
    </div>
  );
}

type RiskGateDetailCardProps = {
  gate: RiskGate;
  ariaLabel: string;
};

export function RiskGateDetailCard({ gate, ariaLabel }: RiskGateDetailCardProps) {
  const severityColor: Record<string, string> = {
    high: '#cf1322',
    medium: '#faad14',
    low: '#389e0d',
  };

  return (
    <div aria-label={ariaLabel}>
      <div style={{ marginBottom: 8 }}>
        <Text strong>状态: </Text>
        <Tag
          color={
            gate.status === 'GREEN'
              ? '#389e0d'
              : gate.status === 'YELLOW'
                ? '#faad14'
                : '#cf1322'
          }
        >
          {gate.status}
        </Tag>
        <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
          {new Date(gate.evaluated_at).toLocaleString()}
        </Text>
      </div>
      {gate.triggers.length === 0 ? (
        <Text type="secondary">无触发</Text>
      ) : (
        gate.triggers.map((t, i) => (
          <div
            key={`${t.code}-${i}`}
            style={{
              padding: '4px 0',
              borderBottom: '1px solid #f0f0f0',
            }}
          >
            <Tag color={severityColor[t.severity]}>{t.code}</Tag>
            <Tag>{t.severity}</Tag>
            <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
              {t.detail}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

type ConvictionBreakdownCardProps = {
  c: Conviction;
  ariaLabel: string;
};

export function ConvictionBreakdownCard({
  c,
  ariaLabel,
}: ConvictionBreakdownCardProps) {
  const adjSum = c.adjustments.reduce((s, a) => s + a.delta, 0);

  return (
    <div aria-label={ariaLabel}>
      <div style={{ marginBottom: 8 }}>
        <Text>Base: {c.base}</Text>
        {c.adjustments.length > 0 && (
          <Text style={{ marginLeft: 8 }}>
            + adjustments ({adjSum > 0 ? '+' : ''}
            {adjSum})
          </Text>
        )}
        <Text strong style={{ marginLeft: 8 }}>
          = {c.final} ({c.level})
        </Text>
      </div>
      {c.adjustments.map((adj, i) => (
        <div
          key={i}
          style={{
            padding: '4px 0',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <span style={{ color: adj.delta > 0 ? '#389e0d' : '#cf1322' }}>
            {adj.delta > 0 ? '+' : ''}
            {adj.delta}
          </span>
          <Text style={{ marginLeft: 8 }}>{adj.reason}</Text>
          {adj.kind_ref && (
            <Tag style={{ marginLeft: 4 }}>{adj.kind_ref}</Tag>
          )}
        </div>
      ))}
    </div>
  );
}

type DataSourceBadgeProps = {
  sources: string[];
  ariaLabel: string;
};

export function DataSourceBadge({ sources, ariaLabel }: DataSourceBadgeProps) {
  return (
    <div aria-label={ariaLabel}>
      {sources.map((src) => (
        <Tag key={src} color="blue" style={{ marginBottom: 4 }}>
          {src}
        </Tag>
      ))}
    </div>
  );
}
