import React from 'react';
import { Card, Statistic, Tooltip } from 'antd';
import type { KpiSlot } from '../../shared/KpiBar';

interface MetricsCardsProps {
  kpiSlots: KpiSlot[];
}

export function MetricsCards({ kpiSlots }: MetricsCardsProps) {
  if (!kpiSlots.length) return null;

  return (
    <div className="metrics-cards">
      {kpiSlots.map(slot => (
        <Tooltip key={slot.label} title={slot.tooltip}>
          <Card size="small" className="metric-card">
            <Statistic title={slot.label} value={slot.value} suffix={slot.delta} />
          </Card>
        </Tooltip>
      ))}
    </div>
  );
}
