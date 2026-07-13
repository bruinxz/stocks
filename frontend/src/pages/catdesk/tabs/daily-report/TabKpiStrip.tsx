import React from 'react';
import type { KpiSlot } from '../../shared/KpiBar';

export function TabKpiStrip({ slots }: { slots: KpiSlot[] }) {
  return (
    <div className="report-kpi-strip" aria-label="报告关键指标">
      {slots.map(slot => (
        <div className="report-kpi-strip__cell" key={slot.label}>
          <span>{slot.label}</span>
          <strong>{slot.value}</strong>
        </div>
      ))}
    </div>
  );
}
