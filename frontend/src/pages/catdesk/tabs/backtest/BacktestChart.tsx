import React, { useMemo } from 'react';
import type { BacktestSnapshotSlot, EquityDataPoint } from './types';
import { DrawdownBar } from './DrawdownBar';
import { EquityCurve } from './EquityCurve';

interface BacktestChartProps {
  snapshots: BacktestSnapshotSlot[];
}

export function BacktestChart({ snapshots }: BacktestChartProps) {
  const chartData = useMemo<EquityDataPoint[]>(
    () =>
      snapshots
        .filter(
          snapshot =>
            typeof snapshot.net_value === 'number' && typeof snapshot.drawdown === 'number'
        )
        .map(snapshot => ({
          date: snapshot.snapshot_day,
          netValue: snapshot.net_value as number,
          drawdown: snapshot.drawdown as number,
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    [snapshots]
  );

  if (!chartData.length) {
    return (
      <div className="backtest-empty-chart" role="status">
        <span className="backtest-empty-chart__eyebrow">历史时点数据</span>
        <strong>快照已就绪，净值指标尚未入库</strong>
        <span>等待 metrics.net_value 与 metrics.drawdown 后自动绘图。</span>
      </div>
    );
  }

  return (
    <section className="backtest-chart" aria-label="回测净值与回撤图表">
      <div className="backtest-chart__panel">
        <header className="backtest-chart__header">
          <div>
            <span className="backtest-chart__index">01</span>
            <h3>累计净值</h3>
          </div>
          <span>{chartData.length} 个 PIT 快照</span>
        </header>
        <div className="backtest-chart__canvas">
          <EquityCurve data={chartData} />
        </div>
      </div>
      <div className="backtest-chart__panel backtest-chart__panel--drawdown">
        <header className="backtest-chart__header">
          <div>
            <span className="backtest-chart__index">02</span>
            <h3>区间回撤</h3>
          </div>
          <span>深红标记 ≤ -10%</span>
        </header>
        <div className="backtest-chart__canvas">
          <DrawdownBar data={chartData} />
        </div>
      </div>
    </section>
  );
}
