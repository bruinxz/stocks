import { KpiBar, type KpiSlot } from '../../shared/KpiBar';

interface USKpiSlotsProps {
  total: number;
  strongBuy: number;
  avgScore: number;
  updatedAt: string;
}

export function USKpiSlots({ total, strongBuy, avgScore, updatedAt }: USKpiSlotsProps) {
  const slots: KpiSlot[] = [
    { label: '候选数量', value: String(total), tooltip: '美股优选候选总数' },
    { label: '高评级', value: String(strongBuy), tooltip: '评级达到优秀档' },
    { label: '平均评分', value: avgScore.toFixed(1), tooltip: '平均综合评分' },
    { label: '更新时间', value: updatedAt },
  ];
  return <KpiBar slots={slots} />;
}
