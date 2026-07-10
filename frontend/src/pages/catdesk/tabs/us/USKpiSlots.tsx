import { KpiBar, type KpiSlot } from '../../shared/KpiBar';

interface USKpiSlotsProps {
  total: number;
  strongBuy: number;
  avgScore: number;
  updatedAt: string;
}

export function USKpiSlots({ total, strongBuy, avgScore, updatedAt }: USKpiSlotsProps) {
  const slots: KpiSlot[] = [
    { label: 'Candidates', value: String(total), tooltip: '美股优选候选总数' },
    { label: 'Strong Buy', value: String(strongBuy), tooltip: 'Rating ≥ A' },
    { label: 'Avg Score', value: avgScore.toFixed(1), tooltip: '平均综合评分' },
    { label: 'Updated', value: updatedAt },
  ];
  return <KpiBar slots={slots} />;
}
