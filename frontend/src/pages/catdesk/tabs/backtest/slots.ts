import type { KpiSlot } from '../../shared/KpiBar';
import type { BacktestSnapshotSlot } from './types';

export function buildBacktestKpi(latest: BacktestSnapshotSlot | null): KpiSlot[] {
  if (!latest) {
    return [
      { label: '近 6 月胜率', value: '--' },
      { label: '最大回撤', value: '--' },
      { label: '夏普比率', value: '--' },
    ];
  }

  return [
    {
      label: '近 6 月胜率',
      value: latest.win_rate_6m != null ? `${(latest.win_rate_6m * 100).toFixed(1)}%` : '--',
    },
    {
      label: '最大回撤',
      value: latest.drawdown != null ? `${(latest.drawdown * 100).toFixed(1)}%` : '--',
    },
    {
      label: '夏普比率',
      value: latest.sharpe_ratio_6m != null ? latest.sharpe_ratio_6m.toFixed(2) : '--',
    },
  ];
}
