import { KpiBar, type KpiSlot } from '../../shared/KpiBar';

interface MorningKpiSlotsProps {
  total: number;
  highConviction: number;
  avgScore: number;
  updatedAt: string;
}

export function formatMorningUpdateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '时间不可用';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

export function MorningKpiSlots({
  total,
  highConviction,
  avgScore,
  updatedAt,
}: MorningKpiSlotsProps) {
  const slots: KpiSlot[] = [
    { label: '今日推荐', value: String(total), tooltip: '当前研究快照的候选总数' },
    { label: '高确信', value: String(highConviction), tooltip: '确信度 >= 75 的标的' },
    { label: '平均分', value: avgScore.toFixed(1), tooltip: '全部标的平均综合评分' },
    { label: '更新时间', value: formatMorningUpdateTime(updatedAt), tooltip: updatedAt },
  ];

  return <KpiBar slots={slots} />;
}
